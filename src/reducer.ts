/**
 * Pure state reducers — one per hook event, mapping (state, input, timestamp) to
 * next state. No I/O, so fully unit-testable.
 */

import type {
  TracingState,
  ConversationState,
  TurnBuffer,
  ToolEvent,
  PendingToolStart,
  SubagentEvent,
  UserPromptSubmitInput,
  PreToolUseInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  SubagentStartInput,
  SubagentStopInput,
  StopInput,
  SessionStartInput,
} from "./types.js";
import { getConversationState, newTurnBuffer, pruneOldConversations } from "./state.js";
import { extractMcpError, parseToolOutput, preferModel } from "./normalize.js";

/** Turn key when the payload has no request_set_id — one active turn per session. */
const ACTIVE_TURN = "__active__";

/** A pending PreToolUse start older than this is assumed orphaned (tool blocked/aborted). */
const PENDING_TOOL_MAX_AGE_MS = 10 * 60 * 1000;
/** Cap on unpaired PreToolUse starts, so a pathological session can't grow the state file. */
const PENDING_TOOL_MAX = 64;

function turnKey(input: { request_set_id?: string }): string {
  return input.request_set_id && input.request_set_id.length > 0
    ? input.request_set_id
    : ACTIVE_TURN;
}

function touch(conv: { updated: string }): void {
  conv.updated = new Date().toISOString();
}

/** Pick the in-progress turn with the largest startMs (the active turn). */
function latestTurnId(turns: Record<string, TurnBuffer>): string | undefined {
  let best: string | undefined;
  let bestMs = -1;
  for (const [id, t] of Object.entries(turns)) {
    if (t.startMs > bestMs) {
      bestMs = t.startMs;
      best = id;
    }
  }
  return best;
}

/** Resolve the turn buffer for a tool event, falling back to the active/latest turn. */
function resolveTurn(conv: ConversationState, key: string, nowMs: number): TurnBuffer {
  const existing = conv.turns[key] ?? (key === ACTIVE_TURN ? undefined : conv.turns[ACTIVE_TURN]);
  if (existing) return existing;
  const latest = latestTurnId(conv.turns);
  return latest ? conv.turns[latest] : newTurnBuffer(key, nowMs);
}

/** Order-independent FNV-1a hash of a tool input, so pairing survives key reordering. */
function inputHash(input: Record<string, unknown> | undefined): string {
  const entries = Object.entries(input ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let serialized: string;
  try {
    serialized = JSON.stringify(entries);
  } catch {
    // Circular or otherwise unserializable input — fall back to the key set.
    serialized = entries.map(([k]) => k).join(",");
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Drop pending starts that never got a Post* event (blocked/aborted tools). */
function prunePendingTools(pending: PendingToolStart[], nowMs: number): PendingToolStart[] {
  const cutoff = nowMs - PENDING_TOOL_MAX_AGE_MS;
  const fresh = pending.filter((p) => p.startMs >= cutoff);
  return fresh.length > PENDING_TOOL_MAX ? fresh.slice(fresh.length - PENDING_TOOL_MAX) : fresh;
}

/**
 * Claim the PreToolUse start time for a completed tool call, removing it from the
 * pending list. Matching narrows from exact to loose: tool_use_id → name + input
 * → name (earliest first, so parallel calls pair up FIFO).
 */
function takePendingStart(
  conv: ConversationState,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  toolUseId: string | undefined,
): number | undefined {
  const pending = conv.pending_tools;
  if (!pending || pending.length === 0) return undefined;

  const hash = inputHash(toolInput);
  let index = toolUseId
    ? pending.findIndex((p) => p.tool_use_id != null && p.tool_use_id === toolUseId)
    : -1;
  if (index < 0) index = pending.findIndex((p) => p.name === toolName && p.inputHash === hash);
  if (index < 0) index = pending.findIndex((p) => p.name === toolName);
  if (index < 0) return undefined;

  const [claimed] = pending.splice(index, 1);
  return claimed.startMs;
}

export function reducePreToolUse(
  state: TracingState,
  input: PreToolUseInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.session_id);
  const pending = conv.pending_tools ?? [];
  pending.push({
    name: input.tool_name,
    inputHash: inputHash(input.tool_input),
    tool_use_id: input.tool_use_id,
    startMs: nowMs,
  });
  conv.pending_tools = prunePendingTools(pending, nowMs);
  touch(conv);
  return { ...state, [input.session_id]: conv };
}

export function reduceSessionStart(
  state: TracingState,
  input: SessionStartInput,
  _nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.session_id);
  if (input.model) conv.model = input.model;
  touch(conv);
  return { ...state, [input.session_id]: conv };
}

export function reduceUserPromptSubmit(
  state: TracingState,
  input: UserPromptSubmitInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.session_id);
  const key = turnKey(input);
  const turn = newTurnBuffer(key, nowMs);
  turn.prompt = input.prompt;
  turn.model = conv.model;
  conv.turns[key] = turn;
  touch(conv);
  return pruneOldConversations({ ...state, [input.session_id]: conv });
}

