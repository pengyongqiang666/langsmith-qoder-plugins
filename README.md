# LangSmith Tracing for Qoder

Traces Qoder Agent turns — prompts, model responses, tool calls, and subagents — to [LangSmith](https://smith.langchain.com), grouped into threads per conversation.

It works via [Qoder hooks](https://docs.qoder.com/extensions/hooks): short-lived hook processes buffer the agent's event stream to a local state file, and each `Stop` (one per turn) assembles and posts one LangSmith trace.

## How it works

Qoder's hook payloads are the primary event source; the session **transcript JSONL** (`transcript_path`) enriches each turn with interleaved step fidelity, and each subagent's `agent_transcript_path` supplies its tool calls and final answer:

- `SessionStart` records the session's model.
- `UserPromptSubmit` opens a turn buffer (keyed by `request_set_id`).
- `PreToolUse` records each tool call's start time, so tool runs carry a real duration.
- `PostToolUse` / `PostToolUseFailure` append tool calls.
- `SubagentStart` / `SubagentStop` record subagents (tools + result recovered from the subagent transcript).
- `Stop` finalizes the turn: builds the trace and flushes it to LangSmith.

Each turn is its own trace, grouped into a thread via `thread_id = session_id`:

```
Qoder Turn N (chain)
├── <provider> (llm)   model/provider, assistant text
├── Read / Bash / … (tool)
└── explore Subagent (chain)   subagent (type + result), with its tool calls nested underneath
```

## Install

Requirements: Node.js ≥ 18.

Run the installer, which writes the hooks into Qoder's `settings.json` (absolute node + bundle paths, routed through `guard.js`):

```bash
# install hooks (writes ~/.qoder/settings.json by default; merges with existing)
node scripts/install.mjs            # user-global (all projects)
node scripts/install.mjs --project  # project-scoped (./.qoder/settings.json)
node scripts/install.mjs --print    # preview without writing
```

The committed `bundle/` means this runs without a build step. Rebuild only after editing the TypeScript source:

```bash
pnpm install
pnpm build              # tsc → esbuild → bundle/*.js
```

Then **fully restart Qoder** so it reloads `settings.json` (hooks are not hot-reloaded).

> `bundle/` is committed on purpose — it lets the installer run without a build step. Don't add it to `.gitignore`.

## Configure

Create `~/.qoder/langsmith.json` (global) or `./.qoder/langsmith.json` (project):

```json
{
  "enabled": true,
  "api_key": "lsv2_pt_...",
  "api_url": "https://api.smith.langchain.com",
  "project": "qoder"
}
```

Config resolves in this order (later overrides earlier): defaults → `~/.qoder/langsmith.json` → `./.qoder/langsmith.json` → environment variables.

Every `LANGSMITH_QODER_*` variable also accepts the `LANGSMITH_*` form (the `LANGSMITH_QODER_*` name wins when both are set).

| Environment variable             | Config key | Description                                                  | Default                           |
| -------------------------------- | ---------- | ------------------------------------------------------------ | --------------------------------- |
| `TRACE_TO_LANGSMITH`             | `enabled`  | Master switch — tracing runs only when truthy.               | `false`                           |
| `LANGSMITH_QODER_API_KEY`        | `api_key`  | LangSmith API key.                                           | —                                 |
| `LANGSMITH_QODER_ENDPOINT`       | `api_url`  | LangSmith API base URL.                                      | `https://api.smith.langchain.com` |
| `LANGSMITH_QODER_PROJECT`        | `project`  | Target tracing project.                                      | `qoder`                           |
| `LANGSMITH_QODER_METADATA`       | `metadata` | Extra metadata attached to every run (JSON object).          | —                                 |
| `LANGSMITH_QODER_RUNS_ENDPOINTS` | `replicas` | Additional replica destinations (JSON array).                | —                                 |
| `LANGSMITH_QODER_REDACT`         | `redact`   | Redact detected secrets from traced data before upload.      | `true`                            |
| `LANGSMITH_QODER_REDACT_EXTRA`   | —          | Extra redaction rules: JSON array of `{ pattern, replace }`. | —                                 |
| `LANGSMITH_QODER_DEBUG`          | —          | Verbose hook logging.                                        | `false`                           |
| `LANGSMITH_QODER_STATE_FILE`     | —          | Override the on-disk event-buffer state file.                | `~/.qoder/langsmith-state.json`   |
| `LANGSMITH_QODER_LOG_FILE`       | —          | Override the hook log file.                                  | `~/.qoder/langsmith-hook.log`     |

Tracing only runs when `enabled` (or `TRACE_TO_LANGSMITH=true`) **and** an API key (or replicas) is set.

Verify activity: `tail -f ~/.qoder/langsmith-hook.log`.

## What's traced

- **Turns** grouped into threads (`thread_id` = `session_id`).
- **Model / provider** (`ls_model_name`, `ls_provider`) — from the session's model setting. `Auto` reports provider `qoder` (unpriced).
- **Tool calls** (success and failure) with inputs/outputs.
- **Subagents** as a nested chain run (subagent type + result), with their internal tool calls (and I/O) recovered from the subagent transcript.
- **Interleaved step fidelity** — assistant text and tool calls, ordered from the session transcript.

## Trace metadata (coding-agent-v1)

Every run carries the shared [`coding-agent-v1`](https://docs.langchain.com/langsmith/coding-agent-metadata-contract) coding-agent metadata contract on `run.extra.metadata`, built by one helper (`src/metadata.ts`) and propagated to child runs. This lets traces from any coding agent (Claude Code, Codex, Cursor, Qoder, …) be identified, grouped, and attributed with the same stable keys.

**Always present** (every run): `ls_agent_purpose` (`"coding"`), `ls_agent_type` (`"root"` or `"subagent"`), `ls_integration` (`"qoder"`), `ls_agent_runtime` (`"Qoder"`), `ls_trace_schema_version` (`"coding-agent-v1"`), `thread_id` (= `session_id`).

**Present where known** (every run): `ls_integration_version` (plugin version, build-time injected), `turn_id` (= `request_set_id`), `turn_number`, `repository_name`, `git_branch`, `cwd` — sourced from the payload's `extra` (`email`, `repo`, `branch`) and from `git` in the working directory. On **subagent** runs only: `ls_subagent_id`, `ls_subagent_type`. On **tool** runs only: `ls_tool_name` (emitted only when the run name differs from the native tool name).

**Contextual:** `local_username`, `user_email` (from `extra.email`).

## Known limitations

Qoder's hooks and transcript don't expose everything Cursor's local DB did, so these are unavailable:

- **Token usage / cost** — Qoder hooks emit no token counts, so `usage_metadata` is omitted and LangSmith cannot price runs.
- **User-message attachments** — attachment bytes are not exposed to hooks.
- **System prompt** — not present in the Qoder transcript.

## Troubleshooting

**Nothing shows up in LangSmith / `turn_count` stays 0.** Qoder launches hooks from a GUI context, where the `node` on `PATH` is often older than your shell's version-managed node (nvm/mise/asdf). The hook guard resolves Node through your interactive login shell and hands execution to it (Node ≥ 18 required).

The hooks run through a small version guard that fails loudly instead of silently. If your node is too old, you'll see a line in `~/.qoder/langsmith-hook.log` (and hook stderr) like:

```
[langsmith] Node 16.20.0 at /usr/local/bin/node is too old for tracing (need >= 18.0). This turn was NOT traced. ...
```

The path in that message is the exact node the guard ultimately used. To fix it, configure Node ≥ 18 in your login shell's startup files, or launch Qoder from a terminal so it inherits your shell environment.

Tail the log to confirm activity: `tail -f ~/.qoder/langsmith-hook.log`.

## Development

```bash
pnpm build       # compile + bundle
pnpm test        # vitest (unit + replay over captured hook logs)
pnpm format      # oxfmt
pnpm lint        # oxlint
```

`test/fixtures/` holds captured hook logs and agent transcripts used as replay test fixtures.

> The bundled fixtures are synthesized from Qoder's documented hook/transcript schema. Validate them against a real Qoder session (confirm `request_set_id`, `tool_use_id` presence on `PostToolUse` / `PreToolUse`, and the transcript schema) before relying on edge-case behavior.

Qoder's documented `PreToolUse` payload carries no `tool_use_id`, so a start time is paired to its completed call by `tool_use_id` when present, else by tool name + input, else by tool name (earliest first). An unpaired tool run falls back to a zero-length span rather than a wrong duration.

## License

MIT
