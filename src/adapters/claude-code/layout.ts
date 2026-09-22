/**
 * claudeCodeLayout — the Claude Code plugin/repo layout (the `PluginLayout`
 * port's reference implementation). `loadPlugin` defaults to it; a Codex adapter
 * defines a sibling `codexLayout` and passes it to the same loader.
 * 🔴 THE PATHS BELOW ARE DOCUMENTED IN `docs/configuration.md`. Change any of
 * them — `instructionFile`, `surfaces`, `userSurfaceRoot`, `rulesDir` — and
 * that page is wrong until you edit it too. The page marks this symbol with
 * `vigiles:symbol`, so RENAMING it turns `vigiles lint` red and forces the
 * edit; changing a VALUE in place does not, and nothing today catches that.
 */
import { ruleFileRe, type PluginLayout } from "../../core/layout.js";
import { settingsSourcePaths } from "../../core/instruction-chain.js";
import type { InstructionChain } from "../../core/instruction-chain.js";
import { jsonSettingsCodec } from "../../core/settings-codec.js";
import { claudeCodeInstructionChain } from "./instruction-chain.js";

export const claudeCodeLayout: PluginLayout = {
  name: "claude-code",
  manifestPath: ".claude-plugin/plugin.json",
  hooksConventionPath: "hooks/hooks.json",
  settingsPath: ".claude/settings.json",
  settings: jsonSettingsCodec,
  instructionFile: "CLAUDE.md",
  surfaces: { skill: "skills", agent: "agents", command: "commands" },
  // A plain Claude Code USER keeps skills/agents/commands under `.claude/`, not at
  // the repo root (that's the published-plugin shape). Read both so a normal repo
  // isn't seen as an empty machine. This is also the materialize prefix — it used
  // to be a second field, `materializeRoot: ".claude"`, saying the same thing.
  userSurfaceRoot: ".claude",
  // `.claude/rules/*.md` — path-scoped project instructions (see PluginLayout).
  rulesDir: "rules",
  // `.claude/settings.local.json` — the per-machine layer, gitignored by
  // `init`. Declared because only this adapter knows the word; Codex and
  // OpenCode name none, so none is synthesized for them.
  settingsLocalInfix: "local",
  // Plugin hook SCRIPTS (`hooks/*.sh`), distinct from where hooks are
  // REGISTERED (`hooks/hooks.json`, `.claude/settings.json`).
  hookScriptsDir: "hooks",
  pluginRootToken: "${CLAUDE_PLUGIN_ROOT}",
  // Both names Claude Code uses for the project root (mirrors the
  // `NON_PLUGIN_VARS` set in plugin-loader.ts / scan-files.ts).
  projectRootTokens: ["${CLAUDE_PROJECT_DIR}", "${CLAUDE_PROJECT}"],
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcpServers",
  // What a repo-root session LOADS, and why each remaining candidate does not —
  // see ./instruction-chain.ts for the vendor quotes behind every branch. The
  // regexes and paths handed over are DERIVED from the fields above, so moving
  // `rulesDir` or `userSurfaceRoot` moves the chain with it.
  instructionChain(files): InstructionChain {
    return claudeCodeInstructionChain(files, {
      instructionFile: claudeCodeLayout.instructionFile,
      userSurfaceRoot: claudeCodeLayout.userSurfaceRoot ?? "",
      settingsPaths: settingsSourcePaths(claudeCodeLayout),
      parseSettings: (text) => claudeCodeLayout.settings.parse(text),
      // ANCHORED to `.claude/rules`, not to any path segment spelled `rules`
      // — see `ruleFileRe`. `??` is safe here and not a silent default: this
      // layout declares `rulesDir`, and a layout that did not would want no
      // rule matcher at all rather than one matching nothing.
      ruleRe: ruleFileRe(claudeCodeLayout) ?? /(?!)/,
    });
  },
};
