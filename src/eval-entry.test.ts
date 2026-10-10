/**
 * `dist/eval-entry.js` — the program `vigiles eval` spawns per eval file.
 *
 * 🔴 NO `*.eval.*` FILE OF THIS REPOSITORY IS IMPORTED OR RUN HERE. The child
 * processes below are pointed at INERT STAND-INS in a temp dir whose only
 * "spend" is a marker file. Every path asserted stops before a model.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import {
  declarationProblem,
  driverMisplaced,
  notADescriptionMessage,
  runFailure,
  runsIn,
  trialsOverride,
  unansweredFailure,
} from "./eval-entry.js";
import { aggregateUsage, type EvalReport } from "./eval.js";
import { ARGV_REST, type StubCall } from "./core/stub-rules.js";

const DIST = resolve("dist");
const ENTRY = join(DIST, "eval-entry.js");

function standin(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-entry-"));
  const f = join(dir, name);
  writeFileSync(f, body);
  return f;
}

const runEntry = (file: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync("node", [ENTRY, file], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// --- pure ---------------------------------------------------------------------

test("trialsOverride: a real number wins, junk is IGNORED rather than read as zero", () => {
  assert.equal(trialsOverride("6"), 6);
  assert.equal(trialsOverride("2.7"), 2);
  assert.equal(trialsOverride(undefined), undefined);
  // The quiet half. A typo'd `--trials=` must not silently turn a measurement
  // into a no-op that then reports "no runs executed".
  assert.equal(trialsOverride(""), undefined);
  assert.equal(trialsOverride("abc"), undefined);
  assert.equal(trialsOverride("0"), undefined);
  assert.equal(trialsOverride("-3"), undefined);
});

test("runsIn reads the run count out of all five report shapes", () => {
  // Each measurement spells it differently and at a different depth — which is
  // exactly why every eval file used to hand-write `report.n === 0`, and why
  // several of them forgot to.
  assert.equal(runsIn({ n: 3 } as never), 3); // measure / triggerRate / selection
  assert.equal(runsIn({ arms: { a: { n: 2 }, b: { n: 1 } } } as never), 3); // measureArms
  assert.equal(runsIn({ arms: { a: { runs: 4 } } } as never), 4); // runEval
  assert.equal(runsIn({ arms: {} } as never), 0);
  assert.equal(runsIn({ nothing: true } as never), undefined);
});

test("the not-a-description message teaches the shape, not just the failure", () => {
  const m = notADescriptionMessage(
    "x.eval.mjs",
    declarationProblem({ why: "not-a-definition" }),
  );
  assert.match(m, /x\.eval\.mjs/);
  assert.match(m, /export default defineEval/);
  assert.match(m, /spends real/);
  assert.match(
    declarationProblem({ why: "declares-nothing" }),
    /declares no measurement/,
  );
  assert.match(
    declarationProblem({
      why: "declares-several",
      kinds: ["measure", "runEval"],
    }),
    /declares 2 measurements \(measure, runEval\) — declare exactly one/,
  );
});

test("an evalDriver declared where no seam exists is REFUSED, not ignored", () => {
  // Only `measureTriggerRate` takes a driver (docs/harnesses.md fn 2). A field
  // that silently did nothing would send a Codex user's run to Claude Code and
  // hand back the number as theirs.
  assert.match(
    driverMisplaced("runEval", true) ?? "",
    /cannot use it[\s\S]*measureTriggerRate/,
  );
  assert.match(driverMisplaced("measure", true) ?? "", /cannot use it/);
  // The quiet half — the one place it IS wired, and every place with no driver.
  assert.equal(driverMisplaced("measureTriggerRate", true), undefined);
  for (const k of [
    "runEval",
    "measure",
    "measureArms",
    "measureSelectionMatrix",
  ] as const)
    assert.equal(driverMisplaced(k, false), undefined);
});

// --- the process ---------------------------------------------------------------

test("the no-spend window is CLOSED while the file is imported, and open after", () => {
  const f = standin(
    "probe.eval.mjs",
    `import { inEvalLoad } from "${DIST}/core/eval-load-phase.js";\n` +
      `import { defineEval } from "${DIST}/test.js";\n` +
      `const during = inEvalLoad();\n` +
      `export default defineEval({\n` +
      `  measure: { task: "never runs", checks: [] },\n` +
      `  skipIf: () => \`window-during-load=\${during} window-in-hook=\${inEvalLoad()}\`,\n` +
      `});\n`,
  );
  const r = runEntry(f);
  assert.equal(r.status, 77, "skipIf must produce the runner's loud SKIP");
  assert.match(r.stdout, /window-during-load=true/);
  assert.match(r.stdout, /window-in-hook=false/);
});

test("a HALF-migrated file — a description plus a leftover top-level runner call — refuses instead of billing", () => {
  // The planted defect. `refuseDuringEvalLoad` is what the four real spawn
  // doors call as their first statement (asserted in core/eval-load-phase.test.ts),
  // so calling it here is the same door without any chance of a real spawn.
  const f = standin(
    "half.eval.mjs",
    `import { refuseDuringEvalLoad } from "${DIST}/core/eval-load-phase.js";\n` +
      `import { defineEval } from "${DIST}/test.js";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `refuseDuringEvalLoad("measureTriggerRate");\n` +
      `writeFileSync(new URL("./SPENT", import.meta.url), "spent");\n` +
      // 🔴 `skipIf` is a SAFETY BELT for this test, not decoration. When this
      // test is run under a MUTATION that neuters the guard, the entry proceeds
      // past the import — and without a skip it would call the real `measure`,
      // which spawns the real `claude` on this machine. Measured: the first
      // mutation run of this file did exactly that (44s, a real spawn) before
      // the belt was added. A test that verifies a money guard must not be able
      // to spend money when the guard is broken, because that is precisely the
      // condition it is run under.
      `export default defineEval({ measure: { task: "t", checks: [] }, skipIf: () => "belt: never reach a runner" });\n`,
  );
  const r = runEntry(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused to spawn a model/);
  assert.match(r.stderr, /defineEval/); // it teaches the fix
  assert.equal(
    existsSync(join(f, "..", "SPENT")),
    false,
    "the refusal must land BEFORE the spend",
  );
});

test("a TypeScript eval file is loaded through the same entry", () => {
  // `interpreterArgs` picks the loader from the SCRIPT's extension even though
  // the entry is JavaScript. If it picked from the entry instead, a `.eval.ts`
  // would fail to parse — a path no unit test of `interpreterArgs` can prove,
  // because the proof is whether node can actually import the file.
  const f = standin(
    "typed.eval.ts",
    `import { defineEval } from "${DIST}/test.js";\n` +
      `const why: string = "typed stand-in: no model";\n` +
      `export default defineEval({ measure: { task: "t", checks: [] }, skipIf: (): string => why });\n`,
  );
  const r = spawnSync("node", ["--import", "tsx", ENTRY, f], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: resolve("node_modules") },
    cwd: resolve("."),
  });
  assert.equal(r.status, 77, r.stdout + r.stderr);
  assert.match(r.stdout, /typed stand-in/);
});

test("a file that declares nothing is REPORTED, not passed green", () => {
  for (const [name, body, why] of [
    ["none.eval.mjs", `export default 42;\n`, /no `export default defineEval/],
    [
      "empty.eval.mjs",
      `import { defineEval } from "${DIST}/test.js";\nexport default defineEval({});\n`,
      /declares no measurement/,
    ],
    [
      "two.eval.mjs",
      `import { defineEval } from "${DIST}/test.js";\n` +
        `export default defineEval({ measure: { task: "t", checks: [] }, runEval: { arms: {}, task: "t" } });\n`,
      /declares 2 measurements/,
    ],
  ] as const) {
    const r = runEntry(standin(name, body));
    assert.equal(r.status, 1, `${name} should fail`);
    assert.match(r.stderr, why);
  }
});

test("a malformed declaration is reported even when the file would SKIP", () => {
  // Ordering, and it matters: a file that skips on this machine (no `claude`)
  // would otherwise hide its own misconfiguration until somebody ran it on a
  // machine where the capability exists.
  const f = standin(
    "misplaced.eval.mjs",
    `import { defineEval } from "${DIST}/test.js";\n` +
      `export default defineEval({\n` +
      `  measure: { task: "t", checks: [] },\n` +
      `  evalDriver: { runner: () => Promise.resolve({ code: 0, stdout: "" }), parse: () => ({}) },\n` +
      `  skipIf: () => "would have skipped",\n` +
      `});\n`,
  );
  const r = runEntry(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot use it/);
  assert.doesNotMatch(r.stdout, /SKIPPED/);
});

test("no argument is a usage error, not a silent success", () => {
  const r = spawnSync("node", [ENTRY], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expects one eval file/);
});

// --- an unanswered stub call fails the COMMAND, whatever `assert` does ----------

test("unansweredFailure: only a runEval report with an unanswered call is a failure", () => {
  const stubs = [
    {
      name: "gh",
      rules: [
        {
          argv: ["issue", "create", ARGV_REST],
          reply: { kind: "always", stdout: "u" },
        },
      ],
    },
  ];
  const report = (unansweredStubCalls: readonly StubCall[]): EvalReport => ({
    name: "e",
    trials: 1,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      with: {
        runs: 1,
        metrics: {},
        stats: {},
        usage: aggregateUsage([]),
        unansweredStubCalls,
      },
    },
  });
  const miss: StubCall = {
    tool: "gh",
    argv: ["auth", "status"],
    outcome: { kind: "no-rule" },
  };
  assert.match(
    unansweredFailure("runEval", report([miss]), { stubs }) ?? "",
    /gh \["auth","status"\] — no rule matches; the rules for gh are:\n\s+#1 \["issue", "create", experimental_stub\.rest\]/,
  );
  assert.equal(unansweredFailure("runEval", report([]), { stubs }), undefined);
  assert.equal(
    unansweredFailure("measure", report([miss]), { stubs }),
    undefined,
  );
  // zero runs is checked first, and keeps its own exit code
  assert.equal(
    runFailure("f", "runEval", { ...report([miss]), arms: {} }, { stubs })
      ?.code,
    1,
  );
  assert.equal(runFailure("f", "runEval", report([miss]), { stubs })?.code, 2);
  assert.equal(runFailure("f", "runEval", report([]), { stubs }), undefined);
});

/**
 * A fake `claude` on PATH that does what a model did in a measured run: runs the
 * `gh` argv lists in FAKE_GH_CALLS through its own PATH (where the eval put the
 * stub), then prints a result event. No model, no network.
 */
function fakeClaudeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "vigiles-fake-claude-"));
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\n` +
      `const { spawnSync } = require("node:child_process");\n` +
      `if (process.argv.includes("--version")) { console.log("9.9.9 (Claude Code)"); process.exit(0); }\n` +
      `for (const argv of JSON.parse(process.env.FAKE_GH_CALLS || "[]")) spawnSync("gh", argv, { stdio: "ignore" });\n` +
      `console.log(JSON.stringify({ type: "result", result: "filed", num_turns: 1 }));\n`,
    { mode: 0o755 },
  );
  return bin;
}

const STUBBED_EVAL =
  `import { defineEval, experimental_stub } from "${DIST}/test.js";\n` +
  `const { rest } = experimental_stub;\n` +
  `export default defineEval({\n` +
  `  runEval: {\n` +
  `    arms: { with: {} },\n` +
  `    task: "file it",\n` +
  `    trials: 1,\n` +
  `    spacingSec: 0,\n` +
  `    env: { kind: "inherit", reason: "test: a fake claude on PATH" },\n` +
  `    stubs: [experimental_stub("gh", [{ argv: ["issue", "create", rest], reply: { kind: "always", stdout: "https://github.com/o/r/issues/1\\n" } }])],\n` +
  `    measure: () => ({ ok: true }),\n` +
  `  },\n` +
  // The consumer's shape: `assert` never calls a vigiles helper.
  `  assert: () => {},\n` +
  `});\n`;

test("`vigiles eval` exits 2 on an unanswered stub call even when `assert` looks at nothing", () => {
  const bin = fakeClaudeBin();
  const file = standin("stubbed.eval.mjs", STUBBED_EVAL);
  const run = (calls: string[][]) =>
    spawnSync("node", [join(DIST, "cli.js"), "eval", file], {
      encoding: "utf8",
      cwd: dirname(file),
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_GH_CALLS: JSON.stringify(calls),
      },
    });
  const missed = run([
    ["auth", "status"],
    ["issue", "create", "-R", "o/r", "--title", "t", "--body", "b"],
  ]);
  assert.equal(missed.status, 2, missed.stdout + missed.stderr);
  // the file's diagnostic is relayed by the runner; the verb adds its own line
  assert.match(
    missed.stdout + missed.stderr,
    /gh \["auth","status"\] — no rule matches/,
  );
  assert.match(missed.stderr, /vigiles eval: a run called a stubbed tool/);
  // the control: every call answered → the same file passes
  const answered = run([
    ["issue", "create", "-R", "o/r", "--title", "t", "--body", "b"],
  ]);
  assert.equal(answered.status, 0, answered.stdout + answered.stderr);
});
