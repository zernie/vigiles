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
  readonly severity: RuleSeverity;
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

/** One finding line per in-scope file over the cut, the fix appended. */
export function onDemandLimitLines(
  check: OnDemandCheck,
  scope: string,
): readonly string[] {
  if (check.kind === "not-modelled") return [];
  const cure = onDemandRemedy(check.rule.excludeSetting);
  return check.over
    .filter((f) => inScope(f.path, scope))
    .map((f) => `${formatOnDemandOver(f, check)}. ${cure}`);
}

const NONE: OnDemandLimitResult = { issues: 0, errors: 0 };

/** Loud, never a silent pass: the harness may cut, vigiles does not know where. */
function printNotApplicable(harness: string): void {
  console.log(
    `\n${HEADER}\n\n  – n/a — ${harness} has no modelled per-file cut`,
  );
}

/** Print, annotate and count the finding lines at one severity. */
function report(
  lines: readonly string[],
  isError: boolean,
  opts: OnDemandLimitOptions,
): OnDemandLimitResult {
  if (lines.length === 0) return NONE;
  const mark = isError ? "✗" : "⚠";
  if (!opts.silent) {
    console.log(`\n${HEADER}\n`);
    lines.forEach((line) => {
      console.log(`  ${mark} ${line}`);
    });
  }
  lines.forEach((line) => {
    opts.annotate(isError ? "error" : "warning", line);
  });
  return { issues: lines.length, errors: isError ? lines.length : 0 };
}

/** Run the rule for `lint`: measure, print, annotate, count. */
export function checkOnDemandLimit(
  opts: OnDemandLimitOptions,
): OnDemandLimitResult {
  if (!opts.severity) return NONE;
  const check = opts.measure();
  if (check.kind === "not-modelled") {
    if (!opts.silent) printNotApplicable(opts.harness);
    return NONE;
  }
  return report(
    onDemandLimitLines(check, opts.scope),
    opts.severity === "error",
    opts,
  );
}
