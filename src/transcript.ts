/**
 * Qoder transcript JSONL helpers. Each line is one record — session_meta / user /
 * assistant / progress — appended in chronological order. Read-only and tolerant
 * of malformed lines; never throws.
 */

import { readFileSync } from "node:fs";
import { isRecord } from "./normalize.js";

/** Parse a JSONL file into rows, skipping blank/malformed lines. */
export function readJsonl(path: string): unknown[] {
  const rows: unknown[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return rows;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

/** The session id recorded on the first `session_meta` row, if any. */
export function transcriptSessionId(rows: unknown[]): string | undefined {
  for (const row of rows) {
    if (isRecord(row) && row.type === "session_meta" && typeof row.sessionId === "string") {
      return row.sessionId;
    }
  }
  return undefined;
}

/** A tool call block from an assistant message. */
export interface TranscriptToolUse {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

/** Assistant `message.content` array for a row, or undefined if it isn't an assistant message. */
export function assistantContent(row: unknown): unknown[] | undefined {
  if (!isRecord(row) || row.type !== "assistant") return undefined;
  const message = isRecord(row.message) ? row.message : undefined;
  return Array.isArray(message?.content) ? (message.content as unknown[]) : undefined;
}

/** True when a `user` row carries a plain-string prompt (not a tool_result array). */
export function isUserPrompt(row: unknown): boolean {
  if (!isRecord(row) || row.type !== "user") return false;
  const message = isRecord(row.message) ? row.message : undefined;
  return typeof message?.content === "string";
}

/** Map of tool_use_id → tool result { content, isError } from `user` tool_result rows. */
export function toolResults(rows: unknown[]): Map<string, { content: string; isError: boolean }> {
  const map = new Map<string, { content: string; isError: boolean }>();
  for (const row of rows) {
    if (!isRecord(row) || row.type !== "user") continue;
    const message = isRecord(row.message) ? row.message : undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool_result") continue;
      const id = typeof part.tool_use_id === "string" ? part.tool_use_id : undefined;
      if (!id) continue;
      const text =
        typeof part.content === "string"
          ? part.content
          : Array.isArray(part.content)
            ? part.content
                .filter(isRecord)
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .join("")
            : "";
      map.set(id, { content: text, isError: part.is_error === true });
    }
  }
  return map;
}
