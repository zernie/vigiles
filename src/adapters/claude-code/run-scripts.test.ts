/**
 * Tests for the `vigiles test` / `vigiles eval` script runner (src/run-scripts.ts).
 * Discovery and formatting are pure-ish; `runScripts` spawns trivial node
 * scripts in a temp dir, so the whole suite stays fast and model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoverScripts,
  runScripts,
  formatScriptSummary,
  anyFailed,
  interpreterArgs,
  detectNodeCaps,
  scriptGlob,
  SCRIPT_EXTS,
  decideRunScripts,
  statusFor,
  loadFailed,
  SKIP_EXIT_CODE,
} from "./run-scripts.js";
import { EXCLUDE_FLOOR, excludeSet } from "../../exclude.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

test("discoverScripts expands the default glob, deduped and sorted", () => {
  const dir = makeTmpDir("run-scripts");
  try {
    writeFileSync(join(dir, "b.harness.mjs"), "");
    writeFileSync(join(dir, "a.harness.mjs"), "");
    writeFileSync(join(dir, "ignore.eval.mjs"), "");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "x.harness.mjs"), "");

    const found = discoverScripts([], "**/*.harness.mjs", dir, EXCLUDE_FLOOR);
    assert.deepEqual(found, ["a.harness.mjs", "b.harness.mjs"]);
  } finally {
    cleanupTmpDir(dir);
  }
});

