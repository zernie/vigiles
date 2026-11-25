/**
 * The `context-truncation` rule for `lint`: each instruction file the harness
 * loads after launch, against the harness's per-file cut (the detector is
 * core's `checkOnDemandFiles`, which `audit` runs too). Prints one line per
 * file over the cut, annotates it, and returns the counts `lint` sums.
 *
 * No baseline, on purpose: over the cut, rules are lost, not just paid for, so
 * no recorded size may accept such a file. That is the difference from
 * `context-creep`, whose findings are about weight and can be baselined.
 */
import { onDemandRemedy } from "./core/instruction-remedies.js";
import {
  formatOnDemandOver,
  type OnDemandCheck,
} from "./core/on-demand-limits.js";
import type { RuleSeverity } from "./core/types.js";

/** What {@link checkOnDemandLimit} takes. */
export interface OnDemandLimitOptions {
  /** The rule's severity for a file at `path`, with `overrides` applied. */
  readonly severityAt: (path: string) => RuleSeverity;
  /** Whether the rule is on anywhere (in `rules` or some override). */
  readonly mayFire: boolean;
  /** The scanned bundle (`.` = the whole repository); files outside it are not reported. */
  readonly scope: string;
  readonly silent: boolean;
  /** The active harness, named in the n/a line when it does not model the cut. */
  readonly harness: string;
  /** Called only when the rule is on. */
  readonly measure: () => OnDemandCheck;
  readonly annotate: (level: "error" | "warning", message: string) => void;
}

/** The counts `lint` sums. */
export interface OnDemandLimitResult {
  readonly issues: number;
  readonly errors: number;
}

const HEADER = "Context truncation (files loaded after launch):";

/** Whether a repo-relative path is the scanned bundle or inside it. */
const inScope = (path: string, scope: string): boolean =>
  scope === "." || path === scope || path.startsWith(`${scope}/`);

/** One finding per in-scope file over the cut: its path, its line with the fix. */
export interface OnDemandFinding {
  readonly path: string;
  readonly line: string;
}

/** One finding per in-scope file over the cut, the fix appended. */
export function onDemandLimitFindings(
  check: Extract<OnDemandCheck, { kind: "checked" }>,
  scope: string,
): readonly OnDemandFinding[] {
  const cure = onDemandRemedy(check.rule.excludeSetting);
  return check.over
    .filter((f) => inScope(f.path, scope))
    .map((f) => ({
      path: f.path,
      line: `${formatOnDemandOver(f, check)}. ${cure}`,
    }));
}

const NONE: OnDemandLimitResult = { issues: 0, errors: 0 };

/** Loud, never a silent pass: the harness may cut, vigiles does not know where. */
function printNotApplicable(harness: string): void {
  console.log(
    `\n${HEADER}\n\n  – n/a — ${harness} has no modelled per-file cut`,
  );
}

/** A finding at the severity its own path resolves to. */
interface Graded extends OnDemandFinding {
  readonly isError: boolean;
}

/** Each finding at its path's severity; a path where the rule is off drops out. */
function graded(
  findings: readonly OnDemandFinding[],
  severityAt: (path: string) => RuleSeverity,
): readonly Graded[] {
  return findings.flatMap((f) => {
    const severity = severityAt(f.path);
    return severity ? [{ ...f, isError: severity === "error" }] : [];
  });
}

/** Print, annotate and count the graded findings. */
function report(
  found: readonly Graded[],
  opts: OnDemandLimitOptions,
): OnDemandLimitResult {
  if (found.length === 0) return NONE;
  if (!opts.silent) {
    console.log(`\n${HEADER}\n`);
    found.forEach((f) => {
      console.log(`  ${f.isError ? "✗" : "⚠"} ${f.line}`);
    });
  }
  found.forEach((f) => {
    opts.annotate(f.isError ? "error" : "warning", f.line);
  });
  return {
    issues: found.length,
    errors: found.filter((f) => f.isError).length,
  };
}

/** Run the rule for `lint`: measure, grade each file by its path, print, count. */
export function checkOnDemandLimit(
  opts: OnDemandLimitOptions,
): OnDemandLimitResult {
  if (!opts.mayFire) return NONE;
  const check = opts.measure();
  if (check.kind === "not-modelled") {
    if (!opts.silent) printNotApplicable(opts.harness);
    return NONE;
  }
  return report(
    graded(onDemandLimitFindings(check, opts.scope), opts.severityAt),
    opts,
  );
}
