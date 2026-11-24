/**
 * The paid tier, under Node's OWN test runner, for real.
 *
 * `core/foreign-runner.test.ts` drives the decision with the process facts as
 * data; `eval.test.ts` proves the composition root calls it — but both of those
 * run under vitest, and vitest is the runner the guard already recognised. The
 * defect this file exists for is precisely the one such a test cannot see: the
 * `node --test` entry in the runner table was `node_modules/.bin/node--test`, a
 * path that does not exist for a runner that is a FLAG on node, so it matched
 * nothing ever. A unit test written from the same wrong belief would have agreed
 * with it. Only starting a real `node --test` and asking what the guard does can
 * tell them apart — so that is what this does.
 *
 * 🔴 SAFETY: the child runs with an EMPTY `PATH`. If the guard ever regresses,
 * `spawnAgent` reaches its `spawn("claude", …)` — and with no PATH there is no
 * `claude` to find, so a regression fails this test instead of billing for it.
 *
 * Deterministic, model-free, offline → the free unit tier. Needs `dist/`
 * (`npm test` / CI build it); skips loudly otherwise, like tool-intercept.test.ts.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

// __dirname is src/ when vitest resolves the .ts source → ".." is the repo root.
const EVAL = resolve(import.meta.dirname, "..", "dist", "eval.js");
const FOREIGN_RUNNER = resolve(
  import.meta.dirname,
  "..",
  "dist",
  "core",
  "foreign-runner.js",
);

let dir: string;

beforeEach(() => {
  dir = makeTmpDir("node-test-guard");
});

afterEach(() => {
  cleanupTmpDir(dir);
});

/** Run a fixture with node, from the tmp dir, with NO `PATH` — see the header. */
function run(
  file: string,
  ...nodeArgs: string[]
): { code: number; out: string } {
  const r = spawnSync(process.execPath, [...nodeArgs, file], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 60000,
    env: { PATH: "" },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function write(rel: string, body: string): string {
  const abs = join(dir, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/** A file that reaches the real paid entry point and reports what happened. */
const CALLS_THE_PAID_TIER =
  `import assert from "node:assert/strict";\n` +
  `import { test } from "node:test";\n` +
  `import { spawnAgent } from ${JSON.stringify(EVAL)};\n` +
  `test("the paid tier under node --test", () => {\n` +
  `  assert.throws(() => spawnAgent({ task: "anything", cwd: "." }),\n` +
  `    /running under node --test/,\n` +
  `    "the guard let a model spawn start from inside node --test");\n` +
  `});\n`;

const guardTest = existsSync(EVAL) ? test : test.skip;

/**
 * Does THIS node understand `--experimental-test-isolation=none`?
 *
 * 🔴 PROBED, NOT ASSUMED, AND NOT A VERSION COMPARISON. The flag landed in Node
 * 22; CI runs Node 20, where it is not "ignored" but rejected outright — `bad
 * option`, exit 9 — so the assertion below failed on a runner that cannot reach
 * the branch it tests. A version check would work today and rot the moment the
 * flag is renamed or promoted out of experimental; asking the binary cannot.
 *
 * The skip is LOUD. A quietly-skipped test is the failure mode this whole branch
 * exists to remove: silence that reads like a pass.
 */
const isolationNoneSupported = ((): boolean => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-test-isolation=none", "-e", ""],
    { encoding: "utf8" },
  );
  return r.status === 0;
})();
if (!isolationNoneSupported)
  console.warn(
    `[eval-node-test-guard] node ${process.version} does not support ` +
      `--experimental-test-isolation=none — skipping the execArgv half of the ` +
      `guard. The NODE_TEST_CONTEXT half still runs.`,
  );

guardTest(
  "a legacy `*.test.mjs` collected by `node --test` cannot reach the model",
  () => {
    const file = write("foo.test.mjs", CALLS_THE_PAID_TIER);
    const { code, out } = run(file, "--test");
    assert.equal(code, 0, `node --test did not pass:\n${out}`);
    assert.match(
      out,
      /pass 1/,
      `no test ran — the file never executed:\n${out}`,
    );
  },
);

(guardTest === test && isolationNoneSupported ? test : test.skip)(
  "…including --experimental-test-isolation=none, where node spawns no child",
  () => {
    // The other half of the runner: no NODE_TEST_CONTEXT is set here, so this
    // fails if `execArgv` is not consulted.
    const file = write("foo.test.mjs", CALLS_THE_PAID_TIER);
    const { code, out } = run(
      file,
      "--test",
      "--experimental-test-isolation=none",
    );
    assert.equal(code, 0, `isolation=none did not pass:\n${out}`);
    assert.match(out, /pass 1/, out);
  },
);

guardTest(
  "…and a plain `node foo.eval.mjs` is still NOT refused — that is how an eval runs",
  () => {
    // The quiet half, against the REAL process facts rather than a fixture of
    // them: a guard that fires on the correct invocation is one people delete.
    // `spawnAgent` is not called here on purpose — the assertion is about the
    // verdict, and calling it on a passing verdict is what spends money.
    const file = write(
      "foo.eval.mjs",
      `import assert from "node:assert/strict";\n` +
        `import { foreignRunner } from ${JSON.stringify(FOREIGN_RUNNER)};\n` +
        `assert.equal(foreignRunner(process.argv[1], {\n` +
        `  execArgv: process.execArgv,\n` +
        `  nodeTestContext: process.env.NODE_TEST_CONTEXT,\n` +
        `}), null, "a direct node run must not be taken for a foreign runner");\n` +
        `console.log("eval ran");\n`,
    );
    const { code, out } = run(file);
    assert.equal(code, 0, out);
    assert.match(out, /eval ran/, out);
  },
);
