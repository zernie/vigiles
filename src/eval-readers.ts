/**
 * Reading an eval REPORT — the free half of `vigiles/eval`.
 *
 * `vigiles/eval` is the door of the moment you measure: the `paid_*` runners
 * produce a report and these read it. None of them spends anything; the `paid_`
 * prefix, not the door, is what marks a call that can bill you.
 *
 * Folded from eleven helpers to a few (vigiles v49):
 *
 *   - `compare(report, baseline, arm)` — per metric, the gap and whether it
 *     clears the noise floor. Replaces `compareArms`, `improvement`,
 *     `significantlyBeats` and `experimental_verdict` (its `verdict` field).
 *   - `assertImproves(report, { …, significant: true })` — the gate on that,
 *     replacing `assertSignificant`.
 *   - `assertRates` (in `src/eval.ts`, beside the check report it reads) with
 *     `passK: 1` replacing `reliable` / `assertReliable`.
 *   - `assertTriggerRate`, `assertNoRegression` + `readBaseline` /
 *     `writeBaseline` — unchanged.
 */
import type { EvalReport, TriggerRateReport } from "./core/eval-report.js";
import type { Verdict } from "./core/evidence.js";
import { describeVerdict } from "./core/evidence.js";
import { experimental_verdict } from "./stats.js";
import {
  diffReports,
  type BaselineFile,
  type DiffOptions,
} from "./eval-baseline.js";

function fail(message: string): never {
  throw new Error(message);
}

/** One metric's standing of an arm against its baseline. */
export interface ArmComparison {
  /** `arm − baseline` on the metric's mean (fraction-true for a 0/1 metric). */
  readonly gap: number;
  /**
   * The gap is beyond the noise floor, in either direction: disjoint Wilson
   * intervals for a 0/1 metric, Welch's test at `alpha` for any other. A
   * significant LOSS is `significant` with a negative `gap`.
   */
  readonly significant: boolean;
  /**
   * The verdict behind `significant` — `better`, `worse`, `no-signal` (more
   * trials needed), or `unmeasured` when an arm kept no per-trial stats for the
   * metric — with the test that produced it.
   */
  readonly verdict: Verdict;
}

/**
 * Compare `arm` against `baseline`, metric by metric. Only metrics both arms
 * reported appear; an arm the report does not have throws, because an unknown
 * name is a typo, not an arm that scored nothing.
 *
 *   const c = compare(report, "vanilla", "gated");
 *   if (c.caught?.significant && c.caught.gap > 0) …
 */
export function compare(
  report: EvalReport,
  baseline: string,
  arm: string,
  opts: { readonly alpha?: number } = {},
): Readonly<Record<string, ArmComparison>> {
  const armMetrics = metricsOf(report, arm);
  const baseMetrics = metricsOf(report, baseline);
  return Object.fromEntries(
    Object.entries(armMetrics).flatMap(([metric, value]) => {
      const base = baseMetrics[metric];
      if (base === undefined) return [];
      const verdict = experimental_verdict(
        report,
        baseline,
        arm,
        metric,
        opts.alpha,
      );
      const significant = verdict.kind === "better" || verdict.kind === "worse";
      return [[metric, { gap: value - base, significant, verdict }]];
    }),
  );
}

/** An arm's metric means, or a loud error naming the arms the report does have. */
function metricsOf(
  report: EvalReport,
  arm: string,
): Readonly<Record<string, number>> {
  const found = report.arms[arm];
  if (found === undefined) {
    fail(
      `compare: no arm "${arm}" in report "${report.name}" (arms: ${Object.keys(report.arms).join(", ")})`,
    );
  }
  return found.metrics;
}

/**
 * Assert `arm` beats `baseline` on `metric`. By default a positive gap > `by`
 * (pass the combined se to clear the noise floor by hand). With
 * `{ significant: true }` the verdict must be `better` instead — the computed
 * noise floor: a 0/1 metric needs disjoint Wilson intervals (3/3 against 0/3 is
 * not enough — raise `trials`), any other a Welch gap at `alpha`.
 */
export function assertImproves(report: EvalReport, opts: ImprovesGate): void {
  const a = report.arms[opts.arm]?.metrics[opts.metric];
  const b = report.arms[opts.baseline]?.metrics[opts.metric];
  if (a === undefined || b === undefined) fail(noData(opts));
  if (opts.significant === true) {
    assertSignificantGap(report, opts);
    return;
  }
  const by = opts.by ?? 0;
  const delta = a - b;
  if (delta <= by) {
    fail(
      `expected ${opts.arm} to beat ${opts.baseline} on ${opts.metric} by > ${String(by)}, got ${delta.toFixed(3)}`,
    );
  }
}

