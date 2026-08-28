#!/usr/bin/env node
/**
 * Install the LangSmith tracing hooks into Qoder's settings.json.
 *
 * Usage:
 *   node scripts/install.mjs            # user-global: ~/.qoder/settings.json (default)
 *   node scripts/install.mjs --project  # project-scoped: ./.qoder/settings.json
 *   node scripts/install.mjs --print    # print the generated config, don't write
 *
 * Why an installer (not a static settings.json): Qoder spawns hooks from a GUI
 * context without your shell PATH / version manager, so the command must use an
 * absolute node binary and absolute bundle paths. We template both here, route
 * every event through guard.js (which re-resolves the login-shell Node), and
 * merge into any existing settings.json (preserving unrelated hooks/settings).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Qoder event name → bundled hook file (without .js), dispatched via guard.js.
const EVENT_TO_HOOK = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  PostToolUseFailure: "post-tool-use-failure",
  SubagentStart: "subagent-start",
  SubagentStop: "subagent-stop",
  Stop: "stop",
  SessionEnd: "session-end",
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const bundleDir = join(repoRoot, "bundle");
const nodeBin = process.execPath; // absolute path to the node running this script

const args = process.argv.slice(2);
const project = args.includes("--project");
const printOnly = args.includes("--print");

if (!existsSync(bundleDir)) {
  console.error(`bundle/ not found at ${bundleDir}. Run \`pnpm build\` first.`);
  process.exit(1);
}

function q(p) {
  return `"${p}"`;
}

const guard = join(bundleDir, "guard.js");

// Build our hook entries in Qoder's nested settings.json shape.
const ourHooks = {};
for (const [event, hook] of Object.entries(EVENT_TO_HOOK)) {
  ourHooks[event] = [
    { hooks: [{ type: "command", command: `${q(nodeBin)} ${q(guard)} ${hook}` }] },
  ];
}

const target = project
  ? join(process.cwd(), ".qoder", "settings.json")
  : join(homedir(), ".qoder", "settings.json");

// Merge with any existing settings.json (preserve unrelated top-level keys and hooks).
let existing = {};
try {
  existing = JSON.parse(readFileSync(target, "utf-8"));
  if (typeof existing !== "object" || existing === null) existing = {};
} catch {
  existing = {};
}

const merged = {
  ...existing,
  hooks: { ...existing.hooks, ...ourHooks },
};

const json = JSON.stringify(merged, null, 2);

if (printOnly) {
  console.log(json);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, json + "\n");

console.log(`Installed LangSmith Qoder hooks → ${target}`);
console.log(`  node:   ${nodeBin}`);
console.log(`  bundle: ${bundleDir}`);
console.log("");
console.log("Next:");
console.log(
  `  1. Configure ${project ? "./.qoder" : "~/.qoder"}/langsmith.json (enabled + api_key + project).`,
);
console.log("  2. Fully restart Qoder so it reloads settings.json.");
console.log("  3. Run an agent turn; tail ~/.qoder/langsmith-hook.log for activity.");
