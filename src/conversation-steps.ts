/**
 * Reconstruct a turn's interleaved step sequence from the Qoder transcript JSONL.
 * Best-effort, never throws. Shallow decode (order + assistant text + tool_use_id);
 * tool I/O joins from the hook buffer in the run builder.
 */

import { isRecord } from "./normalize.js";
import { readJsonl, assistantContent, isUserPrompt } from "./transcript.js";
import * as logger from "./logger.js";

// ─── Step decoding ────────────────────────────────────────────────────────────

export type Step =
  | { kind: "assistant"; text?: string }
  | { kind: "thinking"; text?: string; durationMs?: number }
  | { kind: "tool"; toolUseId?: string; toolField?: number; toolName?: string };

// ─── Round grouping (pure, testable) ──────────────────────────────────────────

export interface Round {
  thinking: Array<{ text?: string; durationMs?: number }>;
  assistantText?: string;
  /** Tool steps emitted in this round, in order. */
  toolSteps: Array<{ toolUseId?: string; toolField?: number; toolName?: string }>;
}

/** Group steps into rounds (a text step after a tool starts a new round). */
export function groupSteps(steps: Step[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | undefined;
  const newRound = (): Round => {
    const r: Round = { thinking: [], toolSteps: [] };
    rounds.push(r);
    return r;
  };
  for (const step of steps) {
    if (step.kind === "tool") {
      if (!current) current = newRound();
      current.toolSteps.push({
        toolUseId: step.toolUseId,
        toolField: step.toolField,
        toolName: step.toolName,
      });
      continue;
    }
    // thinking / assistant — start a new round if the current one already emitted tools.
    if (!current || current.toolSteps.length > 0) current = newRound();
    if (step.kind === "thinking") {
      current.thinking.push({ text: step.text, durationMs: step.durationMs });
    } else {
      current.assistantText = current.assistantText
        ? `${current.assistantText}\n${step.text ?? ""}`
        : step.text;
    }
  }
  return rounds;
}

// ─── Transcript → steps ───────────────────────────────────────────────────────

/**
 * Ordered Steps for the current (latest) turn: assistant text + tool_use blocks
 * that appear after the last user prompt in the transcript.
 */
export function stepsFromTranscript(rows: unknown[]): Step[] {
  // Window: everything after the last plain-string user prompt.
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isUserPrompt(rows[i])) {
      start = i + 1;
      break;
    }
  }

  const steps: Step[] = [];
  for (let i = start; i < rows.length; i++) {
    const content = assistantContent(rows[i]);
    if (!content) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        steps.push({ kind: "assistant", text: part.text });
      } else if (part.type === "tool_use" && typeof part.name === "string") {
        steps.push({
          kind: "tool",
          toolUseId: typeof part.id === "string" ? part.id : undefined,
          toolName: part.name,
        });
      }
    }
  }
  return steps;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

export interface ResolveTurnStepsOptions {
  transcriptPath?: string | null;
  /** Hook-captured tool_use_ids for the current turn — used to confirm the window matches. */
  toolUseIds: string[];
  /** Injectable row reader (tests). Defaults to reading the transcript JSONL. */
  readRows?: (path: string) => unknown[];
}

/** Resolve the current turn's steps from the transcript. Undefined → caller falls back. */
export function resolveTurnSteps(opts: ResolveTurnStepsOptions): Step[] | undefined {
  const path = opts.transcriptPath;
  if (!path) return undefined;
  try {
    const rows = (opts.readRows ?? readJsonl)(path);
    if (rows.length === 0) return undefined;
    const steps = stepsFromTranscript(rows);
    if (steps.length === 0) return undefined;
    logger.debug(`conversation-steps: recovered ${steps.length} step(s) from ${path}`);
    return steps;
  } catch (err) {
    logger.debug(`conversation-steps: transcript parse failed: ${err}`);
    return undefined;
  }
}
