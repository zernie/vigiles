/**
 * claudeCodeLayout — the Claude Code plugin/repo layout (the `PluginLayout`
 * port's reference implementation). `loadPlugin` defaults to it; a Codex adapter
 * defines a sibling `codexLayout` and passes it to the same loader.
 * 🔴 THE PATHS BELOW ARE DOCUMENTED IN `docs/configuration.md`. Change any of
 * them — `instructionFile`, `surfaceDirs`, `userSurfaceRoot`, `rulesDir` — and
 * that page is wrong until you edit it too. The page marks this symbol with
 * `vigiles:symbol`, so RENAMING it turns `vigiles lint` red and forces the
 * edit; changing a VALUE in place does not, and nothing today catches that.
 */
import type { PluginLayout } from "../../core/layout.js";

export const claudeCodeLayout: PluginLayout = {
  name: "claude-code",
  manifestPath: ".claude-plugin/plugin.json",
  hooksConventionPath: "hooks/hooks.json",
  settingsPath: ".claude/settings.json",
  settingsFormat: "json",
  instructionFile: "CLAUDE.md",
  surfaceDirs: ["skills", "agents", "commands"],
  // A plain Claude Code USER keeps skills/agents/commands under `.claude/`, not at
  // the repo root (that's the published-plugin shape). Read both so a normal repo
  // isn't seen as an empty machine.
  userSurfaceRoot: ".claude",
  skillDir: "skills",
  agentDir: "agents",
  commandDir: "commands",
  // `.claude/rules/*.md` — path-scoped project instructions (see PluginLayout).
  rulesDir: "rules",
  materializeRoot: ".claude",
  pluginRootToken: "${CLAUDE_PLUGIN_ROOT}",
  // Both names Claude Code uses for the project root (mirrors the
  // `NON_PLUGIN_VARS` set in plugin-loader.ts / scan-files.ts).
  projectRootTokens: ["${CLAUDE_PROJECT_DIR}", "${CLAUDE_PROJECT}"],
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcpServers",
  intraRefDirs: ["hooks", "skills", "agents", "commands"],
};
