/**
 * Types for Qoder hook inputs (stdin JSON) and the on-disk event-buffer state.
 * Field names mirror the documented Qoder hook payloads.
 */

// ─── Multimodal content ──────────────────────────────────────────────────────

/**
 * A LangChain v1 multimodal content part. `mime_type` is required with `base64`
 * — the shape the LangSmith UI renders inline.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; base64: string }
  | { type: "file"; mime_type: string; base64: string; filename?: string };

// ─── Hook Input Types ───────────────────────────────────────────────────────

/** Extra context Qoder attaches to hook payloads (all optional). */
export interface QoderExtra {
  /** User's Git email. */
  email?: string;
  /** Repository path in `group/repo` format. */
  repo?: string;
  /** Current Git branch. */
  branch?: string;
  /** Request time (RFC3339). */
  request_time?: string;
  /** Response time (RFC3339). */
  response_time?: string;
  /** Full diff of the change (edit tools' PostToolUse only). */
  full_diff_text?: string;
}

/** Fields present on every Qoder hook payload. */
export interface HookInputBase {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  /** Path to the session's transcript JSONL file. */
  transcript_path?: string | null;
  /** ID of the current IDE request round; used as the turn key when present. */
  request_set_id?: string;
  extra?: QoderExtra;
}

/**
 * Token usage — Qoder hooks do NOT expose token counts, so this is always empty
 * in practice. Kept for forward-compatibility with the run builder.
 */
export interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: "SessionStart";
  /** Session start type; the IDE currently passes "startup". */
  type?: string;
  /** The session's model setting, e.g. "Auto". */
  model?: string;
}

export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface PreToolUseInput extends HookInputBase {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Not documented on PreToolUse; used for exact pairing when the IDE sends it. */
  tool_use_id?: string;
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Delivered as a string by the IDE. */
  tool_response?: string;
  /** Not always present on PostToolUse; synthesized when absent. */
  tool_use_id?: string;
}

export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  /** Error message from the failed tool execution. */
  error?: string;
  is_interrupt?: boolean;
}

export interface SubagentStartInput extends HookInputBase {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
}

export interface SubagentStopInput extends HookInputBase {
  hook_event_name: "SubagentStop";
  agent_id: string;
  agent_type: string;
  stop_hook_active?: boolean;
  /** Path to the sub-agent's transcript JSONL file. */
  agent_transcript_path?: string | null;
  /** The sub-agent's last text response. */
  last_assistant_message?: string;
}

export interface StopInput extends HookInputBase {
  hook_event_name: "Stop";
  /** True when the Agent is retrying after a previous Stop hook block. */
  stop_hook_active?: boolean;
  /** The Agent's last text response. */
  last_assistant_message?: string;
}

export interface SessionEndInput extends HookInputBase {
  hook_event_name: "SessionEnd";
  reason?: string;
}

// ─── Event-buffer state (on-disk) ────────────────────────────────────────────

/** A single tool invocation, buffered between PostToolUse and Stop. */
export interface ToolEvent {
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
  /** Parsed tool response (PostToolUse), if any. */
  output?: unknown;
  /** error message (PostToolUseFailure), if the tool failed. */
  error?: string;
  failure_type?: string;
  duration?: number;
  /** Wall-clock ms when PreToolUse fired (tool start), when it was paired. */
  startMs?: number;
  /** Wall-clock ms when the hook fired (tool end). */
  endMs: number;
}

/**
 * A PreToolUse timestamp waiting for its PostToolUse counterpart, so the tool run
 * gets a real duration instead of collapsing to a zero-length span.
 */
export interface PendingToolStart {
  name: string;
  /** Stable hash of `tool_input`, to pair parallel calls of the same tool. */
  inputHash: string;
  /** tool_use_id, when PreToolUse carried one. */
  tool_use_id?: string;
  /** Wall-clock ms when PreToolUse fired. */
  startMs: number;
}

/** A subagent invocation, rendered as a nested chain run with tool children. */
export interface SubagentEvent {
  subagent_id: string;
  subagent_type: string;
  task: string;
  /** Short human-readable label for the task. */
  description?: string;
  /** Model label the subagent ran on, when known. */
  model?: string;
  /** True when this subagent is one of several parallel workers. */
  is_parallel_worker?: boolean;
  status?: string;
  duration_ms?: number;
  /** Reported counts at SubagentStop, surfaced as-is when present. */
  message_count?: number;
  tool_call_count?: number;
  loop_count?: number;
  /** Wall-clock ms when SubagentStart fired. */
  startMs: number;
  /** Wall-clock ms when SubagentStop fired. */
  endMs?: number;
  /** The subagent's own session id (== its transcript filename), when recovered. */
  childConversationId?: string;
  /** The subagent's internal tool calls, nested under the subagent run. */
  tools?: ToolEvent[];
  /** The subagent's final answer text (from its transcript / last_assistant_message). */
  resultText?: string;
  /** The subagent's own system prompt (not available from Qoder — reserved). */
  systemPrompt?: string;
}

/** An assistant thinking block. */
export interface ThoughtEvent {
  text: string;
  duration_ms?: number;
}

/** Buffered events for one in-progress turn (keyed by request_set_id). */
export interface TurnBuffer {
  generation_id: string;
  prompt?: string;
  /** Best model label seen for this turn (from SessionStart / session state). */
  model?: string;
  /** Wall-clock ms when the turn started (UserPromptSubmit). */
  startMs: number;
  tools: ToolEvent[];
  thoughts: ThoughtEvent[];
  subagents: SubagentEvent[];
  /** Final assistant text (Stop.last_assistant_message). */
  finalText?: string;
  /** Per-turn token usage — Qoder exposes none, so always empty. */
  usage?: UsageFields;
  /** Turn status from Stop. */
  status?: string;
}

/** State for one conversation (thread). */
export interface ConversationState {
  /** In-progress turn buffers keyed by request_set_id (turn key). */
  turns: Record<string, TurnBuffer>;
  /** Number of turns already finalized (for "Qoder Turn N" naming). */
  turn_count: number;
  /** Session model label from SessionStart, applied to turns that lack their own. */
  model?: string;
  /** PreToolUse start times not yet claimed by a PostToolUse / PostToolUseFailure. */
  pending_tools?: PendingToolStart[];
  /** ISO timestamp of last update (for pruning). */
  updated: string;
}

export interface TracingState {
  [conversationId: string]: ConversationState;
}
