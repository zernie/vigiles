/**
 * `assertRates` — the scored gate over a check, eval or trigger-rate report.
 * Pure: it reads a finished report and throws; it never runs anything.
 */
import type { CheckJSON } from "./check.js";
import type { EvalReport, TriggerRateReport } from "./core/eval-report.js";
import {
  assertTriggerRateReport,
  type TriggerRateGate,
} from "./eval-readers.js";
import {
  checkLabel,
  type CheckRate,
  type CheckReport,
} from "./eval-check-report.js";

/**
 * The min rate a check must clear: its per-KIND override in `per`, else the
 * default `min`.
 */
function checkRateThreshold(
  check: CheckJSON,
  min: number,
  per?: Readonly<Record<string, number>>,
): number {
  return per?.[check.kind] ?? min;
}

/**
 * The threshold half of an {@link assertRates} gate: an average floor (`min`),
 * the every-trial floor (`passK: 1`, τ-bench pass^k), or both. At least one —
 * a gate with neither would pass anything.
 *
 * @public
 */
export type RateGate =
  | { readonly min: number; readonly passK?: 1 }
  | { readonly min?: number; readonly passK: 1 };

/**
 * {@link assertRates} over a check report: every check, `per` overriding `min` by check kind.
 *
 * @public
 */
export type CheckRateGate = RateGate & {
  readonly per?: Readonly<Record<string, number>>;
};

/**
 * {@link assertRates} over one arm × metric of an eval report.
 *
 * @public
 */
export type ArmRateGate = RateGate & {
  readonly arm: string;
  readonly metric: string;
};

/**
 * The scored gate: throw if a measured rate is below its threshold — the
 * `paid_measure` counterpart to `assertChecks` (strict). Reads the rate, not a
 * single run, so it never trips on one noisy trial.
 *
 * Over a {@link CheckReport}: `min` is the default threshold for every check,
 * and `per` overrides it for a check KIND (e.g. `{ min: 0.8, per: { skill: 1.0 } }`
 * — "every check ≥ 80%, but the skill must FIRE on every trial"). `passK: 1`
 * demands every check passed on EVERY trial — "worked every time", not "on
 * average".
 *
 * Over an {@link EvalReport}: name the `arm` and `metric`; `min` gates the
 * metric's mean, `passK: 1` that it succeeded on every trial.
 *
 * Over a {@link TriggerRateReport} (`paid_measureTriggerRate`): `min` gates
 * recall, `maxFalsePositive` and `minPrecision` the precision side — see
 * {@link TriggerRateGate}. Replaces `assertTriggerRate` (v52).
 */
/* eslint-disable no-redeclare -- TypeScript function overloads (the base
   no-redeclare rule, unlike @typescript-eslint/no-redeclare, flags them) */
/** @public */
export function assertRates(report: CheckReport, opts: CheckRateGate): void;
/** @public */
export function assertRates(report: EvalReport, opts: ArmRateGate): void;
/** @public */
export function assertRates(
  report: TriggerRateReport,
  opts: TriggerRateGate,
): void;
export function assertRates(
  report: CheckReport | EvalReport | TriggerRateReport,
  opts: CheckRateGate | ArmRateGate | TriggerRateGate,
): void {
  if ("perPrompt" in report) assertTriggerRateReport(report, opts);
  else if ("perCheck" in report) assertCheckRates(report, opts);
  else if ("arm" in opts) assertArmRate(report, opts);
  else throw new Error("assertRates: an eval report needs `arm` and `metric`");
}
/* eslint-enable no-redeclare */

/** The fields {@link assertCheckRates} reads; the overloads pair a check report with a {@link CheckRateGate}. */
interface CheckGateFields {
  readonly min?: number;
  readonly passK?: 1;
  readonly per?: Readonly<Record<string, number>>;
}

function assertCheckRates(report: CheckReport, opts: CheckGateFields): void {
  // An empty report gates nothing — a green that tested NOTHING (the silent-pass
  // the no-silent-skips rule forbids). Fail loudly instead of vacuously passing.
  if (report.perCheck.length === 0) {
    throw new Error(
      "assertRates: the report has no checks to gate — did you call " +
        "`measure({ checks: [...] })` with an empty list? An empty gate is a silent pass.",
    );
  }
  const thresholdFor = (c: CheckRate): number =>
    checkRateThreshold(c.check, opts.min ?? 0, opts.per);
  const below = report.perCheck.filter((c) => c.rate < thresholdFor(c));
  if (below.length > 0) {
    throw new Error(
      `${String(below.length)} check(s) below their min rate:\n` +
        below
          .map(
            (c) =>
              `  ✗ ${checkLabel(c.check)}: ${(c.rate * 100).toFixed(0)}% ± ${(c.se * 100).toFixed(0)}% (min ${(thresholdFor(c) * 100).toFixed(0)}%)`,
          )
          .join("\n"),
    );
  }
  if (opts.passK !== 1) return;
  const flaky = report.perCheck.filter((c) => c.passK !== 1);
  if (flaky.length > 0) {
    throw new Error(
      `${String(flaky.length)} check(s) did not pass on every trial (pass^k = 1 required):\n` +
        flaky
          .map(
            (c) =>
              `  ✗ ${checkLabel(c.check)}: passed ${(c.rate * 100).toFixed(0)}% of ${String(c.n)} trials`,
          )
          .join("\n"),
    );
  }
}

function assertArmRate(report: EvalReport, opts: ArmRateGate): void {
  const stat = report.arms[opts.arm]?.stats[opts.metric];
  const mean = report.arms[opts.arm]?.metrics[opts.metric];
  if (stat === undefined || mean === undefined) {
    throw new Error(
      `assertRates: no data for ${opts.arm} on ${opts.metric} in report "${report.name}"`,
    );
  }
  if (opts.min !== undefined && mean < opts.min) {
    throw new Error(
      `expected ${opts.arm} ≥ ${String(opts.min)} on ${opts.metric}, got ${String(mean)}`,
    );
  }
  if (opts.passK === 1 && stat.passK !== 1) {
    throw new Error(
      `expected ${opts.arm} to pass ${opts.metric} on every trial (pass^k=1), got pass^k=${String(stat.passK)}`,
    );
  }
}
