#!/usr/bin/env node
/**
 * Stop hook — finalizes the turn: posts the LangSmith trace, flushes, clears the
 * buffer. Idempotent; no buffer → no-op.
 *
 * Qoder's Stop event is blockable: this hook must NEVER exit 2 (block) and always
 * exits 0 so it can't stall the agent, even on failure.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceStop } from "../reducer.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../langsmith.js";
import { resolveTurnSteps } from "../conversation-steps.js";
import { error, debug, warn } from "../logger.js";
import type { StopInput, TurnBuffer } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`Stop session=${input.session_id} req=${input.request_set_id}`);
  initTracing(
    config.apiKey,
    config.apiUrl,
    config.replicas,
    config.redact,
    config.redactExtraRules,
  );

  let toTrace: TurnBuffer | undefined;
  let turnNum = 0;

  await atomicUpdateState(config.stateFilePath, (s) => {
    const r = reduceStop(s, input, Date.now());
    toTrace = r.buffer;
    turnNum = r.turnNum;
    return r.state;
  });

  if (!toTrace) {
    debug("No buffered turn for this request round — nothing to trace");
    return;
  }

  // Best-effort interleaved step fidelity from the transcript; undefined falls
  // back to the hook-built decide/answer shape.
  const steps = resolveTurnSteps({
    transcriptPath: input.transcript_path,
    toolUseIds: toTrace.tools.map((t) => t.tool_use_id),
  });

  // Repo/git/user attribution the payload exposes directly, layered over config.
  const payloadMetadata: Record<string, unknown> = {};
  if (input.extra?.branch) payloadMetadata.git_branch = input.extra.branch;
  if (input.extra?.repo) payloadMetadata.repository_name = input.extra.repo;

  try {
    await buildTurnRuns({
      buffer: toTrace,
      conversationId: input.session_id,
      turnNum,
      project: config.project,
      userEmail: input.extra?.email,
      customMetadata: { ...config.customMetadata, ...payloadMetadata },
      steps,
    });
  } catch (err) {
    error(`Failed to build turn runs: ${err}`);
  }

  await flushPendingTraces();
}

main().catch((err) => {
  try {
    warn(`stop hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Never block the agent — exit 0 even on failure (Qoder Stop is blockable).
  process.exit(0);
});
