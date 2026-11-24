/**
 * The eval-report readers that live on `vigiles/eval`: one `compare` for "how
 * far apart are two arms, and is it beyond the noise", `assertRates` with
 * `passK` for "worked every time", and `assertImproves({ significant })` for
 * the computed noise floor. Fake reports, no model.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { compare, assertImproves } from "./eval-readers.js";
import type { EvalReport, TriggerRateReport } from "./eval.js";
import { aggregateStats } from "./core/eval-aggregate.js";
import { assertRates } from "./eval-rate-gate.js";
import type { CheckReport } from "./eval-check-report.js";

const NO_USAGE = {
  totalCostUsd: 0,
  meanCostUsd: 0,
  meanDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
} as const;

const NO_MISSES = { usage: NO_USAGE, unansweredStubCalls: [] } as const;

/** A two-arm report whose 0/1 metric `pass` went `k` of `n` per arm. */
function passReport(kArm: number, kBase: number, n: number): EvalReport {
  const arm = (k: number) => ({
    runs: n,
    metrics: { pass: k / n },
    stats: aggregateStats(
      Array.from({ length: n }, (_, i) => ({ pass: i < k })),
    ),
    ...NO_MISSES,
  });
  return {
    name: "p10",
    trials: n,
    totalCostUsd: 0,
    aborted: false,
    arms: { base: arm(kBase), skill: arm(kArm) },
  };
}

const stat = (mean: number, se: number, n: number) => ({
  mean,
  se,
  n,
  std: se * Math.sqrt(n),
  passK: 0,
});

const BASE = {
  runs: 20,
  metrics: { caught: 0.1 },
  stats: { caught: stat(0.1, 0.05, 20) },
  ...NO_MISSES,
};
const GOOD = {
  runs: 20,
  metrics: { caught: 0.6 },
  stats: { caught: stat(0.6, 0.05, 20) },
  ...NO_MISSES,
};

const welchReport: EvalReport = {
  name: "sig",
  trials: 20,
  totalCostUsd: 0,
  aborted: false,
  arms: {
    base: BASE,
    good: GOOD,
    noisy: {
      runs: 5,
      metrics: { caught: 0.2 },
      stats: { caught: stat(0.2, 0.2, 5) },
      ...NO_MISSES,
    },
  },
};

test("compare gives the gap and whether it clears the noise, per metric", () => {
  const good = compare(welchReport, "base", "good").caught;
  assert.ok(good);
  assert.equal(good.gap.toFixed(2), "0.50");
  assert.equal(good.significant, true);
  assert.equal(good.verdict.kind, "better");

  const noisy = compare(welchReport, "base", "noisy").caught;
  assert.ok(noisy);
  assert.equal(noisy.significant, false);
  assert.equal(noisy.verdict.kind, "no-signal");
});

test("compare reads a 0/1 metric by Wilson intervals: 3/3 vs 0/3 is not significant", () => {
  assert.equal(
    compare(passReport(3, 0, 3), "base", "skill").pass?.significant,
    false,
  );
  assert.equal(
    compare(passReport(10, 0, 10), "base", "skill").pass?.significant,
    true,
  );
});

test("compare names a significant LOSS too, with a negative gap", () => {
  const worse = compare(passReport(0, 10, 10), "base", "skill").pass;
  assert.ok(worse);
  assert.equal(worse.significant, true);
  assert.equal(worse.verdict.kind, "worse");
  assert.ok(worse.gap < 0);
});

test("compare leaves out a metric only one arm reported, and throws on an unknown arm", () => {
  const r: EvalReport = {
    ...welchReport,
    arms: {
      base: { ...BASE, metrics: { caught: 0.1, extra: 1 } },
      good: GOOD,
    },
  };
  assert.deepEqual(Object.keys(compare(r, "base", "good")), ["caught"]);
  assert.throws(() => compare(r, "base", "nobody"), /no arm "nobody"/);
});

test("compare: a metric with no per-trial stats has a gap but no verdict", () => {
  const r: EvalReport = {
    ...welchReport,
    arms: {
      base: { ...BASE, stats: {} },
      good: { ...GOOD, stats: {} },
    },
  };
  const c = compare(r, "base", "good").caught;
  assert.ok(c);
  assert.equal(c.gap.toFixed(2), "0.50");
  assert.equal(c.significant, false);
  assert.equal(c.verdict.kind, "unmeasured");
});

test("assertImproves({ significant: true }) is the computed noise floor", () => {
  assert.doesNotThrow(() => {
    assertImproves(welchReport, {
      baseline: "base",
      arm: "good",
      metric: "caught",
      significant: true,
    });
  });
  assert.throws(() => {
    assertImproves(welchReport, {
      baseline: "base",
      arm: "noisy",
      metric: "caught",
      significant: true,
    });
  });
  assert.throws(() => {
    assertImproves(passReport(3, 0, 3), {
      baseline: "base",
      arm: "skill",
      metric: "pass",
      significant: true,
    });
  }, /NO SIGNAL/);
  assert.throws(() => {
    assertImproves(welchReport, {
      baseline: "base",
      arm: "good",
      metric: "missing",
      significant: true,
    });
  }, /no data to compare/);
});

