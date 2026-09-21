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
 * 🔴 KNOWN LIMITATION — WALK-UP IS STILL NOT EXPRESSED, AND NOT BY OVERSIGHT.
 * The vendor scans `.agents/skills` in EVERY directory from the cwd up to the
 * repository root; `PluginLayout` names a single root-relative dir, so this
 * descriptor covers only `<root>/.agents/skills`. A skill in a SUBDIRECTORY's own
 * `.agents/skills` is still invisible.
 *
 * The 2026-09-21 discovery refactor (`src/core/surface-discovery.ts`) did NOT
 * close it, and the reason is the refactor's own bound: discovery looks in the
 * repo root and its depth-1 dot-directories, because an unbounded walk grades
 * vendored third-party trees as the project's own work (#240, measured by the
 * reporter at 53 vendored skills beside 37 real ones). Reaching a subpackage's
 * `.agents/skills` means walking arbitrary directories, which is exactly what
 * that bound refuses, so the gap is a deliberate trade and not a TODO.
 *
 * What it costs in practice: for `vigiles audit` AT THE REPO ROOT — the normal
 * invocation — the root IS the whole walk-up chain, so nothing is missed. The
 * gap is a monorepo subpackage keeping its own `.agents/skills`; point vigiles
 * at that subdirectory to audit it.
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
 * 🔴 THE PATHS BELOW ARE DOCUMENTED IN `docs/configuration.md`. Change any of
 * them — `instructionFile`, `surfaces`, `userSurfaceRoot`, `rulesDir` — and
 * that page is wrong until you edit it too. The page marks this symbol with
 * `vigiles:symbol`, so RENAMING it turns `vigiles lint` red and forces the
 * edit; changing a VALUE in place does not, and nothing today catches that.
 */
import type { PluginLayout } from "../../core/layout.js";
import { tomlSettingsCodec } from "../../core/settings-codec.js";

export const codexLayout: PluginLayout = {
  name: "codex",
  manifestPath: ".codex/config.toml",
  hooksConventionPath: ".codex/hooks.json",
  settingsPath: ".codex/config.toml",
  settings: tomlSettingsCodec,
  instructionFile: "AGENTS.md",
  // Surfaces carry their OWN prefix and the materialize prefix is "" — the
  // OpenCode style, not the Claude Code one. Codex's skills and its prompts do
  // NOT share a parent (`.agents/` vs `.codex/`), so no single root can name
  // both; spelling each dir in full is the only shape that keeps the reported key
  // equal to the real on-disk path.
  surfaces: {
    skill: ".agents/skills",
    // No `agent` key: Codex `[agents]` is a TOML concurrency table, not a
    // subagent dir. An ABSENT key is the only spelling of "this harness has no
    // such surface" — it used to be `agentDir: ""`, a second spelling that every
    // reader had to remember to test for.
    //
    // Custom prompts are documented ONLY at `~/.codex/prompts` (user-global,
    // top-level `.md`, and marked deprecated in favour of skills). No repo-level
    // location is documented, so this prototype's root-level `prompts/` is left
    // as it was rather than moved on a guess.
    command: "prompts",
  },
  // No `userSurfaceRoot`: the surfaces carry their own prefix, so the
  // materialize prefix is "" and a file-map key equals the on-disk path. That
  // used to be spelled twice, as `materializeRoot: ""` beside an absent
  // `userSurfaceRoot`.
  //
  // ⚠️ `hookScriptsDir: "hooks"` carries over the value the hand-written
  // `intraRefDirs` had. NOTHING in the vendor pages confirms a repo-level
  // `hooks/` directory for Codex; it is kept as it was rather than "aligned"
  // from a guess, the same stance `installCodexSkills` takes above.
  hookScriptsDir: "hooks",
  pluginRootToken: "${PLUGIN_ROOT}",
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcp_servers",
};
