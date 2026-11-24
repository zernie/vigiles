/**
 * The pure half of an eval's scoring: per-run metric rows aggregated into an
 * arm's mean / sample std / se / pass^k, and per-run usage into its cost,
 * latency and token totals. No I/O and no harness — the run pipeline in
 * `src/eval.ts` calls these once its trials are in.
 */
import type { ArmUsage, MetricStat } from "./eval-report.js";
import type { EvalUsage } from "./eval-driver.js";

/** @public */
export type Metrics = Record<string, number | boolean>;

/** Coerce a metric value to a number (booleans → 0/1), or null if absent. */
function numeric(v: number | boolean | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** Aggregate per-run metrics: mean for numbers, fraction-true (0..1) for booleans. */
export function aggregate(rows: readonly Metrics[]): Record<string, number> {
  const stats = aggregateStats(rows);
  const out: Record<string, number> = {};
  for (const [k, s] of Object.entries(stats)) out[k] = s.mean;
  return out;
}

/**
 * Aggregate per-run metrics with spread: mean, sample std, standard error, and
 * n. The se/std let you judge whether an A/B gap between arms is real or noise —
 * a difference smaller than the combined se is not yet significant.
 */
export function aggregateStats(
  rows: readonly Metrics[],
): Record<string, MetricStat> {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const out: Record<string, MetricStat> = {};
  for (const k of keys) {
    out[k] = statOf(
      rows.map((r) => numeric(r[k])).filter((v): v is number => v !== null),
    );
  }
  return out;
}

/** One metric's {@link MetricStat} from the values its trials reported. */
function statOf(values: readonly number[]): MetricStat {
  const n = values.length;
  const mean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : 0;
  const std =
    n > 1
      ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : 0;
  const passK = n > 0 && values.every((v) => v > 0) ? 1 : 0;
  // Recorded from the observations, never inferred from mean and spread: a
  // sample like [-0.6, 0.4, 0.4, 0.4, 0.4] has the moments of 1 success in 5.
  const binary = n > 0 && values.every((v) => v === 0 || v === 1);
  return {
    mean,
    std,
    se: n > 0 ? std / Math.sqrt(n) : 0,
    n,
    passK,
    ...(binary ? { successes: values.filter((v) => v === 1).length } : {}),
  };
}

/** Aggregate per-run usage into an arm's cost / latency / token totals + means. */
export function aggregateUsage(usages: readonly EvalUsage[]): ArmUsage {
  const n = usages.length;
  const sum = (f: (u: EvalUsage) => number): number =>
    usages.reduce((a, u) => a + f(u), 0);
  const totalCostUsd = sum((u) => u.costUsd);
  return {
    totalCostUsd,
    meanCostUsd: n > 0 ? totalCostUsd / n : 0,
    meanDurationMs: n > 0 ? sum((u) => u.durationMs) / n : 0,
    totalInputTokens: sum((u) => u.inputTokens),
    totalOutputTokens: sum((u) => u.outputTokens),
    totalCacheCreationTokens: sum((u) => u.cacheCreationTokens),
    totalCacheReadTokens: sum((u) => u.cacheReadTokens),
  };
}
