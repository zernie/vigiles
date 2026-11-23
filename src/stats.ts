/**
 * vigiles — significance testing for eval A/B arms.
 *
 * The eval tier already reports mean ± se per arm; this answers the question that
 * `assertImproves(..., { by: se })` punted to the user: is the gap between two
 * arms real, or noise? A Welch's t-test over the per-arm summary stats (mean, se,
 * n) — no raw rows needed — yields a two-sided p-value and a significance verdict.
 * Pure + model-free, so it's fully unit-tested against known t-table values.
 *
 * A 0/1 metric is not judged here by the t-test: `verdictOf` sends it to the
 * Wilson interval (`core/evidence.ts`), because with every trial agreeing both
 * arms have zero spread and the t-test has nothing to divide by (vigiles#416).
 * Welch's test stays the verdict for every other metric. The numerics (log-gamma, incomplete beta) are specialized to the argument range
 * these tests produce (a, b ≥ 0.5; x ∈ (0,1)); they are not a general library.
 */
import type { EvalReport, MetricStat } from "./eval.js";
import { proportionVerdict, type Verdict } from "./core/evidence.js";

// Lanczos coefficients (g = 7) for log-gamma; sufficient for the beta args here.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Log-gamma via Lanczos. Valid for x ≥ 0.5 (all args used below satisfy this). */
function lgamma(x: number): number {
  const g = 7;
  const xm1 = x - 1;
  const base = LANCZOS.reduce(
    (acc, c, i) => acc + c / (xm1 + i + 1),
    0.99999999999980993,
  );
  const tt = xm1 + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (xm1 + 0.5) * Math.log(tt) -
    tt +
    Math.log(base)
  );
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 1e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 / (1 - (qab * x) / qap);
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) ∈ [0, 1]. */
export function regularizedIncompleteBeta(
  a: number,
  b: number,
  x: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lgamma(a + b) -
      lgamma(a) -
      lgamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function tPValueTwoSided(t: number, df: number): number {
  if (df <= 0) return 1;
  return regularizedIncompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/** The verdict on one arm-vs-baseline comparison for a single metric. */
export interface Comparison {
  /** mean(arm) − mean(baseline). */
  readonly delta: number;
  /** Combined standard error of the difference. */
  readonly seDelta: number;
  /** Welch t statistic (delta / seDelta). */
  readonly t: number;
  /** Welch–Satterthwaite degrees of freedom. */
  readonly df: number;
  /** Two-sided p-value for the difference. */
  readonly pValue: number;
  /** p < alpha — the difference is unlikely to be noise. */
  readonly significant: boolean;
}

type Summary = {
  readonly mean: number;
  readonly se: number;
  readonly n: number;
};

// Variance contribution of one arm to the Welch df denominator. Guarded by v > 0
// (se > 0 ⇒ n ≥ 2, so n − 1 ≥ 1); a deterministic arm (se = 0) contributes 0.
const dfTerm = (v: number, n: number): number =>
  v > 0 ? (v * v) / (n - 1) : 0;

/** Welch's unequal-variance t-test between two arms' summary stats. */
export function welchTTest(
  arm: Summary,
  baseline: Summary,
  alpha = 0.05,
): Comparison {
  const delta = arm.mean - baseline.mean;
  const va = arm.se ** 2;
  const vb = baseline.se ** 2;
  const seDelta = Math.sqrt(va + vb);
  if (Math.min(arm.n, baseline.n) < 2) {
    // One trial on a side has no spread to measure: nothing here is evidence.
    return { delta, seDelta, t: 0, df: 0, pValue: 1, significant: false };
  }
  if (seDelta === 0) {
    // Both arms repeated one value over n ≥ 2 trials: the difference, if any,
    // is exact. (A 0/1 metric never reaches here through `verdictOf`.)
    const significant = delta !== 0;
    return {
      delta,
      seDelta,
      t: 0,
      df: 0,
      pValue: significant ? 0 : 1,
      significant,
    };
  }
  const t = delta / seDelta;
  const df = (va + vb) ** 2 / (dfTerm(va, arm.n) + dfTerm(vb, baseline.n));
  const pValue = tPValueTwoSided(t, df);
  return { delta, seDelta, t, df, pValue, significant: pValue < alpha };
}

/**
 * Compare two arms on a metric using their reported summary stats, or null if
 * either arm/metric is absent. The grounded form of `assertImproves`'s `by`: it
 * computes the noise floor instead of asking the caller to supply it.
 */
export function compareArms(
  report: EvalReport,
  baseline: string,
  arm: string,
  metric: string,
  alpha = 0.05,
): Comparison | null {
  const a = report.arms[arm]?.stats[metric];
  const b = report.arms[baseline]?.stats[metric];
  if (!a || !b) return null;
  return compareStats(a, b, alpha);
}

/**
 * Welch's numbers for two summaries, with `significant` taken from
 * {@link verdictOf} — so a `Comparison` never calls a difference significant
 * that the verdict calls `no-signal` (3/3 against 0/3 on a 0/1 metric). For a
 * 0/1 metric the decision is the Wilson verdict; `pValue` stays Welch's.
 */
export function compareStats(
  arm: MetricStat,
  baseline: MetricStat,
  alpha = 0.05,
): Comparison {
  const kind = verdictOf(arm, baseline, alpha).kind;
  return {
    ...welchTTest(arm, baseline, alpha),
    significant: kind === "better" || kind === "worse",
  };
}

// Values of a 0/1 metric sum to an integer k, and among all [0, 1]-valued samples
// with that mean only the 0/1 one reaches the Bernoulli spread — so the summary
// identifies a 0/1 metric exactly when its values stay in [0, 1].
const EPS = 1e-9;

/** The success count of a metric whose every trial scored 0 or 1, else null. */
export function bernoulliCount(stat: MetricStat): number | null {
  const { mean, std, n } = stat;
  if (n < 1 || mean < 0 || mean > 1) return null;
  const k = Math.round(mean * n);
  if (Math.abs(mean * n - k) > EPS) return null;
  const spread = n > 1 ? Math.sqrt((k * (n - k)) / (n * (n - 1))) : 0;
  return Math.abs(std - spread) <= EPS ? k : null;
}

/**
 * The verdict for one arm against a baseline on one metric's summary: disjoint
 * Wilson intervals for a 0/1 metric, Welch's test at `alpha` for any other.
 */
export function verdictOf(
  arm: MetricStat,
  baseline: MetricStat,
  alpha = 0.05,
): Verdict {
  if (arm.n === 0 || baseline.n === 0) {
    return { kind: "unmeasured", why: "no-trials" };
  }
  const ka = bernoulliCount(arm);
  const kb = bernoulliCount(baseline);
  if (ka !== null && kb !== null) {
    return proportionVerdict(
      { k: ka, n: arm.n },
      { k: kb, n: baseline.n },
      alpha,
    );
  }
  const c = welchTTest(arm, baseline, alpha);
  const welch = { test: "welch", delta: c.delta, pValue: c.pValue } as const;
  if (!c.significant) return { kind: "no-signal", ...welch };
  return { kind: c.delta > 0 ? "better" : "worse", ...welch };
}

/**
 * **Experimental.** Where `arm` stands against `baseline` on `metric` in an eval
 * report: `better`, `worse`, `no-signal` (more trials needed), or `unmeasured`
 * when either arm never reported the metric. A 0/1 metric is judged by disjoint
 * Wilson intervals, so 3/3 against 0/3 is `no-signal`; any other metric by
 * Welch's t-test. `assertSignificant` and `significantlyBeats` read this verdict.
 *
 * @experimental The verdict shape (`Verdict`) is days old; see docs/experimental.md.
 */
export function experimental_verdict(
  report: EvalReport,
  baseline: string,
  arm: string,
  metric: string,
  alpha = 0.05,
): Verdict {
  const a = report.arms[arm]?.stats[metric];
  const b = report.arms[baseline]?.stats[metric];
  if (!a || !b) return { kind: "unmeasured", why: "metric-missing" };
  return verdictOf(a, b, alpha);
}
