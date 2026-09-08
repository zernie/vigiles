/**
 * Eval-baseline test suite (node:test): baseline round-trip + version/shape validation, regression vs improvement vs unchanged classification, lowerIsBetter direction flip, skip of absent arms/metrics/reports, console + JUnit formatting (counts, failure element, xml escaping), readBaseline null + writeBaseline round-trip
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  toBaselineFile,
  parseBaselineFile,
  diffReports,
  formatBaselineDiff,
  diffToJUnit,
  readBaseline,
  writeBaseline,
  BASELINE_VERSION,
  type BaselineFile,
} from "./eval-baseline.js";
import type { EvalReport, MetricStat, ArmReport } from "./eval.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/** Build a MetricStat (passK derived from mean for convenience). */
function stat(mean: number, se: number, n: number): MetricStat {
  return { mean, std: se * Math.sqrt(n), se, n, passK: mean >= 1 ? 1 : 0 };
}

/** Build an EvalReport from a nested arm → metric → stat map. */
function mkReport(
  name: string,
  arms: Record<string, Record<string, MetricStat>>,
): EvalReport {
  const armReports: Record<string, ArmReport> = {};
  for (const [armName, stats] of Object.entries(arms)) {
    const metrics: Record<string, number> = {};
    for (const [m, s] of Object.entries(stats)) metrics[m] = s.mean;
    armReports[armName] = {
      runs: 10,
      metrics,
      stats,
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
  return {
    name,
    trials: 10,
    arms: armReports,
    totalCostUsd: 0,
    aborted: false,
  };
}

test("toBaselineFile keys reports by name + stamps version/time", () => {
  const f = toBaselineFile(
    [mkReport("a", { gated: { caught: stat(0.5, 0.1, 10) } })],
    "2026-06-11T00:00:00Z",
  );
  assert.equal(f.version, BASELINE_VERSION);
  assert.equal(f.recordedAt, "2026-06-11T00:00:00Z");
  assert.ok(f.reports.a);
});

test("parseBaselineFile round-trips and rejects bad input", () => {
  const f = toBaselineFile([mkReport("a", { g: { c: stat(0.5, 0.1, 10) } })]);
  const back = parseBaselineFile(JSON.stringify(f));
  assert.deepEqual(back.reports, f.reports);

  assert.throws(() => parseBaselineFile("3"), /expected a JSON object/);
  assert.throws(() => parseBaselineFile("null"), /expected a JSON object/);
  assert.throws(
    () => parseBaselineFile(JSON.stringify({ version: 99, reports: {} })),
    /unsupported version 99/,
  );
  assert.throws(
    () => parseBaselineFile(JSON.stringify({ version: BASELINE_VERSION })),
    /missing `reports`/,
  );
  // a missing recordedAt falls back to ""
  const noTime = parseBaselineFile(
    JSON.stringify({ version: BASELINE_VERSION, reports: {} }),
  );
  assert.equal(noTime.recordedAt, "");
});

test("diffReports flags a significant drop as a regression", () => {
  const base = toBaselineFile([
    mkReport("e", { gated: { caught: stat(0.9, 0.03, 20) } }),
  ]);
  const cur = [mkReport("e", { gated: { caught: stat(0.4, 0.03, 20) } })];
  const diff = diffReports(base, cur);
  assert.equal(diff.passed, false);
  assert.equal(diff.regressions.length, 1);
  assert.equal(diff.regressions[0]?.metric, "caught");
  assert.ok((diff.regressions[0]?.comparison.delta ?? 0) < 0);
});

test("diffReports flags a significant gain as an improvement, not a regression", () => {
  const base = toBaselineFile([
    mkReport("e", { gated: { caught: stat(0.4, 0.03, 20) } }),
  ]);
  const cur = [mkReport("e", { gated: { caught: stat(0.9, 0.03, 20) } })];
  const diff = diffReports(base, cur);
  assert.equal(diff.passed, true);
  assert.equal(diff.improvements.length, 1);
  assert.equal(diff.regressions.length, 0);
});

test("diffReports: a within-noise move is unchanged", () => {
  const base = toBaselineFile([
    mkReport("e", { g: { caught: stat(0.5, 0.2, 5) } }),
  ]);
  const cur = [mkReport("e", { g: { caught: stat(0.45, 0.2, 5) } })];
  const diff = diffReports(base, cur);
  assert.equal(diff.passed, true);
  assert.equal(diff.entries[0]?.status, "unchanged");
});

test("lowerIsBetter flips the direction: a significant increase regresses", () => {
  const base = toBaselineFile([
    mkReport("e", { g: { cost: stat(0.1, 0.005, 20) } }),
  ]);
  const cur = [mkReport("e", { g: { cost: stat(0.5, 0.005, 20) } })];
  const higherBad = diffReports(base, cur); // default: higher is better → improved
  assert.equal(higherBad.improvements.length, 1);
  const lowerBetter = diffReports(base, cur, { lowerIsBetter: ["cost"] });
  assert.equal(lowerBetter.regressions.length, 1);
  assert.equal(lowerBetter.passed, false);
});

test("diffReports skips arms/metrics/reports absent on either side", () => {
  const base = toBaselineFile([
    mkReport("e", { gated: { caught: stat(0.9, 0.03, 20) } }),
  ]);
  const cur = [
    // new arm, new metric, and a whole report with no baseline → all skipped
    mkReport("e", {
      gated: { caught: stat(0.9, 0.03, 20), novel: stat(0.1, 0.03, 20) },
      freshArm: { caught: stat(0.1, 0.03, 20) },
    }),
    mkReport("unbaselined", { g: { x: stat(0.1, 0.03, 20) } }),
  ];
  const diff = diffReports(base, cur);
  assert.equal(diff.entries.length, 1); // only e/gated/caught is common
  assert.equal(diff.entries[0]?.metric, "caught");
  assert.equal(diff.passed, true);
});

test("formatBaselineDiff shows pass/fail header + per-entry lines", () => {
  const base = toBaselineFile([
    mkReport("e", { g: { caught: stat(0.9, 0.03, 20) } }),
  ]);
  const fail = formatBaselineDiff(
    diffReports(base, [mkReport("e", { g: { caught: stat(0.3, 0.03, 20) } })]),
  );
  assert.match(fail, /baseline FAIL — 1 regression/);
  assert.match(fail, /✗ e\/g\/caught/);

  const ok = formatBaselineDiff(
    diffReports(base, [mkReport("e", { g: { caught: stat(0.9, 0.03, 20) } })]),
  );
  assert.match(ok, /baseline OK/);
  assert.match(ok, /· e\/g\/caught/);
});

test("diffToJUnit emits counts, a failure for regressions, and escapes xml", () => {
  const base = toBaselineFile([
    mkReport("re<po>rt", { g: { caught: stat(0.9, 0.03, 20) } }),
  ]);
  const diff = diffReports(base, [
    mkReport("re<po>rt", { g: { caught: stat(0.3, 0.03, 20) } }),
  ]);
  const xml = diffToJUnit(diff);
  assert.match(xml, /tests="1" failures="1"/);
  assert.match(xml, /<failure message="regression/);
  assert.match(xml, /re&lt;po&gt;rt/); // escaped, no raw < >
  assert.doesNotMatch(xml, /re<po>rt/);

  // a clean diff yields a passing testcase (no <failure>)
  const clean = diffToJUnit(
    diffReports(base, [
      mkReport("re<po>rt", { g: { caught: stat(0.9, 0.03, 20) } }),
    ]),
  );
  assert.match(clean, /failures="0"/);
  assert.doesNotMatch(clean, /<failure/);
});

test("readBaseline returns null when absent and round-trips writeBaseline", () => {
  const dir = makeTmpDir("baseline");
  try {
    const path = join(dir, "nested", "eval-baseline.json");
    assert.equal(readBaseline(path), null);
    writeBaseline(path, [
      mkReport("e", { g: { caught: stat(0.9, 0.03, 20) } }),
    ]);
    const back = readBaseline(path) as BaselineFile;
    assert.ok(back.reports.e);
    assert.equal(back.reports.e?.arms.g?.stats.caught?.mean, 0.9);
  } finally {
    cleanupTmpDir(dir);
  }
});
