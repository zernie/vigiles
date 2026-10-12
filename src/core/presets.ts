/**
 * Named rule PRESETS a `.vigilesrc.json` can `extends` — the ESLint
 * `recommended` model, stored as data.
 *
 * 🔴 WHY A PRESET READ AT LOAD TIME, NOT RULE LINES WRITTEN AT SETUP TIME. Every
 * rule's built-in default stays `warn` (`config-schema.ts`); the structural rules
 * gate only because `init` turns them up. It used to do that by WRITING nine
 * `"<rule>": "error"` lines into the new repo's config — a snapshot of the group
 * on the day `init` ran. A repo adopted before a rule joined the group never got
 * it from an upgrade, and re-running `init` to fetch it rewrote far more than
 * the rule (#338). `"extends": "vigiles:recommended"` is resolved by the loader
 * on every run, so the repo follows the group as the installed vigiles ships it,
 * and an explicit `rules` entry still overrides it.
 *
 * ⚠️ ADDING A RULE HERE IS A BREAKING CHANGE (a `!` commit, a semver major): it
 * can turn a consumer's CI red with no edit on their side. Removing one is not.
 * ESLint treats `eslint:recommended` the same way.
 *
 * Harness-agnostic data: rule names only, no adapter fact.
 */
import type { RulesConfig } from "./types.js";

/**
 * The rules `vigiles:recommended` raises to `error` — the FP-safe structural
 * group: each one fires only on a genuine defect (a never-available or typo'd
 * tool, a subagent missing `name`/`description`, a typo'd hook event, a broken
 * MCP reference, two skills that collide in the selector), so a well-formed
 * harness stays green.
 *
 * `hook-script-exists` is NOT here yet: it names every hand-written hook
 * (#361), and a plugin has no compiled alternative for its own hooks until #372
 * (https://github.com/zernie/vigiles/issues/372), which adds it back.
 *
 * Also gates `require-instructions-spec`: a hand-written CLAUDE.md / AGENTS.md
 * is a file whose references nothing re-verifies on change. It is the one rule
 * here a clean repo can fail before any work is done, so its finding names all
 * three ways out in order — adopt it (`adopt-spec` / `init --target`), exclude
 * a folder that is not yours, or turn it off for folders that stay hand-written
 * (`overrides`) — and `init` adopts every instruction file it finds, so a repo
 * set up by `init` starts green.
 *
 * Deliberately EXCLUDES the `untested-*` workflow rules: they stay an explicit
 * opt-in (`init --strict`).
 */
export const RECOMMENDED_RULES = [
  "subagent-tool-contract",
  "subagent-frontmatter",
  "hook-events",
  "mcp-config",
  "mcp-tool-resolves",
  "mcp-hook-target-resolves",
  "disallowed-tools-contract",
  "description-overlap",
  "compile-budget",
  "require-instructions-spec",
] as const satisfies ReadonlyArray<keyof RulesConfig>;

/** The preset names `extends` accepts. One today; the tuple is the enum. */
export const PRESET_NAMES = ["vigiles:recommended"] as const;

/** A preset name `extends` accepts. */
export type PresetName = (typeof PRESET_NAMES)[number];

/** The preset `init` writes. */
export const RECOMMENDED_PRESET: PresetName = "vigiles:recommended";

/** What each preset sets, as the config would spell it. */
const PRESETS: Readonly<
  Record<PresetName, Readonly<Partial<Record<keyof RulesConfig, "error">>>>
> = {
  "vigiles:recommended": Object.fromEntries(
    RECOMMENDED_RULES.map((r) => [r, "error"] as const),
  ),
};

/** Whether a raw value names a preset. */
export function isPresetName(value: unknown): value is PresetName {
  return PRESET_NAMES.some((n) => n === value);
}

/** The rule severities a preset sets, in the config's raw spelling. */
export function presetRules(
  name: PresetName,
): Readonly<Partial<Record<keyof RulesConfig, "error">>> {
  return PRESETS[name];
}