/** The options of {@link assertImproves}. */
export interface ImprovesGate {
  readonly baseline: string;
  readonly arm: string;
  readonly metric: string;
  /** The gap must exceed this (default 0). Ignored with `significant`. */
  readonly by?: number;
  /** Demand the verdict `better` — the computed noise floor — instead of a gap. */
  readonly significant?: boolean;
  /** The significance level for `significant` (default 0.05). */
  readonly alpha?: number;
}

const noData = (o: ImprovesGate): string =>
  `no data to compare ${o.arm} vs ${o.baseline} on ${o.metric}`;

function assertSignificantGap(report: EvalReport, opts: ImprovesGate): void {
  const alpha = opts.alpha ?? 0.05;
  const v = experimental_verdict(
    report,
    opts.baseline,
    opts.arm,
    opts.metric,
    alpha,
  );
  if (v.kind === "better") return;
  if (v.kind === "unmeasured") fail(noData(opts));
  fail(
    `expected ${opts.arm} to significantly beat ${opts.baseline} on ${opts.metric} (α=${String(alpha)}); ${describeVerdict(v)}`,
  );
}

/**
 * Assert the current run has not *regressed* against a committed baseline — the
 * CI gate. A regression is an arm×metric that moved **significantly in the bad
 * direction** vs. `baseline` (Welch t-test, so sampling noise doesn't trip it).
 * Higher is better by default; list `lowerIsBetter` metrics (cost/latency) to
 * flip them. Load the baseline with `readBaseline(path)` and record a fresh one
 * with `writeBaseline(path, reports)`.
 */
export function assertNoRegression(
  current: EvalReport | readonly EvalReport[],
  baseline: BaselineFile,
  opts?: DiffOptions,
): void {
  const reports: readonly EvalReport[] = isReportList(current)
    ? current
    : [current];
  const diff = diffReports(baseline, reports, opts);
  if (!diff.passed) {
    const detail = diff.regressions
      .map(
        (r) =>
          `${r.report}/${r.arm}/${r.metric} Δ=${r.comparison.delta.toFixed(3)} p=${r.comparison.pValue.toFixed(3)}`,
      )
      .join("; ");
    fail(`regression vs baseline: ${detail}`);
  }
}

function isReportList(
  x: EvalReport | readonly EvalReport[],
): x is readonly EvalReport[] {
  return Array.isArray(x);
}

/**
 * Assert a skill/behaviour triggered reliably — the gate for a skill's
 * *activation*, over a `TriggerRateReport` from `paid_measureTriggerRate`.
 * `min` gates recall (fires when it should). With irrelevant prompts measured,
 * `maxFalsePositive` gates the precision side (does NOT fire when it shouldn't)
 * and `minPrecision` gates `firedRight / firedTotal` — so a too-broad
 * description that hijacks unrelated work fails, not just a too-narrow one.
 */
export function assertTriggerRate(
  report: TriggerRateReport,
  opts: TriggerRateGate,
): void {
  if (opts.min !== undefined && report.rate < opts.min) {
    fail(
      `expected a trigger rate ≥ ${String(opts.min)}, got ${report.rate.toFixed(2)} (${String(report.n)} runs)`,
    );
  }
  const fp = report.falsePositiveRate ?? 0;
  if (opts.maxFalsePositive !== undefined && fp > opts.maxFalsePositive) {
    fail(
      `expected a false-positive rate ≤ ${String(opts.maxFalsePositive)}, got ${fp.toFixed(2)}`,
    );
  }
  if (opts.minPrecision !== undefined)
    assertPrecision(report, opts.minPrecision);
}

/** The options of {@link assertTriggerRate}: recall, false positives, precision. */
export interface TriggerRateGate {
  readonly min?: number;
  readonly maxFalsePositive?: number;
  readonly minPrecision?: number;
}

function assertPrecision(report: TriggerRateReport, min: number): void {
  if ((report.precision ?? 0) >= min) return;
  fail(
    `expected precision ≥ ${String(min)}, got ${report.precision === undefined ? "n/a (nothing fired)" : report.precision.toFixed(2)}`,
  );
}
