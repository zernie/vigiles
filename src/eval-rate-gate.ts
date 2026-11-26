/**
 * `assertRates` — the scored gate over an eval or trigger-rate report.
 * Pure: it reads a finished report and throws; it never runs anything.
 */
import type {
  ArmReport,
  CheckJSON,
  EvalReport,
  TriggerRateReport,
} from "./core/eval-report.js";
import {
  assertTriggerRateReport,
  type TriggerRateGate,
} from "./eval-readers.js";

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
 * {@link assertRates} over an eval report: one arm — `arm`, which may be left
 * out when the report has only one (a spec with no `arms` runs one, named
 * `"default"`) — and either one `metric`, or none, which gates every check of
 * a run scored with `checks`, `per` overriding `min` by check kind.
 *
 * @public
 */
export type ArmRateGate = RateGate &
  (
    | {
        readonly arm?: string;
        readonly metric: string;
        readonly per?: never;
      }
    | {
        readonly arm?: string;
        readonly metric?: never;
        /** A per-check-KIND `min`, e.g. `{ skill: 1 }`: the skill must fire every time. */
        readonly per?: Readonly<Record<string, number>>;
      }
  );

/**
 * The scored gate: throw if a measured rate is below its threshold — the
 * `paid_runEval` counterpart to `assertChecks` (strict). Reads the rate, not a
 * single run, so it never trips on one noisy trial.
 *
 * Over an {@link EvalReport}: pick the `arm` (optional when there is one).
 * With a `metric`, `min` gates its mean and `passK: 1` that it succeeded on
 * every trial. Without one, every CHECK of a run scored with `checks` is gated:
 * `min` is the default threshold, and `per` overrides it for a check KIND
 * (`{ min: 0.8, per: { skill: 1.0 } }` — "every check ≥ 80%, but the skill must
 * FIRE on every trial"); `passK: 1` demands every check passed on EVERY trial.
 * A run scored with `measure(ctx)` has no checks, so it needs the `metric`.
 *
 * Over a {@link TriggerRateReport} (a `measureTriggerRate` eval): `min` gates
 * recall, `maxFalsePositive` and `minPrecision` the precision side — see
 * {@link TriggerRateGate}. Replaces `assertTriggerRate` (v52).
 */
/* eslint-disable no-redeclare -- TypeScript function overloads (the base
   no-redeclare rule, unlike @typescript-eslint/no-redeclare, flags them) */
/** @public */
export function assertRates(report: EvalReport, opts: ArmRateGate): void;
/** @public */
export function assertRates(
  report: TriggerRateReport,
  opts: TriggerRateGate,
): void;
export function assertRates(
  report: EvalReport | TriggerRateReport,
  opts: ArmRateGate | TriggerRateGate,
): void {
  if ("perPrompt" in report) assertTriggerRateReport(report, opts);
  else assertArmRates(report, opts);
}
/* eslint-enable no-redeclare */

/** The fields an eval-report gate reads; the overloads pair it with an {@link ArmRateGate}. */
interface ArmGateFields {
  readonly arm?: string;
  readonly metric?: string;
  readonly min?: number;
  readonly passK?: 1;
  readonly per?: Readonly<Record<string, number>>;
}

function assertArmRates(report: EvalReport, opts: ArmGateFields): void {
  const [name, arm] = armOf(report, opts);
  if (opts.metric !== undefined)
    assertMetricRate(arm, { ...opts, arm: name, metric: opts.metric });
  else assertCheckRates(report, arm, opts);
}

/** The arm a gate reads: the named one, or the report's only one. */
function armOf(
  report: EvalReport,
  opts: ArmGateFields,
): readonly [string, ArmReport] {
  const names = Object.keys(report.arms);
  const only = names.length === 1 ? names[0] : undefined;
  const name = opts.arm ?? only;
  if (name === undefined)
    throw new Error(
      `assertRates: report "${report.name}" has ${String(names.length)} arms (${names.join(", ")}) — name the \`arm\` to gate.`,
    );
  const found = Object.entries(report.arms).find(([n]) => n === name);
  if (found === undefined) {
    const on = opts.metric === undefined ? "" : " on " + opts.metric;
    throw new Error(
      `assertRates: no data for ${name}${on} in report "${report.name}" (arms: ${names.join(", ")})`,
    );
  }
  return found;
}

function assertMetricRate(
  armReport: ArmReport,
  opts: ArmGateFields & { readonly arm: string; readonly metric: string },
): void {
  const stat = armReport.stats[opts.metric];
  const mean = armReport.metrics[opts.metric];
  if (stat === undefined || mean === undefined) {
    throw new Error(
      `assertRates: no data for ${opts.arm} on ${opts.metric} (it has: ${Object.keys(armReport.metrics).join(", ") || "no metrics"})`,
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

/** One check's standing in an arm: its key (the label), its check, its stats. */
interface CheckRow {
  readonly key: string;
  readonly check: CheckJSON;
  readonly rate: number;
  readonly se: number;
  readonly passK: number;
  readonly n: number;
}

/** Every check of a `checks`-scored report, as read in one arm. */
function checkRows(report: EvalReport, arm: ArmReport): readonly CheckRow[] {
  const checks = report.checks;
  if (checks === undefined)
    throw new Error(
      `assertRates: report "${report.name}" was scored by \`measure(ctx)\`, so it has no checks to gate — name the \`metric\` (${Object.keys(arm.metrics).join(", ") || "none"}).`,
    );
  // An arm with no scored trial reports no metric: its checks read as 0 of 0,
  // which fails any floor rather than passing an empty measurement.
  return Object.entries(checks).map(([key, check]) => {
    const s = arm.stats[key];
    return {
      key,
      check,
      rate: s?.mean ?? 0,
      se: s?.se ?? 0,
      passK: s?.passK ?? 0,
      n: s?.n ?? 0,
    };
  });
}

const pct = (x: number): string => (x * 100).toFixed(0);

function assertCheckRates(
  report: EvalReport,
  arm: ArmReport,
  opts: ArmGateFields,
): void {
  const rows = checkRows(report, arm);
  const thresholdFor = (c: CheckRow): number =>
    opts.per?.[c.check.kind] ?? opts.min ?? 0;
  const below = rows.filter((c) => c.rate < thresholdFor(c));
  if (below.length > 0)
    throw new Error(
      `${String(below.length)} check(s) below their min rate:\n` +
        below
          .map(
            (c) =>
              `  ✗ ${c.key}: ${pct(c.rate)}% ± ${pct(c.se)}% (min ${pct(thresholdFor(c))}%)`,
          )
          .join("\n"),
    );
  if (opts.passK === 1) assertEveryTrial(rows);
}

function assertEveryTrial(rows: readonly CheckRow[]): void {
  const flaky = rows.filter((c) => c.passK !== 1);
  if (flaky.length === 0) return;
  throw new Error(
    `${String(flaky.length)} check(s) did not pass on every trial (pass^k = 1 required):\n` +
      flaky
        .map(
          (c) =>
            `  ✗ ${c.key}: passed ${pct(c.rate)}% of ${String(c.n)} trials`,
        )
        .join("\n"),
  );
}
