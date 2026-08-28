#!/usr/bin/env node
/**
 * SessionStart hook — records the session's model and prunes stale state.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceSessionStart } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { SessionStartInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`SessionStart session=${input.session_id} model=${input.model}`);
  await atomicUpdateState(config.stateFilePath, (s) => reduceSessionStart(s, input, Date.now()));
}

main().catch((err) => {
  try {
    error(`SessionStart hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Qoder the hook failed.
  process.exit(1);
});
