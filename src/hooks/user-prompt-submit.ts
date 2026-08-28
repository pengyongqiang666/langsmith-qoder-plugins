#!/usr/bin/env node
/**
 * UserPromptSubmit hook — opens a new turn buffer for this request round.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceUserPromptSubmit } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { UserPromptSubmitInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<UserPromptSubmitInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`UserPromptSubmit session=${input.session_id} req=${input.request_set_id}`);
  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceUserPromptSubmit(s, input, Date.now()),
  );
}

main().catch((err) => {
  try {
    error(`UserPromptSubmit hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Qoder the hook failed.
  process.exit(1);
});
