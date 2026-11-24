/**
 * Cross-runner constraint: the harness helpers + matchers work under **vitest**.
 *
 * The library is runner-agnostic (plain functions over the CommonJS dist), so
 * the same `vigilesMatchers` object registers via `expect.extend` here exactly
 * as it does under jest (see matchers.jest.cjs). Pure — no model, no claude.
 *
 *   npm run test:vitest
 */
import { test, expect } from "vitest";
import { compare, assertImproves } from "../../dist/entries/eval.js";
import { check, assertChecks } from "../../dist/check.js";
import checksCases from "./checks-cases.cjs";
// Matchers are registered by the `vigiles/vitest` entry via setupFiles
// (vitest.config.ts) — this file asserts that wiring works end-to-end.

const report = {
  name: "demo",
  trials: 6,
  arms: {
    vanilla: { runs: 6, metrics: { caught: 0 }, stats: {} },
    gated: { runs: 6, metrics: { caught: 0.5 }, stats: {} },
  },
};

const result = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  cwd: "/tmp/x",
  turns: 2,
  file: (p) => (p === "DONE" ? "x" : null),
  cleanup: () => {},
};

test("vigilesMatchers register and work under vitest", () => {
  expect(result).toHaveCreated("DONE");
  expect(result).not.toHaveCreated("MISSING");
  expect(report).toBeatBaseline("vanilla", "gated", "caught");
  expect(report).not.toBeatBaseline("vanilla", "gated", "caught", 0.9);
});

test("the check veneer (toPass / toPassAll) works under vitest", () => {
  const trace = {
    toolCalls: [{ name: "Bash", input: {}, resultText: "", isError: false }],
    hooks: [],
    output: "done",
    modelRequests: [],
    turns: 1,
    file: () => null,
  };
  expect(trace).toPass(check.tool("Bash"));
  expect(trace).not.toPass(check.tool("Read"));
  expect(trace).toPassAll([check.tool("Bash"), check.output("done")]);
  expect({
    event: "PreToolUse",
    ran: true,
    blocked: true,
    exitCode: 2,
  }).toPass(check.hook("PreToolUse", { blocked: true }));
});

test("plain helpers work under vitest", () => {
  expect(compare(report, "vanilla", "gated").caught.gap).toBe(0.5);
  assertImproves(report, {
    baseline: "vanilla",
    arm: "gated",
    metric: "caught",
  });
  assertChecks(result, [
    check.writes({ include: ["DONE"], none: ["MISSING"] }),
  ]);
});

// The same `check.*` cases node:test and jest run (checks-cases.cjs).
for (const c of checksCases.CASES)
  test(`check.*: ${c.name}`, () => {
    expect(checksCases.verdict(c)).toBeUndefined();
  });
