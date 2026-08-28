#!/usr/bin/env node
/**
 * SessionEnd hook — best-effort housekeeping: prune stale conversation state and
 * flush any pending trace batches.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState, pruneOldConversations } from "../state.js";
import { error, debug } from "../logger.js";
import type { SessionEndInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SessionEndInput>();
  const config = initHook(input.cwd);
  if (!config) return;

  debug(`SessionEnd session=${input.session_id} reason=${input.reason}`);
  await atomicUpdateState(config.stateFilePath, (state) => pruneOldConversations(state));
}

main().catch((err) => {
  try {
    error(`SessionEnd hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(1);
});
