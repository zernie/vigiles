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
 * Generic machinery: it takes the rule set, the groups and the resolver as
 * parameters (`src/rules/` and `../overrides.ts` stay outside core) and names no
 * rule and no group. Which scan field a not-yet-migrated rule's findings sit in
 * is that rule's own declaration (`RuleSpec.legacy.scanField`); a migrated
 * rule's findings come from its own `findings`.
 *
 * UNGRADED GROUPS. A rule in a group with `graded: false` is shown and never
 * scored: its findings go to `ungraded`, one block per group, headed by the
 * group's own `label`/`blurb`. A scorer takes a {@link GradedView}, which has no
 * `ungraded` — so handing one the filtered scan is a tsc error, not a coin
 * flip moving the grade. (A migrated rule in a GRADED group would need its
 * findings to reach the scorers; none exists yet, and `src/rules/index.test.ts`
 * fails the day one does, until vigiles#390 wires it.)
 *
 * ⚠️ SCOPE, stated: only fields that are SHOWN and never scored are blanked
 * today. Blanking a graded field when its rule is off would change a repo's
 * audit score — a product decision, not a refactor — so a rule whose findings
 * feed a ring declares no `scanField` yet.
 */
import type { Finding, RuleGroups, RuleSpec, ScanInput } from "./rule.js";

/** The part of a rule resolver this needs: whether a rule can fire anywhere. */
export interface RuleSwitch {
  mayFire(rule: string): boolean;
}

/** The brand's key — module-private, so only this file can mint the brand. */
const FILTERED: unique symbol = Symbol("filtered-scan");

/** One rule that is on, and everything it found (possibly nothing). */
export interface RuleResult {
  readonly rule: string;
  readonly findings: readonly Finding[];
}

/** An ungraded group's block: its label and the rules of it that are on. */
export interface UngradedGroup {
  readonly group: string;
  readonly label: string;
  readonly blurb?: string;
  readonly rules: readonly RuleResult[];
}

/**
 * A scan with the resolved config applied. Minted ONLY by {@link applyRules}
 * (`local/frame-mint` refuses an `as FilteredScan` anywhere else).
 */
export type FilteredScan<S extends object> = S & {
  readonly [FILTERED]: true;
  /** Only a renderer reads this (`no-restricted-syntax` in the scorers). */
  readonly ungraded: readonly UngradedGroup[];
};

/** What a scorer takes: a scan that carries no ungraded findings. */
export type GradedView<S extends object> = S & { readonly ungraded?: never };

/** `scan` with `field` emptied, when that field is a list. */
function blank<S extends object>(scan: S, field: string): S {
  return Array.isArray(Reflect.get(scan, field))
    ? { ...scan, [field]: [] }
    : scan;
}

/** The ungraded groups' blocks: each group that has a rule on, in order. */
function ungradedOf(
  rules: readonly RuleSpec[],
  groups: RuleGroups,
  scan: ScanInput,
): readonly UngradedGroup[] {
  return Object.entries(groups)
    .filter(([, g]) => !g.graded)
    .map(([group, g]) => ({
      group,
      label: g.label,
      ...(g.blurb === undefined ? {} : { blurb: g.blurb }),
      rules: rules
        .filter((r) => r.group === group)
        .map((r) => ({ rule: r.id, findings: r.findings?.(scan) ?? [] })),
    }))
    .filter((g) => g.rules.length > 0);
}

/**
 * Apply the resolved config to a scan: every rule that cannot fire anywhere
 * has the scan field it declares emptied, and the ungraded groups' rules that
 * are on report into `ungraded`. Pure; the scan is not mutated.
 */
export function applyRules<S extends ScanInput>(
  rules: readonly RuleSpec[],
  groups: RuleGroups,
  resolver: RuleSwitch,
  scan: S,
): FilteredScan<S> {
  const on = rules.filter((r) => resolver.mayFire(r.id));
  const blanked = rules
    .filter((r) => !on.includes(r))
    .reduce(
      (acc, r) => (r.legacy ? blank(acc, r.legacy.scanField) : acc),
      scan,
    );
  return {
    ...blanked,
    ungraded: ungradedOf(on, groups, scan),
    [FILTERED]: true as const,
  };
}

/** The scan a scorer may read: `ungraded` dropped, everything else as is. */
export function gradedView<S extends ScanInput>(
  scan: FilteredScan<S>,
): GradedView<Omit<FilteredScan<S>, "ungraded">> {
  const { ungraded: _shown, ...graded } = scan;
  return graded;
}
