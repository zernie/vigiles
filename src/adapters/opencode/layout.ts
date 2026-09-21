/**
 * opencodeLayout — EXPERIMENTAL, internal-only. A prototype `PluginLayout` for
 * OpenCode: `opencode.json` manifest/settings, `AGENTS.md`, `.opencode/`
 * surfaces, `${OPENCODE_PLUGIN_ROOT}`. Validates the layout port against real
 * OpenCode shapes. NOT exported / NOT registered.
 *
 * 🔴 IT IS THE PORT'S THIRD IMPLEMENTATION, AND IT SHIPPED BROKEN — which is
 * exactly the job a third implementation has. Until 2026-09-21 this descriptor
 * read:
 *
 *     surfaceDirs: [".opencode/agent", ".opencode/command"],
 *     skillDir: ".opencode/skill",
 *
 * Two fields naming the same set of directories, disagreeing. Everything that
 * materializes, counts or scans a surface ranged over `surfaceDirs`, so
 * OpenCode's skills were NAMED by the port and READ by nothing: a repo with
 * skills under `.opencode/skill` graded as having none. Nothing caught it,
 * because a port validated against two implementations cannot see a state only
 * the third can reach.
 *
 * It cannot be written now: `surfaces` is one record keyed by kind, so there is
 * no second field to disagree with, and `surfaceDirs()` is derived from it.
 * Listing the skill dir here is therefore also a BEHAVIOUR change for this
 * prototype — its skills become readable for the first time.
 */
import type { PluginLayout } from "../../core/layout.js";
import type { InstructionChain } from "../../core/instruction-chain.js";
import { settingsSourcePaths } from "../../core/instruction-chain.js";
import { jsonSettingsCodec } from "../../core/settings-codec.js";
import { opencodeInstructionChain } from "./instruction-chain.js";

export const opencodeLayout: PluginLayout = {
  name: "opencode",
  manifestPath: "opencode.json",
  // No `hooksConventionPath`: OpenCode hooks are JS plugin modules under
  // `.opencode/plugin`, which is a DIRECTORY. The field names a standalone
  // hooks FILE, and every reader treats it as one (dirname it, parse it,
  // round-trip it), so naming a directory there made each of them wrong about
  // it. The field is optional now and this layout omits it; the adapter already
  // declares `shellHooks: false`, so no shell-hook reader asks.
  settingsPath: "opencode.json",
  settings: jsonSettingsCodec,
  instructionFile: "AGENTS.md",
  surfaces: {
    skill: ".opencode/skill",
    agent: ".opencode/agent",
    command: ".opencode/command",
  },
  // No `userSurfaceRoot`: OpenCode's surfaces already live UNDER `.opencode/`
  // at the source, so they are NOT relocated and the materialize prefix is ""
  // (doubling the `.opencode/` segment is what a prefix here would do).
  // Contrast Claude Code: root-level `skills/` surfaces relocated under
  // `.claude`.
  //
  // No `hookScriptsDir`: there are no hook SCRIPTS to scan — the hooks are
  // in-process code modules, which is the same fact `shellHooks: false` states
  // on the adapter.
  pluginRootToken: "${OPENCODE_PLUGIN_ROOT}",
  mcpConfigFile: "opencode.json",
  mcpManifestKey: "mcp",
  // The root file plus whatever `opencode.json#instructions` names: a concrete
  // path is an import, a glob is a PATTERN that is reported and never walked.
  // This is the only implementation here that populates `patterns`.
  instructionChain(files): InstructionChain {
    return opencodeInstructionChain(files, {
      instructionFile: opencodeLayout.instructionFile,
      settingsPaths: settingsSourcePaths(opencodeLayout),
      parseSettings: (text) => opencodeLayout.settings.parse(text),
    });
  },
};
