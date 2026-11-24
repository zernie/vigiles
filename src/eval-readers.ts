/**
 * Reading an eval REPORT — the free half of `vigiles/eval`.
 *
 * `vigiles/eval` is the door of the moment you measure: the `paid_*` runners
 * produce a report and these read it. None of them spends anything; the `paid_`
 * prefix, not the door, is what marks a call that can bill you.
 *
 * Folded from eleven helpers to a few (vigiles v50):
 *
 *   - `compare(report, baseline, arm)` — per metric, the gap and whether it
 *     clears the noise floor. Replaces `compareArms`, `improvement`,
 *     `significantlyBeats` and `experimental_verdict` (its `verdict` field).
 *     `compare(before, after)` on two trigger-rate reports — which prompts a
 *     change gained and lost. Replaces `compareContainment`.
 *   - `assertImproves(report, { …, significant: true })` — the gate on that,
 *     replacing `assertSignificant`.
 *   - `assertRates` (in `src/eval-rate-gate.ts`, over the check report of
 *     `src/eval-check-report.ts`) with
 *     `passK: 1` replacing `reliable` / `assertReliable`. Since v52 it also
 *     gates a trigger-rate report, replacing `assertTriggerRate` (the gate
 *     itself is {@link assertTriggerRateReport} here).
 *   - `assertNoRegression(current, { baseline })` — the baseline is a path it
 *     reads (and with `update: true` writes), replacing `readBaseline` /
 *     `writeBaseline` (v52).
 */
import type { EvalReport, TriggerRateReport } from "./core/eval-report.js";
import type { Verdict } from "./core/evidence.js";
import { describeVerdict, flipVerdict } from "./core/evidence.js";
import { experimental_verdict } from "./stats.js";
import {
  diffReports,
  readBaseline,
  writeBaseline,
  type BaselineFile,
  type DiffOptions,
} from "./eval-baseline.js";

function fail(message: string): never {
  throw new Error(message);
}

/**
 * One metric's standing of an arm against its baseline.
 *
 * @public
 */
export interface ArmComparison {
  /**
   * `arm − baseline` on the metric's mean (fraction-true for a 0/1 metric). Raw:
   * a cheaper arm has a negative gap even when `lowerIsBetter` names the
   * metric — read `verdict` for which way it went.
   */
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
   * metric — with the test that produced it. `better` means higher, unless
   * `compare`'s `lowerIsBetter` names the metric.
   */
  readonly verdict: Verdict;
}

/**
 * Which prompts a change moved: two trigger-rate runs of the same prompts
 * (before and after a description edit, or a weaker and a stronger model),
 * compared prompt by prompt. A prompt only one run measured is left out — it
 * says nothing about the change.
 *
 * @public
 */
export interface TriggerDiff {
  /** Prompts both runs measured — the only ones the diff can speak about. */
  readonly compared: number;
  /** Fired AFTER, not before: the change made the skill fire here. */
  readonly gained: readonly string[];
  /** Fired BEFORE, not after: the change broke firing here. */
  readonly lost: readonly string[];
  /** Fired in both runs. */
  readonly both: readonly string[];
  /** Fired in neither run. */
  readonly neither: readonly string[];
}

/* eslint-disable no-redeclare -- TypeScript function overloads (the base
   no-redeclare rule, unlike @typescript-eslint/no-redeclare, flags them) */
/**
 * One reader for "how do these two differ?", by what you hand it:
 *
 * - **An eval report and two arm names** — `arm` against `baseline`, metric by
 *   metric. Only metrics both arms reported appear; an arm the report does not
 *   have throws, because an unknown name is a typo, not an arm that scored
 *   nothing.
 *
 *       const c = compare(report, "vanilla", "gated");
 *       if (c.caught?.significant && c.caught.gap > 0) …
 *
 * - **Two trigger-rate reports** — which prompts the second run gained and lost
 *   against the first ({@link TriggerDiff}).
 *
 *       const { lost } = compare(before, after); // the prompts my edit broke
 *
 *   ⚠️ A diff is as strong as its weakest run. On Claude Code firing is an
 *   observed event; on Codex it is INFERRED (from a `SKILL.md` read), and an
 *   inference error lands exactly where this looks — a prompt wrongly marked
 *   fired in one run and not the other is a `gained`/`lost` entry made of
 *   noise. At one trial per prompt every cell is one observation: read a
 *   handful as evidence and one as a reason to re-run at higher `trials`.
 *
 * @public
 */
