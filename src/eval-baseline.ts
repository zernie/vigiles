/**
 * vigiles — eval regression gating (Phase C).
 *
 * The eval tier reports mean ± se per arm; `src/stats.ts` turns a gap into a
 * significance verdict. This module points that machinery at a *committed
 * baseline*: record one run's `EvalReport`s to `.vigiles/eval-baseline.json`,
 * then on a later run flag any arm×metric that moved **significantly in the bad
 * direction** vs. that baseline. "jest snapshots for agent behaviour, with a real
 * noise floor" — a bare pass-rate can't tell a true regression from sampling
 * noise, but a Welch t-test over the two runs' summary stats can.
 *
 * Pure + model-free (the diff/serialize/JUnit are fully unit-tested); the only
 * side effects are the two small fs helpers (`readBaseline` / `writeBaseline`),
 * which `assertNoRegression`'s `baseline` option calls.
 * Reuses `compareStats` from `src/stats.ts` — the current run is the "arm", the
 * baseline is the "baseline", so `delta = current − baseline`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalReport } from "./eval.js";
import { compareStats, type Comparison } from "./stats.js";

/** Bumped only on a breaking change to the on-disk shape. */
export const BASELINE_VERSION = 1;

/**
 * The committed baseline: the recorded `EvalReport`s, keyed by report name.
 *
 * @public
 */
export interface BaselineFile {
  readonly version: number;
  /** ISO-8601 timestamp the baseline was recorded (provenance / future trend). */
  readonly recordedAt: string;
  /** Recorded reports, keyed by `report.name` (so multiple eval files coexist). */
  readonly reports: Record<string, EvalReport>;
}

/** How a metric moved between baseline and current run. */
export type DiffStatus = "regressed" | "improved" | "unchanged";

/** One arm×metric comparison of a current run against the baseline. */
export interface MetricDiff {
  /** The `report.name` this entry belongs to. */
  readonly report: string;
  readonly arm: string;
  readonly metric: string;
  readonly status: DiffStatus;
  /** Welch comparison, current vs. baseline (`delta = current − baseline`). */
  readonly comparison: Comparison;
}

export interface BaselineDiff {
  /** Every arm×metric present in BOTH the baseline and the current run. */
  readonly entries: readonly MetricDiff[];
  /** The subset that regressed (significant move in the bad direction). */
  readonly regressions: readonly MetricDiff[];
  /** The subset that improved (significant move in the good direction). */
  readonly improvements: readonly MetricDiff[];
  /** True when there are no regressions — the gate. */
  readonly passed: boolean;
}

/** @public */
export interface DiffOptions {
  /** Significance level for the Welch test. Default 0.05. */
  readonly alpha?: number;
  /**
   * Metrics where a DECREASE is the improvement (e.g. `cost`, `latency`,
   * `turns`). For these, a significant increase is the regression. Everything
   * else is treated as higher-is-better.
   */
  readonly lowerIsBetter?: readonly string[];
}

/** Build a `BaselineFile` envelope from a run's reports (keyed by name). */
export function toBaselineFile(
  reports: readonly EvalReport[],
  recordedAt: string = new Date().toISOString(),
): BaselineFile {
  const byName: Record<string, EvalReport> = {};
  for (const r of reports) byName[r.name] = r;
  return { version: BASELINE_VERSION, recordedAt, reports: byName };
}

/** Parse + validate a baseline JSON string (throws on a bad version/shape). */
export function parseBaselineFile(json: string): BaselineFile {
  const data: unknown = JSON.parse(json);
  if (typeof data !== "object" || data === null) {
    throw new Error("baseline: expected a JSON object");
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== BASELINE_VERSION) {
    throw new Error(
      `baseline: unsupported version ${String(obj.version)} (expected ${String(BASELINE_VERSION)})`,
    );
  }
  if (typeof obj.reports !== "object" || obj.reports === null) {
    throw new Error("baseline: missing `reports`");
  }
  return {
    version: BASELINE_VERSION,
    recordedAt: typeof obj.recordedAt === "string" ? obj.recordedAt : "",
    reports: obj.reports as Record<string, EvalReport>,
  };
}

