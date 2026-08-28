#!/usr/bin/env node
/**
 * SubagentStop hook — finalizes a buffered subagent with its transcript-recovered
 * tools and final answer.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceSubagentStop } from "../reducer.js";
import { resolveSubagentTranscript } from "../subagent-transcript.js";
import { error, debug } from "../logger.js";
import type { SubagentStopInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SubagentStopInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`SubagentStop ${input.agent_type} (${input.agent_id})`);

  // Best-effort: recover the subagent's tool calls and final answer from its
  // transcript; the reducer falls back to last_assistant_message.
  const resolved = resolveSubagentTranscript(input.agent_transcript_path);
  if (resolved) {
    debug(
      `resolved subagent transcript: child=${resolved.childConversationId}, ${resolved.tools?.length ?? 0} tool call(s)`,
    );
  }

  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceSubagentStop(s, input, Date.now(), resolved),
  );
}

main().catch((err) => {
  try {
    error(`SubagentStop hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Qoder the hook failed.
  process.exit(1);
});
