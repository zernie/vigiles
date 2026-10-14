/**
 * ONE ANSWER TO "IS THIS RULE ON?" FOR EVERYTHING A REPORT SHOWS.
 *
 * `lint` asked the resolver per rule; `audit` did not ask at all, so a rule the
 * repo turned off still printed in the audit (`hand-written-hook`, off by
 * default, listed every hook line vigiles did not write). `applyRules` is the
 * one place a scan meets the resolved config: it blanks what an OFF rule found
 * and mints the {@link FilteredScan} brand that every renderer takes — so a
 * renderer handed a raw scan is a tsc error, not an off rule on screen.
 *
 * Generic machinery: it takes the rule set and the resolver as parameters
 * (`src/rules/` and `../overrides.ts` stay outside core) and names no rule.
 * Which scan field a not-yet-migrated rule's findings sit in is that rule's own
 * declaration (`RuleSpec.legacy.scanField`).
 *
 * ⚠️ SCOPE, stated: only fields that are SHOWN and never scored are blanked
 * today. Blanking a graded field when its rule is off would change a repo's
 * audit score — a product decision, not a refactor — so a rule whose findings
 * feed a ring declares no `scanField` yet.
 */
import type { RuleSpec } from "./rule.js";

/** The part of a rule resolver this needs: whether a rule can fire anywhere. */
export interface RuleSwitch {
  mayFire(rule: string): boolean;
}

/** The brand's key — module-private, so only this file can mint the brand. */
const FILTERED: unique symbol = Symbol("filtered-scan");

/**
 * A scan with the resolved config applied. Minted ONLY by {@link applyRules}
 * (`local/frame-mint` refuses an `as FilteredScan` anywhere else).
 */
export type FilteredScan<S extends object> = S & {
  readonly [FILTERED]: true;
};

/** `scan` with `field` emptied, when that field is a list. */
function blank<S extends object>(scan: S, field: string): S {
  return Array.isArray(Reflect.get(scan, field))
    ? { ...scan, [field]: [] }
    : scan;
}

/**
 * Apply the resolved config to a scan: every rule that cannot fire anywhere
 * has the scan field it declares emptied. Pure; the scan is not mutated.
 */
export function applyRules<S extends object>(
  rules: readonly RuleSpec[],
  resolver: RuleSwitch,
  scan: S,
): FilteredScan<S> {
  const off = rules.filter((r) => !resolver.mayFire(r.id));
  const blanked = off.reduce(
    (acc, r) => (r.legacy ? blank(acc, r.legacy.scanField) : acc),
    scan,
  );
  return { ...blanked, [FILTERED]: true as const };
}
