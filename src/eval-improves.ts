/**
 * `assertImproves` — the gate on one metric of an A/B: `arm` beats `baseline`
 * by a margin, or beyond the computed noise floor, in the direction the metric
 * points. Pure: it reads a finished report and throws; it never runs anything.
 *
 * Its own module (out of `eval-readers.ts`) because metric DIRECTION lives
 * here: {@link directedVerdict} is the one place a verdict is read the other
 * way round for a lower-is-better metric, and `compare` reads it from here too.
 */
import type { EvalReport } from "./core/eval-report.js";
import { describeVerdict, flipVerdict, type Verdict } from "./core/evidence.js";
import { experimental_verdict } from "./stats.js";

function fail(message: string): never {
  throw new Error(message);
}

/** The two arms a comparison reads, by name. */
export interface ArmPair {
  readonly baseline: string;
  readonly arm: string;
}

/** Where `arm` stands against `baseline` on `metric`, read in the metric's direction. */
export function directedVerdict(
  report: EvalReport,
  pair: ArmPair & { readonly metric: string },
  opts: { readonly alpha?: number; readonly lowerIsBetter: boolean },
): Verdict {
  const v = experimental_verdict(
    report,
    pair.baseline,
    pair.arm,
    pair.metric,
    opts.alpha,
  );
  return opts.lowerIsBetter ? flipVerdict(v) : v;
}

/**
 * Assert `arm` beats `baseline` on `metric`. By default a positive gap > `by`
 * (pass the combined se to clear the noise floor by hand). With
 * `{ significant: true }` the verdict must be `better` instead — the computed
 * noise floor: a 0/1 metric needs disjoint Wilson intervals (3/3 against 0/3 is
 * not enough — raise `trials`), any other a Welch gap at `alpha`. With
 * `lowerIsBetter: true` (cost, turns) beating means LOWER: the gap that must
 * exceed `by` is `baseline − arm`, and the verdict is read the other way round.
 *
 * Takes the report of either scoring: a run scored with `checks` has one 0/1
 * metric per check, named by its label (`report.checks` lists them).
 *
 * @public
 */
export function assertImproves(report: EvalReport, opts: ImprovesGate): void {
  const lowerIsBetter = directionOf(opts);
  const a = metricOf(report, opts.arm, opts.metric);
  const b = metricOf(report, opts.baseline, opts.metric);
  if (a === undefined || b === undefined) fail(noData(report, opts));
  if (opts.significant === true)
    assertSignificantGap(report, opts, lowerIsBetter);
  else assertGap(lowerIsBetter ? b - a : a - b, opts, lowerIsBetter);
}

/** An arm's mean on a metric, or undefined when the arm or the metric is absent. */
function metricOf(
  report: EvalReport,
  arm: string,
  metric: string,
): number | undefined {
  const found = Object.entries(report.arms).find(([n]) => n === arm);
  return found?.[1].metrics[metric];
}

/** The plain-gap form: `delta` (already in the metric's direction) must exceed `by`. */
function assertGap(
  delta: number,
  opts: ImprovesGate,
  lowerIsBetter: boolean,
): void {
  const by = opts.by ?? 0;
  if (delta > by) return;
  fail(
    `expected ${opts.arm} to beat ${opts.baseline} on ${metricText(opts.metric, lowerIsBetter)} by > ${String(by)}, got ${delta.toFixed(3)}`,
  );
}

/**
 * The gate's direction. A list here is the `DiffOptions` shape copied over, and
 * reading it as truthy would flip a metric it may not name — so it is refused.
 */
function directionOf(opts: ImprovesGate): boolean {
  const v: unknown = opts.lowerIsBetter;
  if (v === undefined || typeof v === "boolean") return v === true;
  return fail(
    `assertImproves: \`lowerIsBetter\` is true or false here — the gate reads one metric (${opts.metric}). The list form belongs to \`compare\` and \`assertNoRegression\`.`,
  );
}

const metricText = (metric: string, lowerIsBetter: boolean): string =>
  lowerIsBetter ? `${metric} (lower is better)` : metric;

/**
 * The options of {@link assertImproves}.
 *
 * @public
 */
export interface ImprovesGate {
  readonly baseline: string;
  readonly arm: string;
  readonly metric: string;
  /**
   * The gap must exceed this (default 0): `arm − baseline`, or
   * `baseline − arm` with `lowerIsBetter`. Ignored with `significant`.
   */
  readonly by?: number;
  /** Demand the verdict `better` — the computed noise floor — instead of a gap. */
  readonly significant?: boolean;
  /** The significance level for `significant` (default 0.05). */
  readonly alpha?: number;
  /**
   * `true` when a DECREASE of `metric` is the improvement (cost, turns,
   * latency). Default false: higher is better. The name `assertNoRegression`
   * uses; a boolean here because this gate reads one metric.
   */
  readonly lowerIsBetter?: boolean;
}

/** No data for the gate, naming the metrics the arm has (a check's label is easy to mistype). */
function noData(report: EvalReport, o: ImprovesGate): string {
  const known = Object.keys(report.arms[o.arm]?.metrics ?? {});
  const have = known.length === 0 ? "" : ` (${o.arm} has: ${known.join(", ")})`;
  return `no data to compare ${o.arm} vs ${o.baseline} on ${o.metric}${have}`;
}

function assertSignificantGap(
  report: EvalReport,
  opts: ImprovesGate,
  lowerIsBetter: boolean,
): void {
  const alpha = opts.alpha ?? 0.05;
  const v = directedVerdict(report, opts, { alpha, lowerIsBetter });
  if (v.kind === "better") return;
  fail(
    `expected ${opts.arm} to significantly beat ${opts.baseline} on ${metricText(opts.metric, lowerIsBetter)} (α=${String(alpha)}); ${describeVerdict(v)}`,
  );
}
