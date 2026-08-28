#!/usr/bin/env node
/**
 * PostToolUse hook — appends a completed tool call to the current turn buffer.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reducePostToolUse } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { PostToolUseInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`PostToolUse ${input.tool_name} session=${input.session_id}`);
  await atomicUpdateState(config.stateFilePath, (s) => reducePostToolUse(s, input, Date.now()));
}

main().catch((err) => {
  try {
    error(`PostToolUse hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Qoder the hook failed.
  process.exit(1);
});
