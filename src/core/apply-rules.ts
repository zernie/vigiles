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
 * flip moving the grade.
 *
 * GRADED RULE MODULES. A module in a graded group is SCORED from scan fields it
 * narrows itself (`RuleSpec.scored.narrow`) — the scorers still read named
 * fields until vigiles#390 moves them onto rule results — to the paths the
 * rule fires at, so an off rule, or one an override turns off for a folder,
 * never moves the grade. Its own `findings` (each with a file and a line) go
 * to `findings`, which every renderer prints and the JSON carries: the field
 * scores, the findings locate, and both come from the same detector output.
 * The findings are read off the scan BEFORE the narrow, because a narrow may
 * score less than the rule shows (an import written in one machine's file is
 * linted, never scored); only the per-path answer silences a finding.
 *
 * PER PATH, LIKE `lint`. Every rule module's findings — graded and ungraded —
 * keep only those whose path the rule fires at (`RuleSwitch.firesAt`), the
 * same per-path answer `lint` asks, so an `overrides` entry that turns a rule
 * off for a folder silences `audit` too.
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
  /**
   * Whether `rule` fires for a finding at `path`, relative to the scanned
   * directory — `overrides` can turn a rule off for one folder.
   */
  firesAt(rule: string, path: string): boolean;
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
  /** The graded groups' rule modules that are on, and what each found. */
  readonly findings: readonly RuleResult[];
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
  resultOf: (rule: RuleSpec) => RuleResult,
): readonly UngradedGroup[] {
  return Object.entries(groups)
    .filter(([, g]) => !g.graded)
    .map(([group, g]) => ({
      group,
      label: g.label,
      ...(g.blurb === undefined ? {} : { blurb: g.blurb }),
      rules: rules.filter((r) => r.group === group).map(resultOf),
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
  const firesAt =
    (r: RuleSpec) =>
    (path: string): boolean =>
      on.includes(r) && resolver.firesAt(r.id, path);
  const shownScan = blankOff(rules, on, scan);
  const narrowed = narrowScored(rules, firesAt, shownScan);
  // Findings read the scan BEFORE the scoring narrow: a narrow may score less
  // than the rule prints (an import in one machine's file is shown, never
  // scored), and only the per-path answer below may silence a finding.
  const resultOf = (r: RuleSpec): RuleResult => ({
    rule: r.id,
    findings: (r.findings?.(shownScan) ?? []).filter((f) => firesAt(r)(f.path)),
  });
  return {
    ...narrowed,
    ungraded: ungradedOf(on, groups, resultOf),
    findings: on
      .filter((r) => groups[r.group]?.graded && r.findings !== undefined)
      .map(resultOf),
    [FILTERED]: true as const,
  };
}

/** `scan` with every off rule's legacy scan field emptied. */
function blankOff<S extends object>(
  rules: readonly RuleSpec[],
  on: readonly RuleSpec[],
  scan: S,
): S {
  return rules
    .filter((r) => !on.includes(r))
    .reduce(
      (acc, r) => (r.legacy ? blank(acc, r.legacy.scanField) : acc),
      scan,
    );
}

/** `scan` with each graded module's scored fields narrowed to where it fires. */
function narrowScored<S extends ScanInput>(
  rules: readonly RuleSpec[],
  firesAt: (r: RuleSpec) => (path: string) => boolean,
  scan: S,
): S {
  return rules.reduce(
    (acc, r) =>
      r.scored === undefined
        ? acc
        : { ...acc, ...r.scored.narrow(acc, firesAt(r)) },
    scan,
  );
}

/** The scan a scorer may read: `ungraded` dropped, everything else as is. */
export function gradedView<S extends ScanInput>(
  scan: FilteredScan<S>,
): GradedView<Omit<FilteredScan<S>, "ungraded">> {
  const { ungraded: _shown, ...graded } = scan;
  return graded;
}
