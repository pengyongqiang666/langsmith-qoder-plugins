import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { TracingState, TurnBuffer, StopInput } from "../../src/types.js";
import {
  reduceSessionStart,
  reduceUserPromptSubmit,
  reducePreToolUse,
  reducePostToolUse,
  reducePostToolUseFailure,
  reduceSubagentStart,
  reduceSubagentStop,
  reduceStop,
  type ResolvedSubagent,
} from "../../src/reducer.js";
import { resolveSubagentTranscript } from "../../src/subagent-transcript.js";

export interface FinalizedTurn {
  conversationId: string;
  turnNum: number;
  buffer: TurnBuffer;
  stopInput: StopInput;
}

interface CaptureLine {
  ts: string;
  evt: string;
  payload: Record<string, unknown> & { hook_event_name: string };
}

/**
 * Replay a captured Qoder hooks.jsonl through the pure reducers, using each
 * event's timestamp as the clock. Yields finalized turns and residual state.
 */
export function replayHookLog(path: string): {
  finalized: FinalizedTurn[];
  finalState: TracingState;
} {
  let state: TracingState = {};
  const finalized: FinalizedTurn[] = [];

  for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
    let rec: CaptureLine;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload;
    const now = Date.parse(rec.ts);

    switch (p.hook_event_name) {
      case "SessionStart":
        state = reduceSessionStart(state, p as never, now);
        break;
      case "UserPromptSubmit":
        state = reduceUserPromptSubmit(state, p as never, now);
        break;
      case "PreToolUse":
        state = reducePreToolUse(state, p as never, now);
        break;
      case "PostToolUse":
        state = reducePostToolUse(state, p as never, now);
        break;
      case "PostToolUseFailure":
        state = reducePostToolUseFailure(state, p as never, now);
        break;
      case "SubagentStart":
        state = reduceSubagentStart(state, p as never, now);
        break;
      case "SubagentStop": {
        const raw = p.agent_transcript_path as string | undefined;
        // Fixture paths are relative to the hooks fixture; resolve them here.
        const transcriptPath = raw && !isAbsolute(raw) ? resolve(dirname(path), raw) : raw;
        const resolved: ResolvedSubagent | undefined = transcriptPath
          ? resolveSubagentTranscript(transcriptPath)
          : undefined;
        state = reduceSubagentStop(state, p as never, now, resolved);
        break;
      }
      case "Stop": {
        const r = reduceStop(state, p as never, now);
        state = r.state;
        if (r.buffer) {
          finalized.push({
            conversationId: p.session_id as string,
            turnNum: r.turnNum,
            buffer: r.buffer,
            stopInput: p as never,
          });
        }
        break;
      }
      default:
        break; // SessionEnd / PermissionRequest / etc. — ignored in v1
    }
  }

  return { finalized, finalState: state };
}
