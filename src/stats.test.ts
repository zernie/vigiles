/**
 * Tests for the significance stats (src/stats.ts) — pure, model-free. The
 * numerics are checked against known closed forms and t-table values so the
 * p-values are grounded, not just internally consistent.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  regularizedIncompleteBeta,
  tPValueTwoSided,
  welchTTest,
  compareArms,
} from "./stats.js";
import type { EvalReport, MetricStat } from "./eval.js";

const close = (a: number, b: number, tol = 1e-3): boolean =>
  Math.abs(a - b) < tol;

test("regularizedIncompleteBeta: endpoints and a known closed form", () => {
  assert.equal(regularizedIncompleteBeta(2, 3, 0), 0);
  assert.equal(regularizedIncompleteBeta(2, 3, 1), 1);
  // I_0.5(0.5, 0.5) = (2/π)·arcsin(√0.5) = 0.5 (the arcsin distribution)
  assert.ok(close(regularizedIncompleteBeta(0.5, 0.5, 0.5), 0.5));
  // both code branches: x below and above (a+1)/(a+b+2)
  assert.ok(close(regularizedIncompleteBeta(0.5, 0.5, 0.25), 1 / 3, 5e-3)); // arcsin: 2/π·asin(0.5)=1/3
  assert.ok(close(regularizedIncompleteBeta(0.5, 0.5, 0.75), 2 / 3, 5e-3));
});

test("tPValueTwoSided matches t-table critical values (p≈0.05)", () => {
  assert.equal(tPValueTwoSided(0, 10), 1); // no difference
  assert.ok(close(tPValueTwoSided(2.131, 15), 0.05, 5e-3)); // t_.975,15 = 2.131
  assert.ok(close(tPValueTwoSided(2.776, 4), 0.05, 5e-3)); // t_.975,4 = 2.776
  assert.ok(close(tPValueTwoSided(2.228, 10), 0.05, 5e-3)); // t_.975,10 = 2.228
  assert.ok(tPValueTwoSided(8, 30) < 1e-6); // huge t → ~0
  assert.equal(tPValueTwoSided(2, 0), 1); // df ≤ 0 guard
});

test("welchTTest: clearly-significant vs clearly-noise gaps", () => {
  // big separation, tight se → significant
  const sig = welchTTest(
    { mean: 0.6, se: 0.05, n: 20 },
    { mean: 0.1, se: 0.05, n: 20 },
  );
  assert.ok(sig.delta > 0 && sig.significant && sig.pValue < 0.01);

  // small gap, wide se → not significant
  const noise = welchTTest(
    { mean: 0.5, se: 0.2, n: 5 },
    { mean: 0.4, se: 0.2, n: 5 },
  );
  assert.ok(!noise.significant && noise.pValue > 0.1);
});

test("welchTTest: deterministic arms (se = 0) decide by exact difference", () => {
  // perfect separation, no variance → significant (p = 0)
  const sep = welchTTest({ mean: 1, se: 0, n: 5 }, { mean: 0, se: 0, n: 5 });
  assert.ok(sep.significant && sep.pValue === 0 && sep.df === 0);
  // identical deterministic arms → not significant (p = 1)
  const same = welchTTest({ mean: 1, se: 0, n: 5 }, { mean: 1, se: 0, n: 5 });
  assert.ok(!same.significant && same.pValue === 1);
});

test("welchTTest: one deterministic arm, one varying (mixed df terms)", () => {
  const c = welchTTest(
    { mean: 0.9, se: 0.1, n: 10 }, // varying arm contributes to df
    { mean: 0.2, se: 0, n: 10 }, // deterministic baseline contributes 0
  );
  assert.ok(c.delta > 0 && c.significant && c.df > 0);
});

function makeReport(
  stats: Record<string, Record<string, MetricStat>>,
): EvalReport {
  const arms: EvalReport["arms"] = {};
  for (const [name, s] of Object.entries(stats)) {
    arms[name] = {
      unansweredStubCalls: [],
      runs: 0,
      metrics: {},
      stats: s,
      usage: {
        totalCostUsd: 0,
        meanCostUsd: 0,
        meanDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
      },
    };
  }
  return { name: "r", trials: 0, totalCostUsd: 0, aborted: false, arms };
}

test("compareArms reads arm stats from a report, or null if absent", () => {
  const stat = (mean: number, se: number, n: number): MetricStat => ({
    mean,
    se,
    n,
    std: se * Math.sqrt(n),
    passK: 0,
  });
  const report = makeReport({
    base: { caught: stat(0.1, 0.05, 20) },
    arm: { caught: stat(0.6, 0.05, 20) },
  });
  const c = compareArms(report, "base", "arm", "caught");
  assert.ok(c && c.delta > 0 && c.significant);
  assert.equal(compareArms(report, "base", "arm", "missing"), null); // metric absent
  assert.equal(compareArms(report, "nope", "arm", "caught"), null); // arm absent
});