export function compare(
  report: EvalReport,
  baseline: string,
  arm: string,
  opts?: {
    /** The significance level (default 0.05). */
    readonly alpha?: number;
    /**
     * Metrics where a DECREASE is the improvement (`cost`, `turns`, latency) —
     * the list `assertNoRegression` takes. Their verdict is read the other way
     * round; `gap` stays `arm − baseline`.
     */
    readonly lowerIsBetter?: readonly string[];
  },
): Readonly<Record<string, ArmComparison>>;
/** @public */
export function compare(
  before: TriggerRateReport,
  after: TriggerRateReport,
): TriggerDiff;
export function compare(
  a: EvalReport | TriggerRateReport,
  b: string | TriggerRateReport,
  arm?: string,
  opts: CompareOptions = {},
): Readonly<Record<string, ArmComparison>> | TriggerDiff {
  if ("perPrompt" in a) {
    if (typeof b === "string")
      fail("compare: a trigger-rate report compares with another one");
    return diffPrompts(a, b);
  }
  if (typeof b !== "string" || arm === undefined) {
    fail("compare: an eval report needs a baseline and an arm name");
  }
  return compareArms(a, { baseline: b, arm }, opts);
}
/* eslint-enable no-redeclare */

/** The options of `compare` over an eval report (spelled inline on the overload). */
interface CompareOptions {
  readonly alpha?: number;
  readonly lowerIsBetter?: readonly string[];
}

/** The two arms a comparison reads, by name. */
interface ArmPair {
  readonly baseline: string;
  readonly arm: string;
}