// 🔴 The regression this exists for: a harness under `.claude/` was invisible to
// `vigiles test` and `vigiles eval`, in a tool whose whole subject is Claude Code
// harnesses — `.claude/` is where one lives by definition. The symptom was "no files
// found" printed at a repository holding two of them, and a `Tested` score reporting
// visibility rather than coverage. `node_modules` must stay excluded, so this asserts
// both halves: dot-directories in, dependencies still out.
test("discoverScripts finds harnesses inside dot-directories", () => {
  const dir = makeTmpDir("run-scripts");
  try {
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hooks", "hooks.harness.mjs"), "");
    mkdirSync(join(dir, ".claude", "pipeline"), { recursive: true });
    writeFileSync(join(dir, ".claude", "pipeline", "gates.harness.mjs"), "");
    writeFileSync(join(dir, "top.harness.mjs"), "");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "dep.harness.mjs"), "");

    const found = discoverScripts([], "**/*.harness.mjs", dir, EXCLUDE_FLOOR);
    assert.deepEqual(found, [
      ".claude/hooks/hooks.harness.mjs",
      ".claude/pipeline/gates.harness.mjs",
      "top.harness.mjs",
    ]);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("discoverScripts passes an explicit file path through", () => {
  const dir = makeTmpDir("run-scripts");
  try {
    writeFileSync(join(dir, "only.eval.mjs"), "");
    writeFileSync(join(dir, "other.eval.mjs"), "");
    const found = discoverScripts(
      ["only.eval.mjs"],
      "**/*.eval.mjs",
      dir,
      EXCLUDE_FLOOR,
    );
    assert.deepEqual(found, ["only.eval.mjs"]);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("discoverScripts: an excluded path is not discovered, but is still run when named (#192)", () => {
  const dir = makeTmpDir("run-scripts");
  try {
    mkdirSync(join(dir, "vendored", "corpus"), { recursive: true });
    writeFileSync(join(dir, "vendored", "corpus", "theirs.harness.mjs"), "");
    writeFileSync(join(dir, "ours.harness.mjs"), "");
    // A bare directory name, no `/**` — the spelling glob's own string ignore
    // silently matched nothing (measured 2026-09-03), so it is the one to pin.
    const excludes = excludeSet(dir, ["vendored"]);
    // Discovery: fires on the clean side (ours found) AND drops the excluded one.
    assert.deepEqual(
      discoverScripts([], "**/*.harness.mjs", dir, excludes.ignore),
      ["ours.harness.mjs"],
    );
    // Control: the same tree with an empty exclude finds both, so the assertion
    // above cannot pass by finding nothing.
    assert.deepEqual(
      discoverScripts([], "**/*.harness.mjs", dir, excludeSet(dir, []).ignore),
      ["ours.harness.mjs", "vendored/corpus/theirs.harness.mjs"],
    );
    // An explicit path wins: exclude filters discovery, not an argument.
    assert.deepEqual(
      discoverScripts(
        ["vendored/corpus/theirs.harness.mjs"],
        "**/*.harness.mjs",
        dir,
        excludes.ignore,
      ),
      ["vendored/corpus/theirs.harness.mjs"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("runScripts reports per-file exit codes and forwards env", async () => {
  const dir = makeTmpDir("run-scripts");
  try {
    writeFileSync(join(dir, "ok.mjs"), "process.exit(0);\n");
    writeFileSync(join(dir, "bad.mjs"), "process.exit(3);\n");
    writeFileSync(
      join(dir, "env.mjs"),
      "process.exit(process.env.VIGILES_TRIALS === '7' ? 0 : 9);\n",
    );

    const results = await runScripts(["ok.mjs", "bad.mjs", "env.mjs"], dir, {
      VIGILES_TRIALS: "7",
    });
    assert.deepEqual(
      results.map((r) => r.code),
      [0, 3, 0],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("scriptGlob matches both JS and TS extensions", () => {
  assert.equal(scriptGlob("harness"), "**/*.harness.{mjs,cjs,js,mts,cts,ts}");
  assert.equal(scriptGlob("eval"), "**/*.eval.{mjs,cjs,js,mts,cts,ts}");
  assert.ok(SCRIPT_EXTS.includes("ts") && SCRIPT_EXTS.includes("mjs"));
});

test("discoverScripts finds TS scripts alongside JS via the default glob", () => {
  const dir = makeTmpDir("run-scripts");
  try {
    writeFileSync(join(dir, "a.harness.mjs"), "");
    writeFileSync(join(dir, "b.harness.ts"), "");
    writeFileSync(join(dir, "c.harness.mts"), "");
    const found = discoverScripts(
      [],
      scriptGlob("harness"),
      dir,
      EXCLUDE_FLOOR,
    );
    assert.deepEqual(found, ["a.harness.mjs", "b.harness.ts", "c.harness.mts"]);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("interpreterArgs runs plain JS directly", () => {
  for (const f of ["x.harness.mjs", "x.harness.cjs", "x.harness.js"]) {
    assert.deepEqual(interpreterArgs(f, { tsx: false, stripTypes: false }), [
      f,
    ]);
  }
});

test("interpreterArgs prefers tsx for TS, else native strip-types", () => {
  assert.deepEqual(
    interpreterArgs("x.harness.ts", { tsx: true, stripTypes: true }),
    ["--import", "tsx", "x.harness.ts"],
  );
  assert.deepEqual(
    interpreterArgs("x.harness.mts", { tsx: false, stripTypes: true }),
    ["--experimental-strip-types", "x.harness.mts"],
  );
});

test("interpreterArgs interposes an ENTRY, keeping the loader flags for the SCRIPT's language", () => {
  // `vigiles eval` passes an entry because an eval file describes its eval
  // instead of being a program. The subtle half: a JavaScript entry importing a
  // TypeScript eval still needs tsx installed, so the flags are chosen from the
  // SCRIPT's extension, not the entry's.
  assert.deepEqual(
    interpreterArgs(
      "x.eval.mjs",
      { tsx: false, stripTypes: false },
      "/d/eval-entry.js",
    ),
    ["/d/eval-entry.js", "x.eval.mjs"],
  );
  assert.deepEqual(
    interpreterArgs(
      "x.eval.ts",
      { tsx: true, stripTypes: true },
      "/d/eval-entry.js",
    ),
    ["--import", "tsx", "/d/eval-entry.js", "x.eval.ts"],
  );
  assert.deepEqual(
    interpreterArgs(
      "x.eval.mts",
      { tsx: false, stripTypes: true },
      "/d/eval-entry.js",
    ),
    ["--experimental-strip-types", "/d/eval-entry.js", "x.eval.mts"],
  );
  // The quiet half: no entry → byte-identical to before (harness scripts).
  assert.deepEqual(
    interpreterArgs("x.harness.mjs", { tsx: false, stripTypes: false }),
    ["x.harness.mjs"],
  );
});

test("runScripts passes the script to the entry as an argument", async () => {
  const dir = makeTmpDir("entry");
  try {
    writeFileSync(
      join(dir, "entry.cjs"),
      "console.log('ENTRY GOT ' + process.argv[2]);\n",
    );
    writeFileSync(join(dir, "x.eval.mjs"), "process.exit(3);\n"); // must NOT run
    const [r] = await runScripts(
      ["x.eval.mjs"],
      dir,
      {},
      { entry: join(dir, "entry.cjs") },
    );
    assert.equal(r?.code, 0, "the eval file itself must not be the program");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("interpreterArgs throws an actionable error when TS can't run", () => {
  assert.throws(
    () => interpreterArgs("x.harness.ts", { tsx: false, stripTypes: false }),
    /install tsx.*Node >= 22\.6/s,
  );
});

test("detectNodeCaps reports tsx presence from node_modules", () => {
  const dir = makeTmpDir("run-scripts");
  try {
    assert.equal(detectNodeCaps(dir).tsx, false);
    mkdirSync(join(dir, "node_modules", "tsx"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "tsx", "package.json"), "{}");
    assert.equal(detectNodeCaps(dir).tsx, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("runScripts surfaces an error code for an unrunnable TS script", async () => {
  const dir = makeTmpDir("run-scripts");
  try {
    // A .ts file with no tsx and (on older node) no strip-types still yields a
    // non-zero result rather than throwing out of runScripts.
    writeFileSync(join(dir, "t.harness.ts"), "export {};\n");
    const results = await runScripts(["t.harness.ts"], dir);
    assert.equal(results.length, 1);
    assert.equal(typeof results[0]?.code, "number");
  } finally {
    cleanupTmpDir(dir);
  }
});

// --- the fourth state: ran, verified nothing (dogfood 2026-08-08) -------------
//
// 🔴 The defect. `statusForCode` knew exit codes and nothing else, so a file that
// ran NOTHING printed the same `✓ 1 passed` as one that ran and passed. Measured
// on `export default { "never runs": () => assert.equal(1, 2) }` — a false
// assertion, never called, reported green. A consumer repo hit it and now
// hand-copies a warning into every new harness header, eight of them, because the
// runner could not enforce it.

test("statusFor: 0 reported checks is its own state, and silence is NOT zero", () => {
  assert.equal(statusFor(0, 3), "pass");
  assert.equal(statusFor(0, 0), "vacuous", "ran clean, verified nothing");
  assert.equal(
    statusFor(0, undefined),
    "pass",
    "no report at all is the legacy branch — 'nobody counted' is not 'counted zero'",
  );
  // The other two states are unchanged, count or no count.
  assert.equal(statusFor(SKIP_EXIT_CODE, undefined), "skip");
  assert.equal(statusFor(SKIP_EXIT_CODE, 0), "skip");
  assert.equal(statusFor(1, 5), "fail");
  assert.equal(statusFor(1, 0), "fail");
});

// --- did it LOAD? (#243) — decided by a marker, never by the child's output ----
//
// `LoadEvidence` comes from the runner's own load hook: `marked` = the hook saw
// the script's entry module as an ES module and planted a marker import at the
// top of it; `linked` = that marker evaluated, i.e. the whole import graph was
// found, parsed and linked. Only "marked and never linked" is did-not-load.
const linked = { marked: true, linked: true } as const;
const neverLinked = { marked: true, linked: false } as const;
const unmarked = { marked: false, linked: false } as const;

test("statusFor: marked but never linked is did-not-load (a skip that keeps coverage)", () => {
  assert.equal(statusFor(1, undefined, neverLinked), "skip");
  // The exit code stays whatever the loader gave it, so the caller can still
  // tell this apart from a DECLARED skip (77) — see `loadFailed`.
});

test("statusFor: a script that LINKED and then exited non-zero failed, whatever it printed", () => {
  // The #243 bug: a harness that printed a hook transcript containing
  // "Cannot find module" and then failed an assertion was read as did-not-load.
  // Output is no longer an input at all, so no text can move this.
  assert.equal(statusFor(1, undefined, linked), "fail");
  assert.equal(statusFor(1, 3, linked), "fail");
});

test("statusFor: no marker means no claim — conservatively a fail", () => {
  // CommonJS entries (and anything the hook never saw) get no marker, so the
  // absence of `linked` proves nothing about them. Retracting is the safe side.
  assert.equal(statusFor(1, undefined, unmarked), "fail");
  assert.equal(statusFor(1, undefined), "fail", "no evidence at all");
});

test("statusFor: a reported count proves the module ran, even with a missing marker file", () => {
  assert.equal(statusFor(1, 0, neverLinked), "fail");
  assert.equal(statusFor(1, 2, neverLinked), "fail");
});

test("statusFor: exit 0 and exit 77 do not consult load evidence", () => {
  assert.equal(statusFor(0, 2, neverLinked), "pass");
  assert.equal(statusFor(0, 0, neverLinked), "vacuous");
  assert.equal(statusFor(SKIP_EXIT_CODE, undefined, unmarked), "skip");
});

test("discoverScripts does not accept a directory as a script", () => {
  const dir = makeTmpDir("run-scripts-dir");
  try {
    const file = join(dir, "a.harness.mjs");
    writeFileSync(file, "export default {};");
    mkdirSync(join(dir, "sub"));

    // FIRES: a directory contributes nothing, so the caller's loud
    // nothing-matched path owns the message instead of `spawn("node", ["."])`
    // dying with a resolver stack that then read as a skip.
    assert.deepEqual(
      discoverScripts(["sub"], scriptGlob("harness"), dir, EXCLUDE_FLOOR),
      [],
      "a directory exists but is not a file — `existsSync` could not tell",
    );
    assert.deepEqual(
      discoverScripts(["."], scriptGlob("harness"), dir, EXCLUDE_FLOOR),
      [],
      "`.` is the spelling from the report",
    );

    // SILENT: a named file is still passed through verbatim.
    assert.deepEqual(
      discoverScripts(
        ["a.harness.mjs"],
        scriptGlob("harness"),
        dir,
        EXCLUDE_FLOOR,
      ),
      ["a.harness.mjs"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

/** The built `check-count.js`, as a URL a spawned fixture script can import. */
function countModuleUrl(): string {
  return pathToFileURL(resolve(process.cwd(), "dist/check-count.js")).href;
}

test("runScripts reports 0 checks for a script that loads the API and runs nothing", async () => {
  const dir = makeTmpDir("run-scripts-vacuous");
  try {
    const mod = JSON.stringify(countModuleUrl());
    // The incident, reproduced: tests DEFINED, nothing called. Exits 0.
    writeFileSync(
      join(dir, "vacuous.harness.mjs"),
      `import { recordCheck } from ${mod};\n` +
        `export default { "never runs": () => { recordCheck(); } };\n`,
    );
    // The control: same import, actually calls it.
    writeFileSync(
      join(dir, "real.harness.mjs"),
      `import { recordCheck } from ${mod};\nrecordCheck();\nrecordCheck();\n`,
    );
    // The legacy shape: never touches vigiles, so it cannot report. Unchanged.
    writeFileSync(join(dir, "legacy.harness.mjs"), "process.exit(0);\n");

    const r = await runScripts(
      ["vacuous.harness.mjs", "real.harness.mjs", "legacy.harness.mjs"],
      dir,
    );
    assert.deepEqual(
      r.map((x) => [x.status, x.checks]),
      [
        ["vacuous", 0],
        ["pass", 2],
        ["pass", undefined],
      ],
    );
    // …and it must not turn CI red: harnesses in the wild predate the counter.
    assert.equal(anyFailed(r), false);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a script's spawned CHILD does not inherit the report path", async () => {
  // A harness spawns processes for a living. A child that inherited the count
  // path would write ITS count — usually zero — over the parent's, reporting a
  // sub-process's activity as the file's. The variable is read once and dropped,
  // so the child cannot see it at all. Asserted from INSIDE the child, because
  // spawnSync makes the parent write last, which would mask the bug end-to-end.
  const dir = makeTmpDir("run-scripts-nested");
  try {
    const mod = JSON.stringify(countModuleUrl());
    writeFileSync(
      join(dir, "parent.harness.mjs"),
      `import { recordCheck } from ${mod};\n` +
        `import { spawnSync } from "node:child_process";\n` +
        `recordCheck(4);\n` +
        `const probe = "process.exit(process.env.VIGILES_CHECK_COUNT_FILE ? 3 : 0)";\n` +
        `const r = spawnSync(process.execPath, ["-e", probe]);\n` +
        `if (r.status !== 0) process.exit(9); // the child could see the path\n`,
    );
    const [r] = await runScripts(["parent.harness.mjs"], dir);
    assert.equal(r?.code, 0, "the spawned child must not see the report path");
    assert.equal(r?.checks, 4, "the parent's own count is what gets reported");
    assert.equal(r?.status, "pass");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("formatScriptSummary shows a 0-check run as its own state, with the remedy", () => {
  const out = formatScriptSummary([
    { file: "a.mjs", code: 0, status: "pass", checks: 2 },
    { file: "b.mjs", code: 0, status: "vacuous", checks: 0 },
  ]);
  assert.match(out, /∅ b\.mjs — 0 CHECKS/);
  assert.doesNotMatch(out, /2 passed/); // NOT folded into the pass tally
  assert.match(out, /1 passed, 1 with 0 checks\./);
  assert.match(out, /recordCheck\(\)/); // the fix is named where it is read
});

test("formatScriptSummary tallies pass/skip/fail; skips are loud, not a pass", () => {
  const pass = formatScriptSummary([
    { file: "a.mjs", code: 0, status: "pass" },
    { file: "b.mjs", code: 0, status: "pass" },
  ]);
  assert.match(pass, /✓ a\.mjs/);
  assert.match(pass, /2 passed\./);

  const mixed = formatScriptSummary([
    { file: "a.mjs", code: 0, status: "pass" },
    { file: "b.mjs", code: 77, status: "skip" },
    { file: "c.mjs", code: 2, status: "fail" },
  ]);
  assert.match(mixed, /⊘ b\.mjs — SKIPPED/); // shown, not silent
  assert.match(mixed, /✗ c\.mjs \(exit 2\)/);
  assert.match(mixed, /1 passed, 1 skipped, 1 failed\./);
});

test("anyFailed: a skip never counts as a failure", () => {
  assert.equal(
    anyFailed([
      { file: "a.mjs", code: 0, status: "pass" },
      { file: "b.mjs", code: 77, status: "skip" },
    ]),
    false,
  );
  assert.equal(anyFailed([{ file: "c.mjs", code: 2, status: "fail" }]), true);
});

test("runScripts classifies exit 77 as skip, 0 as pass, else fail", async () => {
  const dir = makeTmpDir("run-scripts");
  try {
    writeFileSync(join(dir, "ok.mjs"), "process.exit(0);\n");
    writeFileSync(join(dir, "skip.mjs"), "process.exit(77);\n");
    writeFileSync(join(dir, "bad.mjs"), "process.exit(1);\n");
    const r = await runScripts(["ok.mjs", "skip.mjs", "bad.mjs"], dir);
    assert.deepEqual(
      r.map((x) => x.status),
      ["pass", "skip", "fail"],
    );
    assert.equal(anyFailed(r), true);
  } finally {
    cleanupTmpDir(dir);
  }
});

// --- decideRunScripts: the eval no-target consent gate --------------------------

const evalEnv = (o: Partial<Parameters<typeof decideRunScripts>[0]> = {}) => ({
  kind: "eval" as const,
  explicitTargets: false,
  matchedCount: 5,
  isTTY: false,
  all: false,
  yes: false,
  lockCheck: false,
  ...o,
});

test("decideRunScripts: `test` always runs (free/deterministic), never gated", () => {
  assert.deepEqual(
    decideRunScripts(evalEnv({ kind: "test", matchedCount: 999 })),
    { kind: "run" },
  );
});

test("decideRunScripts: explicit targets always run (clear intent)", () => {
  assert.deepEqual(
    decideRunScripts(evalEnv({ explicitTargets: true, isTTY: false })),
    { kind: "run" },
  );
});

test("decideRunScripts: --all opts into the whole set with no prompt", () => {
  assert.deepEqual(decideRunScripts(evalEnv({ all: true })), { kind: "run" });
});

test("decideRunScripts: --yes / --no-interactive runs (agent/CI)", () => {
  assert.deepEqual(decideRunScripts(evalEnv({ yes: true })), { kind: "run" });
});

test("decideRunScripts: 0 or 1 discovered eval is bounded → runs, no gate", () => {
  assert.deepEqual(decideRunScripts(evalEnv({ matchedCount: 0 })), {
    kind: "run",
  });
  assert.deepEqual(decideRunScripts(evalEnv({ matchedCount: 1 })), {
    kind: "run",
  });
});

test("decideRunScripts: bare eval over many, headless → REFUSE (the footgun)", () => {
  assert.deepEqual(
    decideRunScripts(evalEnv({ matchedCount: 7, isTTY: false })),
    {
      kind: "refuse",
      count: 7,
    },
  );
});

test("decideRunScripts: bare eval over many, at a TTY → CONFIRM", () => {
  assert.deepEqual(
    decideRunScripts(evalEnv({ matchedCount: 7, isTTY: true })),
    {
      kind: "confirm",
      count: 7,
    },
  );
});

// Both directions, because either alone is worthless here. The gate exists to
// stop an unbounded fan-out from spending model quota; `--check` cannot spend
// any (decideLock in check mode returns `replay` or `stale`, never `run`), so it
// must pass the gate while a bare run over the same set is still refused.
//
// This is the case CI met on 2026-09-09: the `eval-check` step had never once
// executed, because with no lock committed anywhere `eval --check` returned
// early on `anyLocksCommitted`. The first commit of a lock reached this gate and
// was refused exit 2 — a step that had been green only because it never ran.
test("decideRunScripts: --check verifies locks, so it is NOT quota-gated", () => {
  assert.deepEqual(
    decideRunScripts(
      evalEnv({ matchedCount: 23, isTTY: false, lockCheck: true }),
    ),
    { kind: "run" },
  );
});

test("decideRunScripts: the same set WITHOUT --check is still refused", () => {
  assert.deepEqual(
    decideRunScripts(evalEnv({ matchedCount: 23, isTTY: false })),
    { kind: "refuse", count: 23 },
  );
});

test("the runner reads back WHICH surfaces a script exercised", async () => {
  // The channel's second job: coverage answers "tested?" from execution, and
  // this is the wire it travels on. The fixture attributes through the tier
  // (runHook derives the hook from the command), not by declaring anything.
  const dir = makeTmpDir("run-scripts-surfaces");
  try {
    const hook = pathToFileURL(resolve(process.cwd(), "dist/run-hook.js")).href;
    const mod = JSON.stringify(countModuleUrl());
    // The hook has to EXIST and run. It used to be absent, and the fixture still
    // "attributed" it: `bash <missing>` exits 127 without launching anything, so
    // the assertion below was satisfied by a hook that never ran — the exact
    // false grant the launch check now closes. Measured 2026-08-12.
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "guard.sh"), "#!/bin/bash\nexit 0\n");
    writeFileSync(
      join(dir, "attributes.harness.mjs"),
      `import { runHook } from ${JSON.stringify(hook)};\n` +
        `const r = runHook("bash hooks/guard.sh", { hook_event_name: "PreToolUse" });\n` +
        `if (r.exitCode !== 0) process.exit(1);\n`,
    );
    // The control: same channel, no surface — a unit test of a pure helper.
    writeFileSync(
      join(dir, "plain.harness.mjs"),
      `import { recordCheck } from ${mod};\nrecordCheck();\n`,
    );
    const r = await runScripts(
      ["attributes.harness.mjs", "plain.harness.mjs"],
      dir,
    );
    assert.deepEqual(r[0].surfaces, [
      { how: "command", ref: "hooks/guard.sh" },
    ]);
    assert.equal(r[0].status, "pass");
    // Reported a count, exercised no identifiable surface. Not a finding.
    assert.deepEqual(r[1].surfaces, []);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── the pool: it must actually overlap, and only where overlap is safe ─────────
// Both halves, because either alone is worthless here. "It got faster" would not
// prove overlap (a machine hiccup does that), and "it produced the right results"
// would not prove it stayed SERIAL for `eval` — where overlap means simultaneous
// billed model calls. So each script records the number of peers running when it
// starts, and the assertion is on that number, not on a clock.
function poolFixture(dir: string, n: number): void {
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(dir, `s${String(i)}.harness.mjs`),
      [
        `import { writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const live = join(process.cwd(), "live");`,
        `mkdirSync(live, { recursive: true });`,
        // 🔴 THE SLOT IS RELEASED ON EXIT, and that is the whole measurement. A
        // first version only ever CREATED markers, so the count answered "how many
        // have started so far" — which reaches n under perfectly serial execution
        // too. It made the concurrency test pass for a reason unrelated to
        // concurrency. Holding a slot only while running is what makes the number
        // mean "peers running AT THE SAME MOMENT".
        `writeFileSync(join(live, "${String(i)}"), "");`,
        `const peers = readdirSync(live).length;`,
        `const until = Date.now() + 150;`,
        `while (Date.now() < until) {}`,
        `rmSync(join(live, "${String(i)}"));`,
        `writeFileSync(join(process.cwd(), "peers-${String(i)}"), String(peers));`,
      ].join("\n"),
    );
  }
}
const peakPeers = (dir: string, n: number): number =>
  Math.max(
    ...Array.from({ length: n }, (_, i) =>
      Number(readFileSync(join(dir, `peers-${String(i)}`), "utf8")),
    ),
  );

test("test tier (no entry) runs scripts concurrently", async () => {
  const dir = makeTmpDir("run-scripts-pool");
  try {
    poolFixture(dir, 4);
    const files = ["s0", "s1", "s2", "s3"].map((s) => `${s}.harness.mjs`);
    const results = await runScripts(files, dir, {}, { concurrency: 4 });
    assert.equal(results.length, 4);
    assert.ok(
      results.every((r) => r.code === 0),
      "every script must still succeed under the pool",
    );
    assert.ok(
      peakPeers(dir, 4) > 1,
      "at least one script must have observed a peer running — otherwise the pool is serial",
    );
    // Discovery order, not completion order: a run that reorders its own output
    // between invocations reads as flaky even when every result is stable.
    assert.deepEqual(
      results.map((r) => r.file),
      files,
      "results must stay in discovery order",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("eval tier (entry set) stays strictly serial — overlap there is billed twice", async () => {
  const dir = makeTmpDir("run-scripts-serial");
  try {
    poolFixture(dir, 3);
    // An entry that simply runs the script it is handed, so the only difference
    // from the tier above is the presence of `entry` itself.
    writeFileSync(
      join(dir, "entry.mjs"),
      `await import(new URL(process.argv[2], "file://" + process.cwd() + "/").href);`,
    );
    const files = ["s0", "s1", "s2"].map((s) => `${s}.harness.mjs`);
    const results = await runScripts(
      files,
      dir,
      {},
      { entry: join(dir, "entry.mjs") },
    );
    assert.equal(results.length, 3);
    assert.equal(
      peakPeers(dir, 3),
      1,
      "no script may see a peer: `eval` spends real model quota, so the default must be 1",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── a script that could not LOAD did not run (#243) ───────────────────────────
// The distinction decides whether coverage is RETRACTED: `fail` retracts, a
// did-not-load `skip` does not. Measured twice on 2026-08-20 — a container
// restore left a stale node_modules, every harness died on `Named export
// 'recordCheck' not found`, and the consumer's ledger fell 48 → 34 and 47 → 33
// for surfaces nothing had touched.
//
// Every case below runs a REAL child through the runner's load hook, because
// the whole point of the change is that the answer comes from the module
// system's link phase and not from reading what the child printed.

/** A fixture dir with `type: module` and the repo's own tsx reachable. */
function loadFixtureDir(): string {
  const dir = makeTmpDir("run-scripts-load");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(
    resolve(process.cwd(), "node_modules", "tsx"),
    join(dir, "node_modules", "tsx"),
  );
  writeFileSync(join(dir, "dep.mjs"), "export const real = 1;\n");
  writeFileSync(
    join(dir, "dep-throws.mjs"),
    'throw new Error("dependency blew up at top level");\n',
  );
  return dir;
}

const LOAD_FIXTURES: Record<string, { src: string; want: string }> = {
  "pass.mjs": { src: 'console.log("ok");\n', want: "pass" },
  "exit0.mjs": { src: "process.exit(0);\n", want: "pass" },
  "skip77.mjs": { src: "process.exit(77);\n", want: "declared-skip" },
  "bare-fail.mjs": {
    src: 'import assert from "node:assert";\nassert.equal(1, 2);\n',
    want: "fail",
  },
  "plain-throw.mjs": {
    src: 'throw new Error("plain top-level throw");\n',
    want: "fail",
  },
  // (a) THE #243 BUG: ran, printed a loader phrase as evidence, failed.
  "log-then-fail.mjs": {
    src:
      'import assert from "node:assert";\n' +
      "console.error(\"hook stderr: Error: Cannot find module 'foo' ERR_MODULE_NOT_FOUND\");\n" +
      "assert.equal(1, 2);\n",
    want: "fail",
  },
  "missing-import.mjs": {
    src: 'import { x } from "./nope.mjs";\nconsole.log(x);\n',
    want: "did-not-load",
  },
  // (b) the 2026-08-20 class: a named export that a dependency lacks.
  "missing-export.mjs": {
    src: 'import { recordCheck } from "./dep.mjs";\nconsole.log(recordCheck);\n',
    want: "did-not-load",
  },
  "missing-package.mjs": {
    src: 'import "definitely-not-installed-pkg-xyz";\n',
    want: "did-not-load",
  },
  // A dependency that EVALUATES and throws is code that ran.
  "import-dep-throws.mjs": {
    src: 'import "./dep-throws.mjs";\nconsole.log("body");\n',
    want: "fail",
  },
  // Owner decision: a syntax error in the harness itself never linked either.
  "syntax-error.mjs": { src: "const = 1;\n", want: "did-not-load" },
  "shebang-fail.mjs": {
    src: '#!/usr/bin/env node\nimport assert from "node:assert";\nassert.equal(1, 2);\n',
    want: "fail",
  },
  // A dynamic import in the body: the body ran.
  "dyn-import-fail.mjs": {
    src: 'await import("./nope.mjs");\n',
    want: "fail",
  },
  // CommonJS gets no marker, so it can never claim did-not-load.
  "cjs-missing.cjs": { src: 'require("./nope.cjs");\n', want: "fail" },
  // (e) TypeScript under tsx, in a `type: module` scope.
  "ts-fail.ts": {
    src: 'const n: number = 1;\nif (n !== 2) throw new Error("ts assertion failed");\n',
    want: "fail",
  },
  "ts-missing-export.ts": {
    src: 'import { recordCheck } from "./dep.mjs";\nconst f: unknown = recordCheck;\nconsole.log(f);\n',
    want: "did-not-load",
  },
};

function outcome(r: {
  status: string;
  code: number;
}): "pass" | "fail" | "vacuous" | "did-not-load" | "declared-skip" {
  if (r.status === "skip")
    return r.code === SKIP_EXIT_CODE ? "declared-skip" : "did-not-load";
  return r.status as "pass" | "fail" | "vacuous";
}

test("each load/run outcome is classified from the link phase, not from output", async () => {
  const dir = loadFixtureDir();
  try {
    const files = Object.keys(LOAD_FIXTURES);
    for (const f of files) writeFileSync(join(dir, f), LOAD_FIXTURES[f].src);
    const results = await runScripts(files, dir);
    assert.deepEqual(
      Object.fromEntries(results.map((r) => [r.file, outcome(r)])),
      Object.fromEntries(files.map((f) => [f, LOAD_FIXTURES[f].want])),
    );
    // `loadFailed` is the one predicate the CLI uses for both the "never ran"
    // message and `--min`: exactly the did-not-load rows, never a declared skip.
    assert.deepEqual(
      results.filter(loadFailed).map((r) => r.file),
      files.filter((f) => LOAD_FIXTURES[f].want === "did-not-load"),
    );
    assert.equal(
      anyFailed(results),
      true,
      "a failing harness still turns the run red",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the marker shifts no line numbers — JS and TypeScript under tsx", async () => {
  // The marker is written on the SAME line as the file's first line, so a
  // stack frame's line is what the author sees in the editor. Under tsx this
  // also depends on WHERE the hook sits: tsx emits each module on one line with
  // an inline source map, so a prefix added AFTER tsx shifts every generated
  // column and the map resolves to the wrong original line (measured: 3:1
  // instead of 2:7). Ours is registered before tsx, so tsx transpiles the
  // marked source and its map is correct.
  const dir = loadFixtureDir();
  try {
    const body = (tag: string, ts: boolean): string =>
      'import { writeFileSync } from "node:fs";\n' +
      (ts ? "const x: number = 1;\n" : "const x = 1;\n") +
      // Short statements on purpose: a column shift then lands on the NEXT
      // original line, which is what a wrong hook order does under tsx.
      'const e = new Error("h");\n' +
      `writeFileSync("${tag}.stack", String(e.stack));\n` +
      "console.log(x);\n";
    writeFileSync(join(dir, "line.mjs"), body("js", false));
    writeFileSync(join(dir, "line.ts"), body("ts", true));
    const results = await runScripts(["line.mjs", "line.ts"], dir);
    assert.deepEqual(
      results.map((r) => r.status),
      ["pass", "pass"],
    );
    assert.match(
      readFileSync(join(dir, "js.stack"), "utf8"),
      /line\.mjs:3:\d+/,
    );
    assert.match(readFileSync(join(dir, "ts.stack"), "utf8"), /line\.ts:3:\d+/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a script path that does not exist is a fail, not did-not-load", async () => {
  // No file, so no realpath and no module the hook could ever see: the probe
  // falls back to the plain path, nothing is marked, and nothing may claim
  // "did not load" — there is no coverage to keep for a file that is not there.
  const dir = makeTmpDir("run-scripts-missing");
  try {
    const [r] = await runScripts(["gone.harness.mjs"], dir);
    assert.equal(r?.status, "fail");
    assert.equal(loadFailed(r), false);
  } finally {
    cleanupTmpDir(dir);
  }
});
