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
 * `vigiles:experimental` is the exception to that warning: it only ever sets
 * `warn`, for repos that asked for the experimental group, so growing it cannot
 * turn anyone's CI red.
 *
 * Harness-agnostic data: rule names only, no adapter fact.
 */
import type { RulesConfig } from "./types.js";
import { EXPERIMENTAL_RULES } from "./rule-meta.js";

/**
 * The rules `vigiles:recommended` raises to `error` — the FP-safe structural
 * group: each one fires only on a genuine defect (a never-available or typo'd
 * tool, a subagent missing `name`/`description`, a typo'd hook event, a file a
 * compiled hook needs gone missing, a broken MCP reference, two skills that
 * collide in the selector), so a well-formed harness stays green.
 *
 * `hand-written-hook` is NOT here: its only cure is a compiled hook, written
 * with the `experimental_define*` API, and a preset must not push users onto an
 * experimental API. It joins when compiled hooks leave experimental (the exit
 * criteria in docs/experimental.md, "When the prefix comes off").
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
  "hook-script-exists",
  "mcp-config",
  "mcp-tool-resolves",
  "mcp-hook-target-resolves",
  "disallowed-tools-contract",
  "description-overlap",
  "compile-budget",
  "require-instructions-spec",
] as const satisfies ReadonlyArray<keyof RulesConfig>;

/**
 * The preset names `extends` accepts — the tuple is the enum, and the SAME
 * vocabulary `audit`/`lint --preset=<name>` takes (there it may drop the
 * `vigiles:` prefix: `--preset=experimental`).
 *
 * `vigiles:experimental` turns the `experimental` group (`EXPERIMENTAL_RULES`,
 * `./rule-meta.ts`) on at `warn`: checks shipped but not measured reliable
 * enough to grade anyone on. Adding a rule to THAT preset is not breaking — it
 * only reports, at `warn`, for a repo that asked for the group.
 */
export const PRESET_NAMES = [
  "vigiles:recommended",
  "vigiles:experimental",
] as const;

/** A preset name `extends` accepts. */
export type PresetName = (typeof PRESET_NAMES)[number];

/** The namespace every preset name carries; the CLI flag may omit it. */
export const PRESET_PREFIX = "vigiles:";

/** The preset `init` writes. */
export const RECOMMENDED_PRESET: PresetName = "vigiles:recommended";

/** A severity a preset may set. */
type PresetSeverity = "error" | "warn";

/** What each preset sets, as the config would spell it. */
const PRESETS: Readonly<
  Record<
    PresetName,
    Readonly<Partial<Record<keyof RulesConfig, PresetSeverity>>>
  >
> = {
  "vigiles:recommended": Object.fromEntries(
    RECOMMENDED_RULES.map((r) => [r, "error"] as const),
  ),
  "vigiles:experimental": Object.fromEntries(
    EXPERIMENTAL_RULES.map((r) => [r, "warn"] as const),
  ),
};

/** Whether a raw value names a preset. */
export function isPresetName(value: unknown): value is PresetName {
  return PRESET_NAMES.some((n) => n === value);
}

/**
 * The preset names a raw `extends` value lists, in order: a string is one, an
 * array is several. Anything else — or any entry that is not a preset — yields
 * `null`, so the caller leaves it for the schema to refuse with its own message.
 */
export function extendedPresets(value: unknown): readonly PresetName[] | null {
  if (value === undefined) return [];
  const list: readonly unknown[] = Array.isArray(value) ? value : [value];
  return list.every(isPresetName) ? list : null;
}

/** The rule severities a preset sets, in the config's raw spelling. */
export function presetRules(
  name: PresetName,
): Readonly<Partial<Record<keyof RulesConfig, PresetSeverity>>> {
  return PRESETS[name];
}