/** Where `arm` stands against `baseline` on `metric`, read in the metric's direction. */
function directedVerdict(
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

function compareArms(
  report: EvalReport,
  pair: ArmPair,
  opts: CompareOptions,
): Readonly<Record<string, ArmComparison>> {
  const armMetrics = metricsOf(report, pair.arm);
  const baseMetrics = metricsOf(report, pair.baseline);
  const lower = new Set(opts.lowerIsBetter ?? []);
  return Object.fromEntries(
    Object.entries(armMetrics).flatMap(([metric, value]) => {
      const base = baseMetrics[metric];
      if (base === undefined) return [];
      const verdict = directedVerdict(
        report,
        { ...pair, metric },
        { alpha: opts.alpha, lowerIsBetter: lower.has(metric) },
      );
      const significant = verdict.kind === "better" || verdict.kind === "worse";
      return [[metric, { gap: value - base, significant, verdict }]];
    }),
  );
}

function diffPrompts(
  before: TriggerRateReport,
  after: TriggerRateReport,
): TriggerDiff {
  const afterFired = new Map(
    after.perPrompt.map((p) => [p.prompt, p.rate > 0] as const),
  );
  const shared = before.perPrompt.filter((p) => afterFired.has(p.prompt));
  const pick = (
    want: (was: boolean, now: boolean) => boolean,
  ): readonly string[] =>
    shared
      .filter((p) => want(p.rate > 0, afterFired.get(p.prompt) === true))
      .map((p) => p.prompt);
  return {
    compared: shared.length,
    gained: pick((was, now) => !was && now),
    lost: pick((was, now) => was && !now),
    both: pick((was, now) => was && now),
    neither: pick((was, now) => !was && !now),
  };
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
  const a = report.arms[opts.arm]?.metrics[opts.metric];
  const b = report.arms[opts.baseline]?.metrics[opts.metric];
  if (a === undefined || b === undefined) fail(noData(report, opts));
  if (opts.significant === true) {
    assertSignificantGap(report, opts, lowerIsBetter);
    return;
  }
  const by = opts.by ?? 0;
  const delta = lowerIsBetter ? b - a : a - b;
  if (delta <= by) {
    fail(
      `expected ${opts.arm} to beat ${opts.baseline} on ${metricText(opts.metric, lowerIsBetter)} by > ${String(by)}, got ${delta.toFixed(3)}`,
    );
  }
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
  if (v.kind === "unmeasured") fail(noData(report, opts));
  fail(
    `expected ${opts.arm} to significantly beat ${opts.baseline} on ${metricText(opts.metric, lowerIsBetter)} (α=${String(alpha)}); ${describeVerdict(v)}`,
  );
}

/**
 * The options of {@link assertNoRegression}: where the baseline is, and how a
 * move is judged.
 *
 * `baseline` is a PATH (`.vigiles/eval-baseline.json`, read when the gate runs)
 * or an already-parsed {@link BaselineFile}. With a path, `update: true` records
 * the current run there instead of gating — the `jest -u` of evals; run it
 * once, commit the file, and every later run is compared to it. A path with
 * no file and no `update` FAILS: a gate with nothing to compare against would
 * pass every run.
 *
 * @public
 */
export type RegressionGate = DiffOptions &
  (
    | { readonly baseline: string; readonly update?: boolean }
    | { readonly baseline: BaselineFile; readonly update?: undefined }
  );

/**
 * Assert the current run has not *regressed* against a committed baseline — the
 * CI gate. A regression is an arm×metric that moved **significantly in the bad
 * direction** vs. the baseline (Welch t-test, so sampling noise doesn't trip
 * it). Higher is better by default; list `lowerIsBetter` metrics (cost/latency)
 * to flip them. See {@link RegressionGate} for the `baseline` option.
 *
 * @public
 */
export function assertNoRegression(
  current: EvalReport | readonly EvalReport[],
  gate: RegressionGate,
): void {
  const reports: readonly EvalReport[] = isReportList(current)
    ? current
    : [current];
  const baseline = loadBaseline(reports, gate);
  if (baseline === "recorded") return;
  const diff = diffReports(baseline, reports, gate);
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

/** The baseline to gate against, or `"recorded"` when `update` wrote it instead. */
function loadBaseline(
  reports: readonly EvalReport[],
  gate: RegressionGate,
): BaselineFile | "recorded" {
  if (typeof gate.baseline !== "string") return gate.baseline;
  if (gate.update === true) {
    writeBaseline(gate.baseline, reports);
    return "recorded";
  }
  return (
    readBaseline(gate.baseline) ??
    fail(
      `assertNoRegression: no baseline at ${gate.baseline} — record one with \`{ baseline: "${gate.baseline}", update: true }\` and commit it`,
    )
  );
}

function isReportList(
  x: EvalReport | readonly EvalReport[],
): x is readonly EvalReport[] {
  return Array.isArray(x);
}

/**
 * Gate a skill/behaviour's *activation*, over a `TriggerRateReport` from
 * `paid_measureTriggerRate` — reached as `assertRates(report, gate)`. `min`
 * gates recall (fires when it should). With irrelevant prompts measured,
 * `maxFalsePositive` gates the precision side (does NOT fire when it shouldn't)
 * and `minPrecision` gates `firedRight / firedTotal` — so a too-broad
 * description that hijacks unrelated work fails, not just a too-narrow one. A
 * gate with none of the three FAILS: it would pass any report.
 */
export function assertTriggerRateReport(
  report: TriggerRateReport,
  opts: TriggerRateGate,
): void {
  if (
    opts.min === undefined &&
    opts.maxFalsePositive === undefined &&
    opts.minPrecision === undefined
  )
    fail(
      "assertRates: a trigger-rate gate needs `min`, `maxFalsePositive` or `minPrecision` — an empty gate passes anything",
    );
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

/**
 * The options of `assertRates` over a trigger-rate report: recall, false
 * positives, precision.
 *
 * @public
 */
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
