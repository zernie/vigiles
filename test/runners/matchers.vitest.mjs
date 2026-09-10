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
import {
  improvement,
  assertImproves,
  assertCreated,
  assertNotCreated,
} from "../../dist/harness-assert.js";
import { tool, output, blocked } from "../../dist/check.js";
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
  expect(trace).toPass(tool("Bash"));
  expect(trace).not.toPass(tool("Read"));
  expect(trace).toPassAll([tool("Bash"), output("done")]);
  expect({ blocked: true, exitCode: 2 }).toPass(blocked());
});

test("plain helpers work under vitest", () => {
  expect(improvement(report, "vanilla", "gated", "caught")).toBe(0.5);
  assertImproves(report, {
    baseline: "vanilla",
    arm: "gated",
    metric: "caught",
  });
  assertCreated(result, "DONE");
  assertNotCreated(result, "MISSING");
});
