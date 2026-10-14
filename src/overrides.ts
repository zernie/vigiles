/**
 * Per-path rule overrides — `.vigilesrc.json#overrides`, a list of `{ files,
 * rules }` entries in ESLint's flat-config shape (also Biome's and Stylelint's
 * `overrides`, Ruff's `per-file-ignores`): the same mechanism for EVERY rule, so
 * no rule grows its own path filter.
 *
 * PRECEDENCE is ESLint's cascade: the `extends` preset, then `rules`, then each
 * override whose `files` cover the finding's path, in order — a later override
 * wins over an earlier one. `extends` < `rules` is settled when the config is
 * parsed (`parseVigilesConfig`); this module adds the per-path layer on top.
 *
 * WHAT AN OVERRIDE SETS: a severity. A rule's options (`["error", { … }]`) live
 * in `rules`, once; an override that changes `compile-budget` to `warn` keeps
 * the thresholds `rules` gave it. The schema refuses options inside an override
 * rather than accept a value nothing would read.
 *
 * WHAT IT CANNOT DO: reach a path top-level `exclude` removed. `exclude` means
 * vigiles does not read the path at all (ESLint's global ignores), so there is
 * no finding there for an override to change.
 *
 * WHICH FINDINGS: a finding tied to one file is resolved at that file's path. A
 * finding about the repository as a whole has no path and keeps the severity
 * `rules` gives — overrides do not affect it. The list of each kind is in
 * `docs/configuration.md#overrides`.
 *
 * Paths are relative to the repository root, the directory `.vigilesrc.json`
 * sits in; the glob semantics are top-level `exclude`'s (`./root-globs.ts`).
 */
import { rootGlobMatcher } from "./root-globs.js";
import type { RuleSeverity, RulesConfig } from "./core/types.js";
import { ruleSeverity } from "./core/types.js";

/** One `overrides` entry, as parsed: globs and the severities they set. */
export interface RuleOverride<Id extends string = string> {
  readonly files: readonly string[];
  readonly rules: { readonly [K in Id]?: RuleSeverity };
}

/**
 * The severity of every rule, for any path. Generic over the rule ids: the
 * root instantiates it over its rule set (a typo'd id is a tsc error there),
 * and generic code takes it over `string` and never spells an id.
 */
export interface RuleResolver<Id extends string = string> {
  /**
   * The severity `rule` has for a finding at `path` (repository-relative).
   * `undefined` — a finding with no path — gets the severity from `rules`.
   */
  severityAt(rule: Id, path: string | undefined): RuleSeverity;
  /**
   * Whether `rule` can fire anywhere: on in `rules`, or turned on by some
   * override. A check that would skip its whole scan when its rule is off asks
   * this, so an override that turns a rule ON for one folder is not dropped.
   */
  mayFire(rule: Id): boolean;
}

/** Build the resolver once per run, from the parsed `rules` and `overrides`. */
export function ruleResolver<Id extends string = string>(
  rules: Readonly<RulesConfig<Id>>,
  overrides: readonly RuleOverride<Id>[] = [],
): RuleResolver<Id> {
  const compiled = overrides.map((o) => ({
    covers: rootGlobMatcher(o.files),
    rules: o.rules,
  }));
  const base = (rule: Id): RuleSeverity => ruleSeverity<unknown>(rules[rule]);
  return {
    severityAt: (rule, path) =>
      path === undefined
        ? base(rule)
        : compiled
            .filter((o) => o.covers(path) !== null)
            .reduce<RuleSeverity>((sev, o) => o.rules[rule] ?? sev, base(rule)),
    mayFire: (rule) =>
      base(rule) !== false ||
      compiled.some((o) => (o.rules[rule] ?? false) !== false),
  };
}
