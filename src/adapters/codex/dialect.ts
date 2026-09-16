/**
 * codexDialect — EXPERIMENTAL, internal-only. A prototype `HarnessDialect` for
 * OpenAI Codex, built from the mid-2026 research (research/harness-landscape.md)
 * to validate that the format axis actually generalizes beyond Claude Code. NOT
 * exported from `vigiles/*` and NOT registered in the adapter registry — it
 * exists to be run through the conformance kit + real Codex-shaped fixtures.
 */
import type { HarnessDialect } from "../../core/dialect.js";

export const codexDialect: HarnessDialect = {
  name: "codex",
  // Codex model-facing tools (shell/exec, file edits, plan, web), + MCP tools.
  builtinAgentTools: ["shell", "apply_patch", "update_plan", "web_search"],
  // No documented "never available to a subagent" set yet — left empty.
  neverAvailableTools: [],
  mcpToolPattern: /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i,
  // Codex hooks (near-1:1 with Claude Code) + its extras.
  hookEvents: [
    "SessionStart",
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PreCompact",
    "PostCompact",
    "UserPromptSubmit",
    "Stop",
  ],
  // 🔴 TRUNCATES, SILENTLY — the asymmetry that makes `onExceed` worth carrying.
  // Codex's own source: "Maximum number of bytes of the documentation that will
  // be embedded. Larger files are *silently truncated*" (openai/codex#7138,
  // CLOSED AS NOT PLANNED — standing behaviour, not a bug in flight). Default
  // `project_doc_max_bytes` is 32 * 1024. Over budget on Claude Code costs
  // money; over budget here means some of your rules DO NOT EXIST for the model
  // and nothing in the session says which.
  //
  // BYTES, not chars: the two diverge on any non-ASCII instruction file, and
  // this is the unit Codex actually counts.
  instructionBudget: {
    unit: "bytes",
    limit: 32768,
    onExceed: "truncates",
    capturedFrom:
      "codex config project_doc_max_bytes default 32 * 1024; truncation quoted in openai/codex#7138",
    // Read root-to-leaf and concatenated, so a nested AGENTS.md pays into the
    // same budget — the sum is what gets cut, not the individual file.
    alwaysLoaded: ["AGENTS.md", "**/AGENTS.md"],
  },
  instructionTargets: ["AGENTS.md"],
  pluginRootToken: "${PLUGIN_ROOT}",
  // Codex SKILL.md frontmatter is name + description ONLY — the CC-only keys
  // (disable-model-invocation, argument-hint, …) are not part of its format.
  skillFrontmatter: "minimal",
};
