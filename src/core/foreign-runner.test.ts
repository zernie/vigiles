/**
 * The paid tier must not be reachable from somebody else's test runner. Pure:
 * the argv paths below were MEASURED from real runs, not invented.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { foreignRunner, foreignRunnerRefusal } from "./foreign-runner.js";

test("recognises the path vitest actually starts a worker with", () => {
  // Measured 2026-08-11 by writing process.argv[1] to a file from inside a test.
  assert.equal(
    foreignRunner("/repo/node_modules/vitest/dist/workers/forks.js"),
    "vitest",
  );
});

test("recognises jest and its worker", () => {
  assert.equal(foreignRunner("/repo/node_modules/jest/bin/jest.js"), "jest");
  assert.equal(
    foreignRunner("/repo/node_modules/jest-worker/build/index.js"),
    "jest",
  );
  assert.equal(foreignRunner("/repo/node_modules/.bin/jest"), "jest");
});

test("a direct `node <file>` run is NOT a foreign runner", () => {
  // The quiet half: `vigiles eval` itself runs `node <program> <file>`, so this
  // guard must stay silent there. A spawn outside any vigiles runner is refused
  // by a different guard, `refuseOutsideRunner` (core/eval-load-phase.ts).
  assert.equal(foreignRunner("/repo/.claude/skills/foo/foo.eval.mjs"), null);
  assert.equal(foreignRunner("/repo/dist/cli.js"), null);
  assert.equal(foreignRunner(undefined), null);
});

test("recognises mocha and ava, in-process and in their workers", () => {
  // Measured 2026-08-12 the same way (a probe printing process.argv from inside
  // a real run of each), because the table held one entry nobody had measured.
  assert.equal(foreignRunner("/repo/node_modules/.bin/mocha"), "mocha");
  assert.equal(
    foreignRunner("/repo/node_modules/mocha/lib/nodejs/worker.js"),
    "mocha",
  ); // `mocha --parallel`
  assert.equal(
    foreignRunner("/repo/node_modules/ava/lib/worker/base.js"),
    "ava",
  );
});

// --- node --test -------------------------------------------------------------
//
// 🔴 The entry for this runner used to be `node_modules/.bin/node--test`, a path
// that cannot exist: Node's runner is a FLAG on node, not an installed binary.
// It could never match under any invocation, so the paid tier stayed reachable
// from `node --test` for the whole life of the guard, while the table read as
// though it were covered.

test("node --test is caught in its default CHILD-process mode", () => {
  // Measured 2026-08-12: argv[1] is the TEST FILE itself and execArgv is empty —
  // there is nothing in argv to recognise. `NODE_TEST_CONTEXT=child-v8` is the
  // only signal, and NODE sets it, not a human.
  assert.equal(
    foreignRunner("/repo/.claude/skills/foo/foo.test.mjs", {
      execArgv: [],
      nodeTestContext: "child-v8",
    }),
    "node --test",
  );
});

test("…and in --experimental-test-isolation=none, where there is no child at all", () => {
  // The in-process mode sets no env var; there the flag stays visible in execArgv.
  assert.equal(
    foreignRunner("foo.test.mjs", {
      execArgv: ["--test", "--experimental-test-isolation=none"],
    }),
    "node --test",
  );
});

test("…but a plain `node` run carrying a test-ish flag is NOT node --test", () => {
  // The quiet half. `--test-only` / `--test-name-pattern` are ordinary flags a
  // legitimate `node foo.eval.mjs` may carry, so a PREFIX match would refuse the
  // correct invocation — the exact failure that got `process.env.VITEST`
  // rejected. An empty NODE_TEST_CONTEXT is likewise not a runner.
  assert.equal(
    foreignRunner("/repo/foo.eval.mjs", {
      execArgv: ["--test-only", "--test-name-pattern=x"],
      nodeTestContext: "",
    }),
    null,
  );
  assert.equal(foreignRunner("/repo/foo.eval.mjs", {}), null);
  assert.equal(foreignRunner("/repo/foo.eval.mjs"), null);
});

test("a project that merely HAS vitest as a dependency is not running under it", () => {
  // The argv path is what node was started with, not what is installed. A repo
  // with vitest in node_modules but started as `node script.mjs` must run.
  assert.equal(foreignRunner("/repo/scripts/nightly.mjs"), null);
});

test("windows separators resolve the same", () => {
  assert.equal(
    foreignRunner("C:\\repo\\node_modules\\vitest\\dist\\workers\\forks.js"),
    "vitest",
  );
});

test("the refusal names the runner, the cost and the way out", () => {
  const m = foreignRunnerRefusal("vitest", "measureTriggerRate");
  assert.match(m, /vitest/);
  assert.match(m, /spends real model calls/);
  assert.match(m, /vigiles eval/); // what to run instead
  assert.match(m, /\.eval\.mjs/); // and what to call the file
});
