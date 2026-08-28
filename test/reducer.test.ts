import { describe, it, expect } from "vitest";
import { reducePreToolUse, reducePostToolUse, reduceUserPromptSubmit } from "../src/reducer.js";
import type { TracingState } from "../src/types.js";

const SESSION = "sess-1";
const T0 = Date.parse("2026-08-28T10:00:00.000Z");

function openTurn(): TracingState {
  return reduceUserPromptSubmit(
    {},
    {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      cwd: "/repo",
      request_set_id: "req-1",
      prompt: "go",
    },
    T0,
  );
}

function pre(state: TracingState, name: string, input: Record<string, unknown>, atMs: number) {
  return reducePreToolUse(
    state,
    {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: "/repo",
      request_set_id: "req-1",
      tool_name: name,
      tool_input: input,
    },
    atMs,
  );
}

function post(state: TracingState, name: string, input: Record<string, unknown>, atMs: number) {
  return reducePostToolUse(
    state,
    {
      hook_event_name: "PostToolUse",
      session_id: SESSION,
      cwd: "/repo",
      request_set_id: "req-1",
      tool_name: name,
      tool_input: input,
      tool_response: "ok",
    },
    atMs,
  );
}

function tools(state: TracingState) {
  return state[SESSION].turns["req-1"].tools;
}

describe("PreToolUse → PostToolUse start-time pairing", () => {
  it("pairs concurrent calls of the same tool FIFO, by input", () => {
    let state = openTurn();
    state = pre(state, "Bash", { command: "a" }, T0 + 100);
    state = pre(state, "Bash", { command: "b" }, T0 + 200);
    // Completion order is the reverse of the start order.
    state = post(state, "Bash", { command: "b" }, T0 + 900);
    state = post(state, "Bash", { command: "a" }, T0 + 1000);

    expect(tools(state).map((t) => [t.input.command, t.startMs, t.endMs])).toEqual([
      ["b", T0 + 200, T0 + 900],
      ["a", T0 + 100, T0 + 1000],
    ]);
    expect(state[SESSION].pending_tools).toEqual([]);
  });

  it("matches regardless of tool_input key order", () => {
    let state = openTurn();
    state = pre(state, "Read", { file_path: "/a", limit: 5 }, T0 + 100);
    state = post(state, "Read", { limit: 5, file_path: "/a" }, T0 + 700);
    expect(tools(state)[0].startMs).toBe(T0 + 100);
  });

  it("falls back to the tool name when the input was rewritten", () => {
    let state = openTurn();
    state = pre(state, "Bash", { command: "npm test" }, T0 + 100);
    state = post(state, "Bash", { command: "npm test --coverage" }, T0 + 800);
    expect(tools(state)[0].startMs).toBe(T0 + 100);
  });

  it("leaves startMs undefined when no PreToolUse arrived", () => {
    let state = openTurn();
    state = post(state, "Grep", { pattern: "x" }, T0 + 500);
    expect(tools(state)[0].startMs).toBeUndefined();
  });

  it("never claims a start from a different tool", () => {
    let state = openTurn();
    state = pre(state, "Read", { file_path: "/a" }, T0 + 100);
    state = post(state, "Bash", { command: "ls" }, T0 + 500);
    expect(tools(state)[0].startMs).toBeUndefined();
    expect(state[SESSION].pending_tools?.length).toBe(1);
  });

  it("drops orphaned starts older than 10 minutes", () => {
    let state = openTurn();
    state = pre(state, "Bash", { command: "blocked" }, T0);
    state = pre(state, "Read", { file_path: "/a" }, T0 + 11 * 60 * 1000);
    expect(state[SESSION].pending_tools?.map((p) => p.name)).toEqual(["Read"]);
  });

  it("caps the pending list so state can't grow unbounded", () => {
    let state = openTurn();
    for (let i = 0; i < 80; i++) state = pre(state, "Bash", { command: `c${i}` }, T0 + i);
    expect(state[SESSION].pending_tools?.length).toBe(64);
  });
});
