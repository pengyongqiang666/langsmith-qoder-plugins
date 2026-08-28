import { describe, it, expect } from "vitest";
import {
  deriveModelInfo,
  stripModelSuffixes,
  preferModel,
  buildUsageMetadata,
  parseToolOutput,
  extractMcpError,
  normalizeContentPart,
  canonicalModelId,
} from "../src/normalize.js";

describe("deriveModelInfo / provider mapping", () => {
  it("maps model labels to ls_provider and a canonical model id", () => {
    expect(deriveModelInfo("claude-4.6-sonnet-medium-thinking")).toEqual({
      ls_model_name: "claude-sonnet-4-6", // normalized to canonical id
      ls_provider: "anthropic",
    });
    expect(deriveModelInfo("gpt-5.5-medium")).toEqual({
      ls_model_name: "gpt-5.5",
      ls_provider: "openai",
    });
    expect(deriveModelInfo("gemini-2.5-pro")).toMatchObject({ ls_provider: "google" });
    expect(deriveModelInfo("grok-4.5")).toEqual({ ls_model_name: "grok-4.5", ls_provider: "xai" });
  });

  it("treats Auto / 'default' as the qoder provider (unpriced)", () => {
    expect(deriveModelInfo("default")).toEqual({ ls_model_name: "default", ls_provider: "qoder" });
    expect(deriveModelInfo(undefined)).toEqual({ ls_model_name: "default", ls_provider: "qoder" });
    expect(deriveModelInfo("Auto")).toMatchObject({ ls_provider: "qoder" });
  });

  it("maps Qoder's qmodel_* labels to the qoder provider, keeping the model id", () => {
    expect(deriveModelInfo("qmodel_38max")).toEqual({
      ls_model_name: "qmodel_38max",
      ls_provider: "qoder",
    });
  });

  it("leaves provider undefined for unknown vendors", () => {
    expect(deriveModelInfo("llama-3.1-70b").ls_provider).toBeUndefined();
  });
});

describe("stripModelSuffixes", () => {
  it("strips trailing reasoning-effort / thinking suffixes only", () => {
    expect(stripModelSuffixes("gpt-5.5-medium")).toBe("gpt-5.5");
    expect(stripModelSuffixes("claude-4.6-sonnet-medium-thinking")).toBe("claude-4.6-sonnet");
    expect(stripModelSuffixes("gpt-5.5")).toBe("gpt-5.5");
    expect(stripModelSuffixes("gpt-5.6-xhigh")).toBe("gpt-5.6");
  });
});

describe("preferModel", () => {
  it("prefers a concrete label over default / Auto", () => {
    expect(preferModel("default", "gpt-5.5")).toBe("gpt-5.5");
    expect(preferModel("gpt-5.5", "default")).toBe("gpt-5.5");
    expect(preferModel(undefined, "default")).toBe("default");
    expect(preferModel("claude-4.5-sonnet", "Auto")).toBe("claude-4.5-sonnet");
  });
});

describe("buildUsageMetadata", () => {
  it("folds cache tokens into input_tokens and exposes details", () => {
    expect(
      buildUsageMetadata({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 960,
        cache_write_tokens: 5,
      }),
    ).toEqual({
      input_tokens: 1065,
      output_tokens: 20,
      total_tokens: 1085,
      input_token_details: { cache_read: 960, cache_creation: 5 },
    });
  });

  it("returns undefined when there are no tokens", () => {
    expect(buildUsageMetadata(undefined)).toBeUndefined();
    expect(buildUsageMetadata({})).toBeUndefined();
    expect(buildUsageMetadata({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });
});

describe("canonicalModelId", () => {
  it("reorders version-first Claude labels to LangSmith's tier-first ids", () => {
    expect(canonicalModelId("claude-4.6-sonnet")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("claude-4.8-opus")).toBe("claude-opus-4-8");
    expect(canonicalModelId("claude-3.7-sonnet")).toBe("claude-3-7-sonnet");
  });

  it("passes through ids that already match (GPT, unknowns)", () => {
    expect(canonicalModelId("gpt-5.5")).toBe("gpt-5.5");
    expect(canonicalModelId("mystery")).toBe("mystery");
  });
});

describe("parseToolOutput", () => {
  it("parses a JSON-encoded tool response string", () => {
    expect(parseToolOutput('{"output":"hello"}')).toEqual({ output: "hello" });
  });
  it("returns the raw value for non-JSON strings and non-strings", () => {
    expect(parseToolOutput("plain text")).toBe("plain text");
    expect(parseToolOutput(42)).toBe(42);
    expect(parseToolOutput("")).toBe("");
  });
});

describe("normalizeContentPart", () => {
  it("converts a custom binary part to LangChain v1", () => {
    expect(normalizeContentPart({ type: "image", mimeType: "image/png", data: "AAAA" })).toEqual({
      type: "image",
      mime_type: "image/png",
      base64: "AAAA",
    });
  });
  it("passes through non-multimodal parts", () => {
    expect(normalizeContentPart({ type: "text", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
    });
  });
});

describe("extractMcpError", () => {
  const softError = {
    content: [{ type: "text", text: "SOFT ERROR: this MCP tool deliberately failed." }],
    isError: true,
  };

  it("flags an mcp__ tool whose output has isError:true, using the content text", () => {
    expect(extractMcpError("mcp__server__soft_error", softError)).toBe(
      "SOFT ERROR: this MCP tool deliberately failed.",
    );
  });

  it("falls back to a generic message when isError:true but no text content", () => {
    expect(extractMcpError("mcp__server__foo", { isError: true })).toBe(
      "MCP tool returned isError: true",
    );
  });

  it("ignores successful MCP calls (isError:false or absent)", () => {
    expect(
      extractMcpError("mcp__server__foo", {
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    ).toBeUndefined();
    expect(extractMcpError("mcp__server__foo", { content: [] })).toBeUndefined();
  });

  it("ignores non-MCP tools even when output looks like an error", () => {
    expect(extractMcpError("Read", softError)).toBeUndefined();
  });

  it("handles non-record output safely", () => {
    expect(extractMcpError("mcp__server__foo", "some string")).toBeUndefined();
    expect(extractMcpError("mcp__server__foo", undefined)).toBeUndefined();
  });
});
