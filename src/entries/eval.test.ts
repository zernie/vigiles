/**
 * `paid_runEval(definition)` — the programmatic door — behaves as `vigiles eval`
 * does: the same outcomes and the same exit codes (vigiles#586).
 *
 * Every case runs in a CHILD process against `dist/`, because the door sets
 * `process.exitCode` and the exit code is the contract. The trigger-rate runs
 * use an injected driver, so no model is spawned; the one case that reaches a
 * real spawn door is the refusal, which stops before it.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve("dist");

/** Run an ES module script in a fresh node, outside every test runner. */
function runScript(body: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-door-"));
  const f = join(dir, "script.mjs");
  writeFileSync(f, body);
  // The child must look like a plain `node script.mjs`, not a vitest worker.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("VITEST") && k !== "NODE_TEST_CONTEXT",
    ),
  );
  return spawnSync("node", [f], { encoding: "utf8", env, cwd: dir });
}

const IMPORTS =
  `import { paid_runEval } from "${DIST}/entries/eval.js";\n` +
  `import { defineEval } from "${DIST}/entries/index.js";\n`;

/** A trigger-rate spec whose injected driver reports the skill firing every time. */
const TRIGGER =
  `const usage = { costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };\n` +
  `const evalDriver = {\n` +
  `  runner: () => Promise.resolve({ code: 0, stdout: "OK" }),\n` +
  `  parse: (out) => ({ turns: 1, output: out.stdout, toolCalls: [{ name: "Skill", input: {}, resultText: "", isError: false }], hooks: [], subagents: [], usage }),\n` +
  `};\n` +
  `const spec = { pluginDir: "/p", stubSkillBodies: false, prompts: ["x one", "x two", "x three"], minPrompts: 1, minDistance: 0,\n` +
  `  fired: (t) => t.toolCalls.some((c) => c.name === "Skill"), trials: 1, spacingSec: 0 };\n`;

const printOutcome = `console.log("OUTCOME=" + outcome.kind);\n`;

test("a passing description returns `passed` and leaves the exit code 0", () => {
  // Guards: the quiet half — the door must not fail a correct run.
  const r = runScript(
    IMPORTS +
      TRIGGER +
      `const outcome = await paid_runEval(defineEval({ measureTriggerRate: spec, evalDriver,\n` +
      `  assert: (report) => { if (report.rate < 1) throw new Error("rate"); } }));\n` +
      printOutcome,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OUTCOME=passed/);
});

test("a failing `assert` returns `failed` and exits 1 — a script that ignores the result still fails", () => {
  // Guards: the vigiles#416 parity bug — the direct call used to exit 0 where
  // `vigiles eval` exited 1.
  const r = runScript(
    IMPORTS +
      TRIGGER +
      `const outcome = await paid_runEval(defineEval({ measureTriggerRate: spec, evalDriver,\n` +
      `  assert: () => { throw new Error("planted failure"); } }));\n` +
      printOutcome,
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /OUTCOME=failed/);
  assert.match(r.stderr, /assert failed/);
  assert.match(r.stderr, /planted failure/);
});

test("a skip returns `skipped`, prints SKIPPED and sets no exit code", () => {
  const r = runScript(
    IMPORTS +
      `const outcome = await paid_runEval(defineEval({ runEval: { task: "never runs", checks: [] }, skipIf: () => "no model here" }));\n` +
      printOutcome,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SKIPPED.*no model here/);
  assert.match(r.stdout, /OUTCOME=skipped/);
});

test("a throw inside the run is a `failed` outcome with exit 1, not a rejection", () => {
  // Guards: Codex P1 on #587 — a throwing `skipIf` (or a measurement that
  // rejects) escaped as a rejection, so a script that caught it exited 0.
  const r = runScript(
    IMPORTS +
      `const outcome = await paid_runEval(defineEval({ runEval: { task: "t", checks: [] },\n` +
      `  skipIf: () => { throw new Error("planted skipIf throw"); } }));\n` +
      printOutcome,
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /OUTCOME=failed/);
  assert.match(r.stderr, /planted skipIf throw/);
});

test("a bare spec — the pre-#586 call — is refused with the migration, before any run", () => {
  const r = runScript(
    IMPORTS +
      `const outcome = await paid_runEval({ task: "t", checks: [] });\n` +
      printOutcome,
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /OUTCOME=refused/);
  assert.match(r.stderr, /defineEval\(\{ runEval:/);
});

test("a real-model runner called OUTSIDE any vigiles runner refuses before spawning", () => {
  // Guards: the runner-only rule end to end, through the built package. The
  // internal runner is imported straight from dist because no door exports it
  // any more; reaching it is exactly the accident the rule stops.
  const r = runScript(
    `import { runEval } from "${DIST}/eval.js";\n` +
      `import { check } from "${DIST}/entries/index.js";\n` +
      `try { await runEval({ task: "t", env: { kind: "local", inherit: "none" }, checks: [check.tool("Bash")], trials: 1 }); console.log("SPAWNED"); }\n` +
      `catch (e) { console.log(String(e.message).split("\\n")[0]); }\n`,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /SPAWNED/);
  assert.match(
    r.stdout,
    /refused to spawn a model: .* outside a vigiles runner/,
  );
});
