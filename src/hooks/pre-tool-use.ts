#!/usr/bin/env node
/**
 * PreToolUse hook — records when a tool call starts, so its LangSmith run gets a
 * real duration. Without it, PostToolUse is the only signal and every tool run
 * collapses to a zero-length span with its execution time absorbed by the
 * surrounding llm run.
 *
 * Qoder's PreToolUse event is blockable: this hook must NEVER exit 2 (block) and
 * writes nothing to stdout, so it can't deny or rewrite a tool call.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reducePreToolUse } from "../reducer.js";
import { warn, debug } from "../logger.js";
import type { PreToolUseInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<PreToolUseInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`PreToolUse ${input.tool_name} session=${input.session_id}`);
  await atomicUpdateState(config.stateFilePath, (s) => reducePreToolUse(s, input, Date.now()));
}

main().catch((err) => {
  try {
    warn(`PreToolUse hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Exit 0, not 1: this runs before every tool call, and a non-zero exit would
  // surface a hook error to the user each time. Losing a start time only costs
  // that tool's duration.
  process.exit(0);
});
