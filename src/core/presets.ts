/**
 * Named rule PRESETS a `.vigilesrc.json` can `extends` — the ESLint
 * `recommended` model, stored as data on the rule GROUPS.
 *
 * 🔴 WHY A PRESET READ AT LOAD TIME, NOT RULE LINES WRITTEN AT SETUP TIME. Every
 * rule keeps its own built-in default; a group gates only because its preset
 * turns it up. `init` used to do that by WRITING nine `"<rule>": "error"` lines
 * into the new repo's config — a snapshot of the group on the day `init` ran. A
 * repo adopted before a rule joined the group never got it from an upgrade, and
 * re-running `init` to fetch it rewrote far more than the rule (#338). An
 * `extends` preset is resolved by the loader on every run, so the repo follows
 * the group as the installed vigiles ships it, and an explicit `rules` entry
 * still overrides it.
 *
 * WHERE THE PRESETS COME FROM — not from here. A preset is a field of a group
 * (`RuleGroupSpec.preset`: its name and the severity it sets), and a rule's
 * membership is its own `group` field; both live in the outer rule layer
 * (`src/rules/`) and arrive as parameters. So this file names no rule and no
 * group, and moving a rule between groups is an edit to that rule alone.
 *
 * ⚠️ RAISING A RULE UNDER A PRESET THAT SETS `error` IS A BREAKING CHANGE (a `!`
 * commit, a semver major): it can turn a consumer's CI red with no edit on their
 * side. A preset that sets `warn` can grow freely. ESLint treats
 * `eslint:recommended` the same way.
 */
import type { RuleGroups, RuleSpec } from "./rule.js";

/** The namespace every preset name carries; the CLI flag may omit it. */
export const PRESET_PREFIX = "vigiles:";

/**
 * The preset names a raw `extends` value lists, in order: a string is one, an
 * array is several. Anything else — or any entry that is not in `known` —
 * yields `null`, so the caller leaves it for the schema to refuse with its own
 * message.
 */
export function extendedPresets(
  known: readonly string[],
  value: unknown,
): readonly string[] | null {
  if (value === undefined) return [];
  const list: readonly unknown[] = Array.isArray(value) ? value : [value];
  return list.every(
    (n): n is string => typeof n === "string" && known.includes(n),
  )
    ? list
    : null;
}

/**
 * What each preset sets, as the config would spell it: every rule whose group
 * carries the preset, at the preset's severity.
 */
export function presetRulesOf(
  rules: readonly RuleSpec[],
  groups: RuleGroups,
): (name: string) => Readonly<Record<string, "error" | "warn">> {
  return (name) =>
    Object.fromEntries(
      rules.flatMap((r) => {
        const preset = groups[r.group]?.preset;
        return preset?.name === name ? [[r.id, preset.severity] as const] : [];
      }),
    );
}
