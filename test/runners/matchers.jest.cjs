/**
 * Cross-runner constraint: the harness helpers + matchers work under **jest**.
 *
 * Same `vigilesMatchers` object as the vitest test — proving the integration is
 * genuinely runner-agnostic. The dist is CommonJS, so jest requires it natively
 * (no ESM flags, no babel — see jest.config.cjs `transform: {}`). Pure — no
 * model, no claude.
 *
 *   npm run test:jest
 */
const {
  assertCreated,
  assertNotCreated,
} = require("../../dist/harness-assert.js");
const { compare, assertImproves } = require("../../dist/eval-surface.js");
const { tool, output, blocked } = require("../../dist/check.js");
// Matchers are registered by the `vigiles/jest` entry via setupFilesAfterEnv
// (jest.config.cjs) — this file asserts that wiring works end-to-end.

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

test("vigilesMatchers register and work under jest", () => {
  expect(result).toHaveCreated("DONE");
  expect(result).not.toHaveCreated("MISSING");
  expect(report).toBeatBaseline("vanilla", "gated", "caught");
  expect(report).not.toBeatBaseline("vanilla", "gated", "caught", 0.9);
});

test("the check veneer (toPass / toPassAll) works under jest", () => {
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

test("plain helpers work under jest", () => {
  expect(compare(report, "vanilla", "gated").caught.gap).toBe(0.5);
  assertImproves(report, {
    baseline: "vanilla",
    arm: "gated",
    metric: "caught",
  });
  assertCreated(result, "DONE");
  assertNotCreated(result, "MISSING");
});
