/**
 * Cross-runner constraint: the `check.*` vocabulary works under **node:test** —
 * no runner dependency at all, only `assertChecks`. The same cases run under
 * vitest and jest (see checks-cases.cjs).
 *
 *   npm run test:node-runner
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { CASES, verdict } = createRequire(import.meta.url)("./checks-cases.cjs");

for (const c of CASES)
  test(`check.*: ${c.name}`, () => {
    assert.equal(verdict(c), undefined);
  });
