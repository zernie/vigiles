/**
 * Tests for the 0/1-metric verdict (src/core/evidence.ts): the normal quantile
 * and Wilson interval against closed forms, and the disjoint-interval rule —
 * including the case vigiles#416 reported, 3/3 against 0/3, which must stay
 * `no-signal` (Fisher's exact test puts it at p = 0.10).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  describeVerdict,
  normalQuantile,
  proportionVerdict,
  wilson,
} from "./evidence.js";

const close = (a: number, b: number, tol = 1e-6): boolean =>
  Math.abs(a - b) < tol;

test("normalQuantile matches the standard normal table, both tails", () => {
  assert.ok(close(normalQuantile(0.5), 0));
  assert.ok(close(normalQuantile(0.975), 1.959963985));
  assert.ok(close(normalQuantile(0.025), -1.959963985));
  assert.ok(close(normalQuantile(0.995), 2.575829304));
  assert.ok(close(normalQuantile(0.01), -2.326347874));
  assert.throws(() => normalQuantile(0), RangeError);
  assert.throws(() => normalQuantile(1), RangeError);
});

test("wilson: never a point at the edges, symmetric around the middle", () => {
  const all = wilson(3, 3);
  assert.equal(all.hi, 1);
  assert.ok(all.lo > 0.4 && all.lo < 0.5); // 3/3 still admits a rate near 0.44
  const none = wilson(0, 3);
  assert.equal(none.lo, 0);
  assert.ok(close(none.hi, 1 - all.lo));
  // the textbook value for 8 of 10 at 95%: [0.4902, 0.9433]
  const eight = wilson(8, 10);
  assert.ok(close(eight.lo, 0.4902, 1e-4) && close(eight.hi, 0.9433, 1e-4));
  // a wider confidence level widens the interval
  assert.ok(wilson(8, 10, 0.01).lo < eight.lo);
});

test("proportionVerdict: better/worse only on disjoint intervals", () => {
  const v = (ka: number, kb: number, n: number) =>
    proportionVerdict({ k: ka, n }, { k: kb, n }).kind;
  assert.equal(v(1, 0, 1), "no-signal");
  assert.equal(v(3, 0, 3), "no-signal");
  assert.equal(v(10, 0, 10), "better");
  assert.equal(v(0, 10, 10), "worse");
  assert.equal(v(5, 5, 10), "no-signal");
  assert.deepEqual(proportionVerdict({ k: 0, n: 0 }, { k: 1, n: 1 }), {
    kind: "unmeasured",
    why: "no-trials",
  });
});

test("describeVerdict names every verdict kind and the test behind it", () => {
  const noSignal = describeVerdict(
    proportionVerdict({ k: 3, n: 3 }, { k: 0, n: 3 }),
  );
  assert.ok(noSignal.includes("NO SIGNAL") && noSignal.includes("Wilson"));
  assert.ok(
    describeVerdict(
      proportionVerdict({ k: 10, n: 10 }, { k: 0, n: 10 }),
    ).startsWith("BETTER"),
  );
  assert.ok(
    describeVerdict({
      kind: "worse",
      test: "welch",
      delta: -0.5,
      pValue: 0.01,
    }).includes("Welch"),
  );
  assert.ok(
    describeVerdict({ kind: "unmeasured", why: "metric-missing" }).includes(
      "metric-missing",
    ),
  );
});
