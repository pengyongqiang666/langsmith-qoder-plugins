/**
 * Recover a subagent's tool calls and final answer from its transcript JSONL
 * (Qoder's `agent_transcript_path`). Best-effort; never throws.
 */

import { isRecord } from "./normalize.js";
import type { ResolvedSubagent, ResolvedSubagentTool } from "./reducer.js";
import { readJsonl, transcriptSessionId, assistantContent, toolResults } from "./transcript.js";
import * as logger from "./logger.js";

/** UI-only pseudo-tools with no I/O worth tracing. */
const PSEUDO_TOOLS = new Set(["UpdateCurrentStep", "TodoWrite", "todo_write"]);

/**
 * Parse a subagent transcript into ordered tool calls (input + output + error)
 * and its final assistant text. Returns undefined when nothing is recoverable.
 */
export function resolveSubagentTranscript(
  transcriptPath: string | null | undefined,
  readRows: (path: string) => unknown[] = readJsonl,
): ResolvedSubagent | undefined {
  if (!transcriptPath) return undefined;
  let rows: unknown[];
  try {
    rows = readRows(transcriptPath);
  } catch (err) {
    logger.debug(`subagent-transcript: read failed: ${err}`);
    return undefined;
  }
  if (rows.length === 0) return undefined;

  const results = toolResults(rows);
  const tools: ResolvedSubagentTool[] = [];
  let resultText: string | undefined;

  for (const row of rows) {
    const content = assistantContent(row);
    if (!content) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "tool_use" && typeof part.name === "string") {
        if (PSEUDO_TOOLS.has(part.name)) continue;
        const id = typeof part.id === "string" ? part.id : undefined;
        const result = id ? results.get(id) : undefined;
        tools.push({
          name: part.name,
          input: isRecord(part.input) ? part.input : {},
          output: result && !result.isError ? result.content : undefined,
          error: result?.isError ? result.content : undefined,
        });
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultText = part.text; // keep the last non-empty assistant text
      }
    }
  }

  if (tools.length === 0 && !resultText) return undefined;

  return {
    childConversationId: transcriptSessionId(rows),
    tools: tools.length > 0 ? tools : undefined,
    resultText,
  };
}
