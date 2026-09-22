/**
 * opencodeDialect — EXPERIMENTAL, internal-only. A prototype `HarnessDialect` for
 * OpenCode, built to validate that the format axis generalizes to a harness whose
 * hooks are in-process JS/TS plugin modules rather than shell processes. NOT
 * exported from `vigiles/*` and NOT registered in the adapter registry — it exists
 * to be run through the conformance kit + real OpenCode-shaped fixtures.
 */
import type { HarnessDialect } from "../../core/dialect.js";

export const opencodeDialect: HarnessDialect = {
  name: "opencode",
  // OpenCode's lowercase built-in tool catalog (file/shell/search + task).
  builtinAgentTools: [
    "bash",
    "edit",
    "read",
    "write",
    "grep",
    "glob",
    "list",
    "webfetch",
    "task",
  ],
  // No documented "never available to a subagent" set — left empty.
  neverAvailableTools: [],
  mcpToolPattern: /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i,
  // OpenCode's event-bus names, NOT shell hook events: a plugin module subscribes
  // to these in-process (no exit-code/env wire protocol → shellHooks:false).
  hookEvents: [
    "session.start",
    "tool.execute.before",
    "tool.execute.after",
    "session.idle",
  ],
  // AGENTS.md native + CLAUDE.md fallback.
  instructionTargets: ["AGENTS.md", "CLAUDE.md"],
  pluginRootToken: "${OPENCODE_PLUGIN_ROOT}",
  // OpenCode reads the minimal cross-tool SKILL.md frontmatter (name +
  // description); the richer keys are not part of its format.
  skillFrontmatterKeys: ["name", "description"],
};
