import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  stepsFromTranscript,
  groupSteps,
  resolveTurnSteps,
  type Step,
} from "../src/conversation-steps.js";
import { readJsonl } from "../src/transcript.js";

const SUBAGENT_TRANSCRIPT = join(process.cwd(), "test/fixtures/qoder-subagent-1.jsonl");

describe("stepsFromTranscript", () => {
  it("windows to the last user prompt and keeps assistant text + tool_use order", () => {
    const rows = [
      { type: "user", message: { role: "user", content: "old prompt" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old" }] },
      },
      { type: "user", message: { role: "user", content: "current prompt" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a" } }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ];
    const steps = stepsFromTranscript(rows);
    expect(steps).toEqual<Step[]>([
      { kind: "assistant", text: "thinking out loud" },
      { kind: "tool", toolUseId: "call_1", toolName: "Read" },
      { kind: "assistant", text: "done" },
    ]);
  });

  it("returns steps for a transcript with no user prompt (whole file)", () => {
    const rows = readJsonl(SUBAGENT_TRANSCRIPT);
    const steps = stepsFromTranscript(rows);
    const toolNames = steps
      .filter((s) => s.kind === "tool")
      .map((s) => (s as { toolName?: string }).toolName);
    expect(toolNames).toEqual(["Read", "Grep"]);
  });
});

describe("groupSteps", () => {
  it("splits into rounds when text follows a tool call", () => {
    const steps: Step[] = [
      { kind: "assistant", text: "let me read" },
      { kind: "tool", toolUseId: "a", toolName: "Read" },
      { kind: "assistant", text: "now edit" },
      { kind: "tool", toolUseId: "b", toolName: "Edit" },
      { kind: "assistant", text: "final answer" },
    ];
    const rounds = groupSteps(steps);
    expect(rounds.length).toBe(3);
    expect(rounds[0].toolSteps.map((t) => t.toolUseId)).toEqual(["a"]);
    expect(rounds[1].toolSteps.map((t) => t.toolUseId)).toEqual(["b"]);
    expect(rounds[2].toolSteps).toEqual([]);
    expect(rounds[2].assistantText).toBe("final answer");
  });
});

describe("resolveTurnSteps", () => {
  it("returns undefined without a transcript path", () => {
    expect(resolveTurnSteps({ transcriptPath: undefined, toolUseIds: [] })).toBeUndefined();
  });

  it("reads steps from an injected reader", () => {
    const rows = [
      { type: "user", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", name: "Grep", input: {} }],
        },
      },
    ];
    const steps = resolveTurnSteps({
      transcriptPath: "whatever.jsonl",
      toolUseIds: ["x"],
      readRows: () => rows,
    });
    expect(steps).toEqual<Step[]>([{ kind: "tool", toolUseId: "x", toolName: "Grep" }]);
  });
});
