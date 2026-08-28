import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Run } from "langsmith";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../src/langsmith.js";

const CAPTURE = join(process.cwd(), "test/fixtures/qoder-hooks.jsonl");
const THREAD = "sess-1";

function meta(run: Run): Record<string, unknown> {
  return (run.extra as { metadata?: Record<string, unknown> })?.metadata ?? {};
}

/** Run timestamps are posted either as epoch ms or as an ISO string. */
function ms(time: string | number | undefined): number {
  return typeof time === "number" ? time : Date.parse(time ?? "");
}

describe("replay qoder-hooks.jsonl through the event-buffer reducers", () => {
  const { finalized, finalState } = replayHookLog(CAPTURE);

  it("finalizes one turn per Stop, all in the same session/thread", () => {
    expect(finalized.length).toBe(4);
    expect(new Set(finalized.map((f) => f.conversationId))).toEqual(new Set([THREAD]));
    expect(finalized.map((f) => f.turnNum)).toEqual([1, 2, 3, 4]);
  });

  it("carries the session model onto turns and the final assistant text", () => {
    expect(finalized[0].buffer.model).toBe("qmodel_38max");
    expect(finalized[0].buffer.finalText).toBe("Hi there!");
  });

  it("captures a tool turn with successes and a failure", () => {
    const turn = finalized[1];
    expect(turn.buffer.tools.length).toBe(3);
    expect(turn.buffer.tools.some((t) => t.output != null)).toBe(true);
    expect(turn.buffer.tools.some((t) => t.error != null)).toBe(true);
    expect(turn.buffer.tools.map((t) => t.name)).toEqual(["Read", "Grep", "Read"]);
  });

  it("exposes no token usage (Qoder hooks don't provide it)", () => {
    for (const f of finalized) expect(f.buffer.usage).toBeUndefined();
  });

  it("recovers subagent tools and result from its transcript", () => {
    const turn = finalized.find((f) => f.buffer.subagents.length > 0)!;
    const sub = turn.buffer.subagents[0];
    expect(sub.subagent_type).toBe("explore");
    expect(sub.childConversationId).toBe("subagent-conv-1");
    expect(sub.resultText).toContain("Exploration complete");
    expect(sub.tools?.map((t) => t.name)).toEqual(["Read", "Grep"]);
    expect(sub.tools?.some((t) => t.output != null)).toBe(true);
    expect(sub.tools?.some((t) => t.error != null)).toBe(true);
  });

  it("pairs each tool with its PreToolUse start so the run has a real duration", () => {
    const tools = finalized[1].buffer.tools;
    expect(tools.map((t) => t.endMs - t.startMs!)).toEqual([500, 500, 500]);
    // The two Read calls have distinct inputs — each must claim its own start.
    expect(tools[0].startMs).toBe(Date.parse("2026-08-28T10:01:00.500Z"));
    expect(tools[2].startMs).toBe(Date.parse("2026-08-28T10:01:02.500Z"));
  });

  it("leaves no in-progress turns after the session", () => {
    expect(Object.keys(finalState)).toEqual([THREAD]);
    expect(finalState[THREAD].turns).toEqual({});
    expect(finalState[THREAD].turn_count).toBe(4);
    expect(finalState[THREAD].pending_tools).toEqual([]);
  });
});

describe("buildTurnRuns produces the expected LangSmith run tree", () => {
  it("builds Qoder Turn(chain) → llm with thread_id, no usage_metadata", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized[0];

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.values(tree.data).find((r) => r.run_type === "chain")!;
    const llm = Object.values(tree.data).find((r) => r.run_type === "llm")!;

    expect(root.name).toBe("Qoder Turn 1");
    expect(meta(root).thread_id).toBe(THREAD);
    expect(meta(root).ls_integration).toBe("qoder");
    expect(llm.parent_run_id).toBe(root.id);
    expect(meta(llm).ls_provider).toBe("qoder");
    expect(meta(llm).ls_model_name).toBe("qmodel_38max");
    expect(meta(llm).usage_metadata).toBeUndefined();
  });

  it("gives each tool run its real span instead of a zero-length one", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized[1];

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const toolRuns = Object.values(tree.data).filter((r) => r.run_type === "tool");
    expect(toolRuns.length).toBe(3);
    for (const run of toolRuns) {
      expect(ms(run.end_time) - ms(run.start_time)).toBe(500);
    }
  });

  it("renders a subagent as a nested Subagent chain of the turn", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized.find((f) => f.buffer.subagents.length > 0)!;

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.values(tree.data).find((r) => r.run_type === "chain" && !r.parent_run_id)!;
    const task = Object.values(tree.data).find((r) => r.name?.endsWith("Subagent"))!;

    expect(task).toBeDefined();
    expect(task.name).toBe("explore Subagent");
    expect(task.parent_run_id).toBe(root.id);
    expect(meta(task).ls_subagent_type).toBe("explore");
  });
});