/** Classify one comparison given the metric's direction. */
function classify(cmp: Comparison, lowerIsBetter: boolean): DiffStatus {
  if (!cmp.significant || cmp.delta === 0) return "unchanged";
  const improved = lowerIsBetter ? cmp.delta < 0 : cmp.delta > 0;
  return improved ? "improved" : "regressed";
}

/** Resolved diff config: significance level + the lower-is-better metric set. */
interface DiffConfig {
  readonly alpha: number;
  readonly lower: ReadonlySet<string>;
}

/** Append a diff entry for every arm×metric common to both reports. */
function collectReportDiffs(
  baseline: EvalReport,
  current: EvalReport,
  cfg: DiffConfig,
  out: MetricDiff[],
): void {
  for (const [arm, curArm] of Object.entries(current.arms)) {
    const baseArm = baseline.arms[arm];
    if (!baseArm) continue;
    for (const [metric, curStat] of Object.entries(curArm.stats)) {
      const baseStat = baseArm.stats[metric];
      if (!baseStat) continue;
      const comparison = compareStats(curStat, baseStat, cfg.alpha);
      out.push({
        report: current.name,
        arm,
        metric,
        status: classify(comparison, cfg.lower.has(metric)),
        comparison,
      });
    }
  }
}

/**
 * Diff a current run against a committed baseline. Compares every arm×metric
 * present in both (by report name), flagging a *significant* move in the
 * undesired direction as a regression. Metrics absent from one side are skipped
 * (a new arm/metric is not a regression).
 */
export function diffReports(
  baseline: BaselineFile,
  current: readonly EvalReport[],
  opts: DiffOptions = {},
): BaselineDiff {
  const cfg: DiffConfig = {
    alpha: opts.alpha ?? 0.05,
    lower: new Set(opts.lowerIsBetter ?? []),
  };
  const entries: MetricDiff[] = [];
  for (const cur of current) {
    const base = baseline.reports[cur.name];
    if (base) collectReportDiffs(base, cur, cfg, entries);
  }
  const regressions = entries.filter((e) => e.status === "regressed");
  const improvements = entries.filter((e) => e.status === "improved");
  return {
    entries,
    regressions,
    improvements,
    passed: regressions.length === 0,
  };
}

const STATUS_MARK: Record<DiffStatus, string> = {
  regressed: "✗",
  improved: "✓",
  unchanged: "·",
};

function formatDelta(c: Comparison): string {
  const sign = c.delta >= 0 ? "+" : "";
  return `Δ=${sign}${c.delta.toFixed(3)} p=${c.pValue.toFixed(3)}`;
}

/** Format a baseline diff as a compact console report. */
export function formatBaselineDiff(diff: BaselineDiff): string {
  const head = diff.passed
    ? "baseline OK — no significant regressions"
    : `baseline FAIL — ${String(diff.regressions.length)} regression(s)`;
  const lines = [head];
  for (const e of diff.entries) {
    lines.push(
      `  ${STATUS_MARK[e.status]} ${e.report}/${e.arm}/${e.metric}  ${formatDelta(e.comparison)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Read + parse a baseline file, or null if it doesn't exist yet. Internal since
 * v52: `assertNoRegression(current, { baseline: path })` reads it.
 */
export function readBaseline(path: string): BaselineFile | null {
  if (!existsSync(path)) return null;
  return parseBaselineFile(readFileSync(path, "utf-8"));
}

/**
 * Write reports as the committed baseline (pretty JSON, parent dirs created).
 * Internal since v52: `assertNoRegression(current, { baseline: path, update:
 * true })` writes it.
 */
export function writeBaseline(
  path: string,
  reports: readonly EvalReport[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(toBaselineFile(reports), null, 2) + "\n");
}