const checkReport = (passK: number, rate: number): CheckReport => ({
  n: 4,
  usage: NO_USAGE,
  perCheck: [
    { check: { kind: "tool", name: "Bash" }, rate, se: 0, passK, n: 4 },
  ],
});

test("assertRates({ passK: 1 }) demands every trial passed, not the average", () => {
  assert.doesNotThrow(() => {
    assertRates(checkReport(1, 1), { passK: 1 });
  });
  assert.throws(() => {
    assertRates(checkReport(0, 0.75), { passK: 1 });
  }, /pass\^k/);
  // `min` alone still gates the average, as before.
  assert.doesNotThrow(() => {
    assertRates(checkReport(0, 0.75), { min: 0.7 });
  });
});

test("assertRates reads an EvalReport arm × metric: min gates the mean, passK every trial", () => {
  const rep: EvalReport = {
    name: "rel",
    trials: 4,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      flaky: {
        runs: 4,
        metrics: { safe: 0.75 },
        stats: { safe: { mean: 0.75, std: 0.5, se: 0.25, n: 4, passK: 0 } },
        ...NO_MISSES,
      },
      solid: {
        runs: 4,
        metrics: { safe: 1 },
        stats: { safe: { mean: 1, std: 0, se: 0, n: 4, passK: 1 } },
        ...NO_MISSES,
      },
    },
  };
  assert.doesNotThrow(() => {
    assertRates(rep, { arm: "solid", metric: "safe", passK: 1 });
  });
  assert.throws(() => {
    assertRates(rep, { arm: "flaky", metric: "safe", passK: 1 });
  }, /pass\^k/);
  assert.doesNotThrow(() => {
    assertRates(rep, { arm: "flaky", metric: "safe", min: 0.7 });
  });
  assert.throws(() => {
    assertRates(rep, { arm: "flaky", metric: "safe", min: 0.8 });
  }, /0\.75/);
  assert.throws(() => {
    assertRates(rep, { arm: "nobody", metric: "safe", passK: 1 });
  }, /no data/);
});

test("assertImproves without `significant` gates the plain gap against `by`", () => {
  const gap = { baseline: "base", arm: "good", metric: "caught" } as const;
  assert.doesNotThrow(() => {
    assertImproves(welchReport, gap);
  });
  assert.throws(() => {
    assertImproves(welchReport, { ...gap, by: 0.9 });
  }, /by > 0\.9, got 0\.500/);
  assert.throws(() => {
    assertImproves(welchReport, { ...gap, metric: "missing" });
  }, /no data to compare/);
});

test("assertRates over an eval report without an arm is refused, not read as a check report", () => {
  const rep = passReport(1, 1, 1);
  assert.throws(() => {
    // @ts-expect-error — an eval report needs `arm` and `metric`
    assertRates(rep, { passK: 1 });
  }, /needs `arm` and `metric`/);
});

/** A trigger-rate report: which of these prompts fired, one trial each. */
function triggerReport(fired: Record<string, boolean>): TriggerRateReport {
  const perPrompt = Object.entries(fired).map(([prompt, f]) => ({
    prompt,
    fired: f ? 1 : 0,
    trials: 1,
    rate: f ? 1 : 0,
  }));
  return {
    rate: perPrompt.filter((p) => p.rate > 0).length / perPrompt.length,
    n: perPrompt.length,
    perPrompt,
    competitors: 0,
    usage: NO_USAGE,
  };
}

test("compare(before, after) on two trigger-rate reports: which prompts a change gained and lost", () => {
  const before = triggerReport({ a: true, b: true, c: false, d: false });
  const after = triggerReport({
    a: true,
    b: false,
    c: true,
    d: false,
    e: true,
  });
  const diff = compare(before, after);
  assert.deepEqual(diff.lost, ["b"]);
  assert.deepEqual(diff.gained, ["c"]);
  assert.deepEqual(diff.both, ["a"]);
  assert.deepEqual(diff.neither, ["d"]);
  // A prompt only one run measured says nothing about the change.
  assert.equal(diff.compared, 4);
});

test("compare(before, after): runs with no prompt in common compare nothing", () => {
  const diff = compare(triggerReport({ a: true }), triggerReport({ b: true }));
  assert.equal(diff.compared, 0);
  assert.deepEqual(
    [diff.gained, diff.lost, diff.both, diff.neither],
    [[], [], [], []],
  );
});

test("compare refuses a mixed call instead of guessing which reader was meant", () => {
  assert.throws(
    // @ts-expect-error — a trigger-rate report compares with another one
    () => compare(triggerReport({ a: true }), "base"),
    /compares with another one/,
  );
  assert.throws(
    // @ts-expect-error — an eval report needs a baseline and an arm
    () => compare(welchReport, "base"),
    /needs a baseline and an arm/,
  );
});
