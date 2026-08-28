/**
 * Converters: Qoder hook payloads → LangSmith run shapes (model/provider,
 * usage_metadata, parsed tool output, multimodal parts).
 */

import type { UsageFields } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Model / provider ───────────────────────────────────────────────────────

/** Reasoning-effort / thinking suffixes some model labels append. */
const MODEL_SUFFIXES = new Set(["thinking", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Explicit model-label → canonical-id overrides for cases the regex can't derive. */
export const CANONICAL_MODEL_MAP: Record<string, string> = {};

/** Lowercase + strip a leading provider prefix some labels carry (e.g. "anthropic/"). */
function normKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+\//, "");
}

/** Canonicalize a model label to LangSmith's price-table id (Claude reordered by version). */
export function canonicalModelId(model: string): string {
  const key = normKey(model);
  if (CANONICAL_MODEL_MAP[key]) return CANONICAL_MODEL_MAP[key];
  const m = key.match(/^claude-(\d+)\.(\d+)-(sonnet|opus|haiku)$/);
  if (m) {
    const [, major, minor, tier] = m;
    return Number(major) >= 4
      ? `claude-${tier}-${major}-${minor}` // v4+: tier-first
      : `claude-${major}-${minor}-${tier}`; // v3: version-first
  }
  return model;
}

/** Map a model-label prefix to a LangSmith ls_provider. */
function providerFor(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m === "default" || m === "auto" || m.startsWith("qoder") || m.startsWith("qmodel")) {
    return "qoder";
  }
  if (m.startsWith("claude")) return "anthropic";
  if (/^(gpt|o\d)/.test(m)) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  return undefined;
}

/** Strip trailing reasoning-effort/thinking suffixes from a model label. */
export function stripModelSuffixes(model: string): string {
  const parts = model.split("-");
  while (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (!MODEL_SUFFIXES.has(last)) break;
    if (last === "max" && !providerFor(parts.slice(0, -1).join("-"))) break;
    parts.pop();
  }
  return parts.join("-");
}

export interface ModelInfo {
  ls_model_name: string;
  ls_provider?: string;
}

/** Prefer a concrete model label over "default" / "Auto". */
export function preferModel(
  current: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming && incoming.toLowerCase() !== "default" && incoming.toLowerCase() !== "auto") {
    return incoming;
  }
  return current ?? incoming;
}

/** Derive { ls_model_name, ls_provider } from a model label (suffix-stripped, canonical). */
export function deriveModelInfo(model: string | undefined): ModelInfo {
  const raw = (model ?? "").trim() || "default";
  const stripped = stripModelSuffixes(raw);
  const deprefixed = stripped.replace(/^qoder-/i, "");
  const upstream = providerFor(deprefixed);
  const label = upstream && upstream !== "qoder" ? deprefixed : stripped;
  return {
    ls_model_name: canonicalModelId(label),
    ls_provider: providerFor(label) ?? providerFor(raw),
  };
}

// ─── Usage + cost ────────────────────────────────────────────────────────────

/** Build usage_metadata from token fields, folding cache into input_tokens; no cost (priced server-side). */
export function buildUsageMetadata(usage: UsageFields | undefined) {
  if (!usage) return undefined;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const input_tokens = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
  const output_tokens = usage.output_tokens ?? 0;
  const total_tokens = input_tokens + output_tokens;

  if (total_tokens === 0) return undefined;

  return {
    input_tokens,
    output_tokens,
    total_tokens,
    input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite },
  };
}

// ─── Tool output ─────────────────────────────────────────────────────────────

/** Qoder tool output arrives as a string; parse it as JSON when possible, else return raw. */
export function parseToolOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/** Qoder MCP tools arrive namespaced as "mcp__<server>__<tool>". */
export const MCP_TOOL_PREFIX = "mcp__";

/** Join the text parts of an MCP tool result's `content` array, if any. */
function mcpContentToText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : undefined))
    .filter((text): text is string => text != null && text !== "");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Some MCP tool failures surface through PostToolUse with the error embedded in
 * the (parsed) output rather than through PostToolUseFailure. Detect the clean
 * case: an "mcp__"-prefixed tool whose output has `isError === true`, and return
 * a human-readable error string so the run can be flagged as an error.
 */
export function extractMcpError(toolName: string, output: unknown): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  if (!isRecord(output) || output.isError !== true) return undefined;
  return mcpContentToText(output.content) ?? "MCP tool returned isError: true";
}

// ─── Multimodal content (forward-compat) ─────────────────────────────────────

const MULTIMODAL_PART_TYPES = new Set(["image", "file"]);

/** Convert a binary part ({type,mimeType,data}) to LangChain v1; others pass through. */
export function normalizeContentPart(part: unknown): unknown {
  if (!isRecord(part)) return part;
  if (typeof part.type !== "string" || !MULTIMODAL_PART_TYPES.has(part.type)) return part;
  if (typeof part.mimeType !== "string" || typeof part.data !== "string") return part;
  const { mimeType, data, ...rest } = part;
  return { ...rest, mime_type: mimeType, base64: data };
}

export function normalizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(normalizeContentPart);
}
