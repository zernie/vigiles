/**
 * THE INJECTED-DRIVER PATH, under a real foreign runner.
 *
 * 🔴 The refusal guarded the DEFAULT runner and nothing else. `measureTriggerRate(
 * spec, { evalDriver: paid_codexEvalDriver })` — the publicly documented alternative,
 * and the one the untested-skill nudge now tells Codex users to pass — calls the
 * injected driver's runner directly, which ends in `spawnSync("codex", …)`. So a
 * stray `npx vitest run` that collected a Codex eval spent real money on every
 * push while the guard looked complete. `judge` is the same story reached from
 * inside a user's `measure` callback.
 *
 * Driven through a REAL `node --test` child, for the reason `eval-node-test-guard.
 * test.ts` gives: this suite runs under vitest, so a test asserting "vitest is
 * refused" agrees with whatever the guard already believes. Only starting an
 * actual foreign runner can tell a working guard from a believed one.
 *
 * 🔴 SAFETY: the child runs with an EMPTY `PATH`. If a guard regresses, the spawn
 * is reached — and with no PATH there is no `codex`/`claude` to find, so the
 * regression fails this test instead of billing for it.
 *
 * Needs `dist/`; skips loudly otherwise.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const DIST = resolve(import.meta.dirname, "..", "dist");
const CODEX_EVAL = join(DIST, "adapters", "codex", "eval.js");
const JUDGE = join(DIST, "judge.js");

let dir: string;
beforeEach(() => {
  dir = makeTmpDir("injected-driver-guard");
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

const guardTest = existsSync(CODEX_EVAL) ? test : test.skip;

/** The Codex driver's own runner — what `measureTriggerRate` invokes directly. */
const CODEX_UNDER_NODE_TEST =
  `import assert from "node:assert/strict";\n` +
  `import { test } from "node:test";\n` +
  `import { paid_codexEvalDriver } from ${JSON.stringify(CODEX_EVAL)};\n` +
  `test("the injected Codex driver under node --test", async () => {\n` +
  // The runner returns a Promise, but the guard throws SYNCHRONOUSLY (it runs
  // before `Promise.resolve` wraps the result), so accept either shape rather
  // than pinning an implementation detail of how the refusal surfaces.
  `  let err = "";\n` +
  `  try { await paid_codexEvalDriver.runner({ task: "anything", cwd: ".", timeoutMs: 1000 }); }\n` +
  `  catch (e) { err = String(e); }\n` +
  `  assert.match(err, /running under node --test/,\n` +
  `    "the guard let a codex spawn start from inside node --test");\n` +
  `  assert.match(err, /codex exec/, "the refusal must name what it refused");\n` +
  `});\n`;

const JUDGE_UNDER_NODE_TEST =
  `import assert from "node:assert/strict";\n` +
  `import { test } from "node:test";\n` +
  `import { judge } from ${JSON.stringify(JUDGE)};\n` +
  `test("the judge under node --test", () => {\n` +
  `  assert.throws(() => judge({ rubric: "r", output: "o" }),\n` +
  `    /running under node --test/,\n` +
  `    "the guard let a claude spawn start from inside node --test");\n` +
  `});\n`;

guardTest(
  "FIRES: an injected eval driver refuses under a foreign runner",
  () => {
    // The path the finding is about, end to end: the driver's runner, reached the
    // way `measureTriggerRate(spec, { evalDriver })` reaches it.
    const r = run(write("codex.test.mjs", CODEX_UNDER_NODE_TEST), "--test");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pass 1/);
  },
);

guardTest(
  "FIRES: the model-graded judge refuses under a foreign runner too",
  () => {
    // Reached from inside a user's `measure` callback, so it never passes the eval
    // composition root at all — and it swallows exceptions, so the guard has to run
    // BEFORE its `try` or the refusal becomes a silent `score: 0`.
    const r = run(write("judge.test.mjs", JUDGE_UNDER_NODE_TEST), "--test");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pass 1/);
  },
);

guardTest(
  "QUIET: outside a foreign runner the same calls are NOT refused",
  () => {
    // The half that makes the guard a guard rather than an off switch. A plain
    // `node file.mjs` must get PAST the refusal and fail on the missing binary
    // instead (PATH is empty), so a fix that simply always threw would fail here.
    const fixture =
      `import { paid_codexEvalDriver } from ${JSON.stringify(CODEX_EVAL)};\n` +
      `import { judge } from ${JSON.stringify(JUDGE)};\n` +
      `let codexErr = "";\n` +
      `try { await paid_codexEvalDriver.runner({ task: "t", cwd: ".", timeoutMs: 1000 }); }\n` +
      `catch (e) { codexErr = String(e); }\n` +
      `const verdict = judge({ rubric: "r", output: "o" });\n` +
      `if (/running under/.test(codexErr)) { console.log("REFUSED-CODEX"); process.exit(1); }\n` +
      `if (/running under/.test(verdict.reason)) { console.log("REFUSED-JUDGE"); process.exit(1); }\n` +
      `console.log("PAST-THE-GUARD");\n`;
    const r = run(write("direct.mjs", fixture));
    assert.match(r.out, /PAST-THE-GUARD/, r.out);
  },
);