export function reducePostToolUse(
  state: TracingState,
  input: PostToolUseInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.session_id);
  const turn = resolveTurn(conv, turnKey(input), nowMs);
  const output = parseToolOutput(input.tool_response);
  const startMs = takePendingStart(conv, input.tool_name, input.tool_input, input.tool_use_id);
  turn.tools.push({
    tool_use_id: input.tool_use_id ?? `${input.tool_name}-${turn.tools.length}`,
    name: input.tool_name,
    input: input.tool_input ?? {},
    output,
    // Some MCP failures arrive here with isError in the output; flag as an error.
    error: extractMcpError(input.tool_name, output),
    startMs,
    endMs: nowMs,
  });
  conv.turns[turn.generation_id] = turn;
  touch(conv);
  return { ...state, [input.session_id]: conv };
}

export function reducePostToolUseFailure(
  state: TracingState,
  input: PostToolUseFailureInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.session_id);
  const turn = resolveTurn(conv, turnKey(input), nowMs);
  const startMs = takePendingStart(conv, input.tool_name, input.tool_input, input.tool_use_id);
  turn.tools.push({
    tool_use_id: input.tool_use_id ?? `${input.tool_name}-${turn.tools.length}`,
    name: input.tool_name,
    input: input.tool_input ?? {},
    error: input.error ?? (input.is_interrupt ? "interrupted" : "tool failed"),
    startMs,
    endMs: nowMs,
  });
  conv.turns[turn.generation_id] = turn;
  touch(conv);
  return { ...state, [input.session_id]: conv };
}

export function reduceSubagentStart(
  state: TracingState,
  input: SubagentStartInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.session_id);
  const turnId = latestTurnId(conv.turns);
  const turn = turnId ? conv.turns[turnId] : newTurnBuffer(turnKey(input), nowMs);
  turn.subagents.push({
    subagent_id: input.agent_id,
    subagent_type: input.agent_type,
    task: "",
    startMs: nowMs,
  });
  conv.turns[turn.generation_id] = turn;
  touch(conv);
  return { ...state, [input.session_id]: conv };
}

/** One tool call recovered from a subagent transcript (order = array position). */
export interface ResolvedSubagentTool {
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

/** Data recovered from the subagent's transcript (resolved in the hook). */
export interface ResolvedSubagent {
  /** The subagent's own session id (= transcript filename). */
  childConversationId?: string;
  /** Ordered tool calls from the transcript; timing is synthesized in the reducer. */
  tools?: ResolvedSubagentTool[];
  resultText?: string;
}

/** Spread transcript tool calls across the subagent's [startMs, endMs] window. */
function timeSubagentTools(
  calls: ResolvedSubagentTool[],
  startMs: number,
  endMs: number,
): ToolEvent[] {
  const span = Math.max(0, endMs - startMs);
  const slice = calls.length > 0 ? span / calls.length : 0;
  return calls.map((c, i) => ({
    tool_use_id: `subagent-tool-${i}`,
    name: c.name,
    input: c.input,
    output: c.output,
    error: c.error,
    duration: slice / 1000,
    endMs: Math.round(startMs + slice * (i + 1)),
  }));
}

export function reduceSubagentStop(
  state: TracingState,
  input: SubagentStopInput,
  nowMs: number,
  resolved?: ResolvedSubagent,
): TracingState {
  const conv = getConversationState(state, input.session_id);

  let target: SubagentEvent | undefined;
  for (const turn of Object.values(conv.turns)) {
    const sub = turn.subagents.find((s) => s.subagent_id === input.agent_id && s.endMs == null);
    if (sub) {
      target = sub;
      break;
    }
  }

  if (!target) {
    touch(conv);
    return { ...state, [input.session_id]: conv };
  }

  target.status = target.status ?? "completed";
  target.endMs = nowMs;
  target.resultText = resolved?.resultText ?? input.last_assistant_message;
  if (resolved?.childConversationId) target.childConversationId = resolved.childConversationId;
  if (resolved?.tools?.length) {
    target.tools = timeSubagentTools(resolved.tools, target.startMs, nowMs);
    target.tool_call_count = resolved.tools.length;
  }

  touch(conv);
  return { ...state, [input.session_id]: conv };
}

export interface StopResult {
  state: TracingState;
  /** The finalized turn to trace, or undefined if there was no buffered turn. */
  buffer?: TurnBuffer;
  turnNum: number;
}

export function reduceStop(state: TracingState, input: StopInput, nowMs: number): StopResult {
  const conv = getConversationState(state, input.session_id);
  const key = turnKey(input);
  const turn = conv.turns[key] ?? conv.turns[ACTIVE_TURN];
  if (!turn) {
    return { state, turnNum: 0 };
  }

  turn.finalText = input.last_assistant_message ?? turn.finalText;
  turn.model = preferModel(turn.model, conv.model);

  const turnNum = conv.turn_count + 1;
  delete conv.turns[turn.generation_id];
  conv.turn_count += 1;
  touch(conv);

  const nextState = pruneOldConversations({ ...state, [input.session_id]: conv }, nowMs);
  return { state: nextState, buffer: turn, turnNum };
}
