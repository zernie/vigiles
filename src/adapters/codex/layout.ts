/**
 * codexLayout — the OpenAI Codex `PluginLayout`: `.agents/skills` skills,
 * `.codex/config.toml` (TOML) settings/hooks, `AGENTS.md`, `${PLUGIN_ROOT}`.
 * Exported as `vigiles/codex` and registered in `src/adapter-registry.ts`.
 *
 * 🔴 SKILLS LIVE AT `.agents/skills`, NOT `.codex/skills`. This descriptor said
 * `.codex` + `skills` until 2026-09-21 — so the loader read `<root>/skills` and
 * reported it under a `.codex/skills/…` key, and a real Codex repo's skills were
 * read as ZERO. Verbatim from the vendor page
 * (`https://learn.chatgpt.com/docs/build-skills`, redirected from
 * `developers.openai.com/codex/skills`), fetched 2026-09-21:
 *
 * > Codex scans `.agents/skills` in every directory from your current working
 * > directory up to the repository root.
 *
 * The same page lists `$HOME/.agents/skills` ("any skills checked into the
 * user's personal folder") and `/etc/codex/skills` as the other scopes, and
 * never mentions `.codex/skills` at all. Corroborated in-repo by
 * `src/cli-install.e2e.test.ts`, which drives the real `skills` CLI and finds the
 * install at `~/.agents/skills/`.
 *
 * 🔴 KNOWN LIMITATION — WALK-UP IS NOT EXPRESSED HERE. The vendor scans
 * `.agents/skills` in EVERY directory from the cwd up to the repository root;
 * `PluginLayout` names a single root-relative dir, so this descriptor covers only
 * `<root>/.agents/skills`. A skill in a subdirectory's own `.agents/skills` is
 * still invisible. Expressing walk-up needs a multi-root layout port — deliberately
 * left to that refactor rather than faked with a glob here.
 *
 * ⚠️ `installCodexSkills` (`./eval.ts`) still writes the eval tier's skills to
 * `<cwd>/.codex/skills/`, and its comment claims that path was validated live
 * against the binary (`eval.test.ts` carries a captured transcript reading
 * `/tmp/cxreal/.codex/skills/…`). That is MEASURED evidence for an older Codex
 * and it contradicts the page above; it is deliberately left alone until someone
 * re-measures against the current binary. Do not "align" it from the docs alone.
 *
 * Other findings from the prototype (see research/codex-prototype-findings.md):
 * - Codex has no separate JSON *manifest* — `config.toml` carries everything; we
 *   point `manifestPath` at it (its JSON parse simply fails → the loader falls
 *   through to the TOML `settingsPath`). The manifest field is CC-JSON-shaped.
 * - MCP detection (`mcpConfigFile`/`mcpManifestKey`) is JSON-shaped, so it won't
 *   see Codex's `[mcp_servers]` TOML table — a known layout-port gap.
 */
import type { PluginLayout } from "../../core/layout.js";

export const codexLayout: PluginLayout = {
  name: "codex",
  manifestPath: ".codex/config.toml",
  hooksConventionPath: ".codex/hooks.json",
  settingsPath: ".codex/config.toml",
  settingsFormat: "toml",
  instructionFile: "AGENTS.md",
  // Surfaces carry their OWN prefix and `materializeRoot` is "" — the OpenCode
  // style, not the Claude Code one. Codex's skills and its prompts do NOT share a
  // parent (`.agents/` vs `.codex/`), so no single `materializeRoot` can name
  // both; spelling each dir in full is the only shape that keeps the reported key
  // equal to the real on-disk path.
  surfaceDirs: [".agents/skills", "prompts"],
  skillDir: ".agents/skills",
  agentDir: "", // Codex `[agents]` is a TOML concurrency table, not a subagent dir
  // Custom prompts are documented ONLY at `~/.codex/prompts` (user-global,
  // top-level `.md`, and marked deprecated in favour of skills). No repo-level
  // location is documented, so this prototype's root-level `prompts/` is left as
  // it was rather than moved on a guess.
  commandDir: "prompts",
  materializeRoot: "",
  pluginRootToken: "${PLUGIN_ROOT}",
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcp_servers",
  intraRefDirs: [".agents/skills", "prompts", "hooks"],
};
