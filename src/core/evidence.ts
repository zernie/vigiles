/**
 * The arm-vs-baseline verdict for a 0/1 (success/fail) metric, and the Wilson
 * score interval it is built on. Pure: no I/O, no `node:*`.
 *
 * Why not Welch's t-test for a 0/1 metric: when every trial of both arms agrees
 * (3/3 against 0/3) both arms have zero spread, and a t-test has nothing to divide
 * by. Read literally that is "no noise, so any gap is real" — p = 0 on one trial
 * per arm (vigiles#416). Fisher's exact test puts 3/3 vs 0/3 at p = 0.10. The
 * Wilson interval stays honest at the edges: it never collapses to a point at
 * 0 or 1, so three successes in three trials still admit a true rate near 0.44.
 *
 * The rule: an arm is `better` or `worse` only when the two intervals do not
 * overlap. Overlap is `no-signal` — "more trials", not "no effect". Requiring
 * disjoint intervals is stricter than a two-proportion test at the same level;
 * a verdict that is too cautious costs a re-run, one that is too eager costs a
 * shipped regression.
 */

/**
 * A Wilson score interval for k successes in n trials.
 *
 * @public
 */
export interface Interval {
  /** Lower bound of the true success rate, in [0, 1]. */
  readonly lo: number;
  /** Upper bound of the true success rate, in [0, 1]. */
  readonly hi: number;
  /** Successes observed. */
  readonly k: number;
  /** Trials observed. */
  readonly n: number;
}

/**
 * Where an arm stands against its baseline on one metric.
 *
 * @public
 */
export type Verdict =
  /** A 0/1 metric: `better`/`worse` only when the two intervals are disjoint. */
  | {
      readonly kind: "better" | "worse" | "no-signal";
      readonly test: "wilson";
      readonly arm: Interval;
      readonly baseline: Interval;
    }
  /** Any other metric: `better`/`worse` when Welch's p-value is below α. */
  | {
      readonly kind: "better" | "worse" | "no-signal";
      readonly test: "welch";
      readonly delta: number;
      readonly pValue: number;
    }
  /** Nothing to compare: an arm has no trials, or never reported the metric. */
  | {
      readonly kind: "unmeasured";
      readonly why: "no-trials" | "metric-missing";
    };

// Acklam's rational approximation to the inverse standard normal CDF
// (relative error < 1.2e-9), split at the tails.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];
const P_LOW = 0.02425;

/** Evaluate a polynomial with coefficients highest-degree first (Horner). */
const horner = (cs: readonly number[], x: number): number =>
  cs.reduce((acc, c) => acc * x + c, 0);

const tail = (q: number): number => horner(C, q) / (horner(D, q) * q + 1);

/** The standard normal quantile Φ⁻¹(p) for p ∈ (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(
      `normalQuantile: p must be in (0, 1), got ${String(p)}`,
    );
  }
  if (p < P_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - P_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (horner(A, r) * q) / (horner(B, r) * r + 1);
}

/**
 * The Wilson score interval for `k` successes in `n ≥ 1` trials at confidence
 * 1 − α. Bounded to [0, 1] by construction, never a single point.
 */
export function wilson(k: number, n: number, alpha = 0.05): Interval {
  const z = normalQuantile(1 - alpha / 2);
  const z2 = z * z;
  const denom = n + z2;
  const center = (k + z2 / 2) / denom;
  const half = (z / denom) * Math.sqrt((k * (n - k)) / n + z2 / 4);
  return {
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    k,
    n,
  };
}

/** A 0/1 metric's tally for one arm: successes out of trials. */
export interface Tally {
  readonly k: number;
  readonly n: number;
}

/**
 * The verdict for an arm against its baseline on a 0/1 metric: `better` or
 * `worse` only when the two Wilson intervals are disjoint, else `no-signal`.
 */
export function proportionVerdict(
  arm: Tally,
  baseline: Tally,
  alpha = 0.05,
): Verdict {
  if (arm.n === 0 || baseline.n === 0) {
    return { kind: "unmeasured", why: "no-trials" };
  }
  const a = wilson(arm.k, arm.n, alpha);
  const b = wilson(baseline.k, baseline.n, alpha);
  const intervals = { test: "wilson", arm: a, baseline: b } as const;
  if (a.lo > b.hi) return { kind: "better", ...intervals };
  if (a.hi < b.lo) return { kind: "worse", ...intervals };
  return { kind: "no-signal", ...intervals };
}

const FLIPPED = {
  better: "worse",
  worse: "better",
  "no-signal": "no-signal",
} as const;

/**
 * The verdict for a metric where LOWER is better (cost, turns, latency): the
 * same test and numbers, with `better` and `worse` swapped. Both tests decide
 * on `arm − baseline > 0`, which reads a cheaper arm as a loss unless the
 * caller says which way the metric points.
 */
export function flipVerdict(v: Verdict): Verdict {
  return v.kind === "unmeasured" ? v : { ...v, kind: FLIPPED[v.kind] };
}

const pct = (x: number): string => x.toFixed(2);
const tally = (i: Interval): string =>
  `${String(i.k)}/${String(i.n)} [${pct(i.lo)}, ${pct(i.hi)}]`;
const LABEL = {
  better: "BETTER",
  worse: "WORSE",
  "no-signal": "NO SIGNAL",
} as const;

/** One line a person reads: the verdict and the numbers it rests on. */
export function describeVerdict(v: Verdict): string {
  if (v.kind === "unmeasured") return `UNMEASURED (${v.why})`;
  const why =
    v.test === "wilson"
      ? `${tally(v.arm)} vs ${tally(v.baseline)}, Wilson`
      : `Δ=${v.delta.toFixed(3)}, p=${v.pValue.toFixed(3)}, Welch`;
  const hint = v.kind === "no-signal" ? " — raise trials" : "";
  return `${LABEL[v.kind]} (${why})${hint}`;
}
