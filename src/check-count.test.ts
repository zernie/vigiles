/**
 * The check counter — the channel a harness script reports through, so
 * `vigiles test` can tell "ran nothing" from "ran and passed". Pure: the
 * process bits (env, exit hook, file write) are injected.
 */
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";

import {
  CHECK_COUNT_ENV,
  recordCheck,
  checksRecorded,
  resetCheckCount,
  armCheckReport,
  recordSurfaceProbe,
  surfacesRecorded,
  parseCheckReport,
} from "./check-count.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { runHook } from "./run-hook.js";
import { assertHookAllows } from "./harness-assert.js";
import { experimental_defineHook, allow } from "./hook.js";

/** Capture what an armed report would write, without touching the disk. */
function fakes(env: NodeJS.ProcessEnv): {
  deps: Parameters<typeof armCheckReport>[0];
  exit: () => void;
  written: { path: string; contents: string }[];
} {
  const written: { path: string; contents: string }[] = [];
  let onExit = (): void => {
    throw new Error("never armed");
  };
  return {
    deps: {
      env,
      onExit: (fn) => {
        onExit = fn;
      },
      write: (path, contents) => written.push({ path, contents }),
    },
    exit: () => {
      onExit();
    },
    written,
  };
}

beforeEach(() => {
  resetCheckCount();
});

test("counts, and reports the count at exit", () => {
  const env: NodeJS.ProcessEnv = { [CHECK_COUNT_ENV]: "/tmp/x.count" };
  const f = fakes(env);
  assert.equal(armCheckReport(f.deps), true);
  recordCheck();
  recordCheck(2);
  assert.equal(checksRecorded(), 3);
  f.exit();
  assert.deepEqual(f.written, [{ path: "/tmp/x.count", contents: "3" }]);
});

test("reports ZERO — the whole point, and the one thing silence must not mean", () => {
  // A script that loaded the API and used none of it says so explicitly. The
  // runner turns this into `∅ 0 CHECKS`; an absent file it leaves as a pass.
  const f = fakes({ [CHECK_COUNT_ENV]: "/tmp/zero.count" });
  armCheckReport(f.deps);
  f.exit();
  assert.deepEqual(f.written, [{ path: "/tmp/zero.count", contents: "0" }]);
});

test("does not arm when the runner asked for no count (a standalone `node x.mjs`)", () => {
  const f = fakes({});
  assert.equal(armCheckReport(f.deps), false);
  assert.throws(() => {
    f.exit();
  }, /never armed/); // no exit hook was installed
  assert.deepEqual(f.written, []);
});

test("drops the env var, so a spawned CHILD cannot report over its parent", () => {
  // A harness spawns processes for a living. An inherited count path would let a
  // child's exit overwrite the parent's count with its own — usually zero.
  const env: NodeJS.ProcessEnv = { [CHECK_COUNT_ENV]: "/tmp/x.count" };
  armCheckReport(fakes(env).deps);
  assert.equal(env[CHECK_COUNT_ENV], undefined);
});

test("arms once — a second copy of vigiles in the process does not double-report", () => {
  const env: NodeJS.ProcessEnv = { [CHECK_COUNT_ENV]: "/tmp/x.count" };
  const first = fakes(env);
  assert.equal(armCheckReport(first.deps), true);
  const second = fakes({ [CHECK_COUNT_ENV]: "/tmp/other.count" });
  assert.equal(armCheckReport(second.deps), false);
});

test("an unwritable report path never crashes a passing harness on the way out", () => {
  const f = fakes({ [CHECK_COUNT_ENV]: "/nope/x.count" });
  armCheckReport({
    ...f.deps,
    write: () => {
      throw new Error("EACCES");
    },
  });
  assert.doesNotThrow(() => {
    f.exit();
  });
});

// --- the tiers count themselves ---------------------------------------------
//
// A harness author should never have to call `recordCheck` for ordinary work; if
// they did, the counter would measure diligence instead of activity, and the
// first person to forget would be told their file verified nothing. Each tier
// reports its own runs, so the count tracks what the script DID.

test("runHook counts as a check", () => {
  runHook("exit 0", { hook_event_name: "PreToolUse" });
  assert.equal(checksRecorded(), 1);
});

test("an in-process compiled-hook assertion counts as a check", () => {
  // The tier with no subprocess at all — without this, a harness that only tests
  // compiled hooks would look like it did nothing.
  const gate = experimental_defineHook({
    on: "PreToolUse",
    decide: () => allow(),
  });
  assertHookAllows(gate, { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(checksRecorded(), 1);
});

// --- the channel also carries WHAT was exercised ------------------------------
//
// Coverage used to answer "is surface X tested?" from a FILE NAME, so an empty
// `foo.eval.mjs` counted. The tiers now report what they went by, and this
// channel carries it out. Both halves each time: the attribution appears when a
// run really named something, and the wire format is UNCHANGED when it did not.

test("a run with nothing to attribute writes the bare number, byte for byte", () => {
  // The legacy branch has to stay legacy: an older runner meeting a new library
  // must keep reading the same file it always read.
  const f = fakes({ [CHECK_COUNT_ENV]: "/tmp/plain.count" });
  armCheckReport(f.deps);
  recordCheck(4);
  f.exit();
  assert.deepEqual(f.written, [{ path: "/tmp/plain.count", contents: "4" }]);
});

test("a run WITH an attribution writes it alongside the count", () => {
  const f = fakes({ [CHECK_COUNT_ENV]: "/tmp/rich.count" });
  armCheckReport(f.deps);
  recordCheck(2);
  recordSurfaceProbe("command", "hooks/guard.sh");
  f.exit();
  assert.deepEqual(parseCheckReport(f.written[0].contents), {
    checks: 2,
    surfaces: [{ how: "command", ref: "hooks/guard.sh" }],
  });
});

test("the reader takes both forms — a bare number is a report with no attribution", () => {
  assert.deepEqual(parseCheckReport("7"), { checks: 7, surfaces: [] });
  assert.deepEqual(parseCheckReport(' {"checks":0,"surfaces":[]} '), {
    checks: 0,
    surfaces: [],
  });
});

test("a torn or nonsensical file is NOT a report — corruption never becomes a verdict", () => {
  // Same discipline as before: only a real `0` says "this file verified nothing".
  for (const raw of [
    '{"checks":2,"surf',
    "-3",
    '{"surfaces":[]}',
    '{"checks":1.5,"surfaces":[]}',
    "",
    "not a number",
  ]) {
    assert.equal(parseCheckReport(raw), undefined, JSON.stringify(raw));
  }
});

test("a probe with an unknown origin is dropped, the rest of the report survives", () => {
  const parsed = parseCheckReport(
    JSON.stringify({
      checks: 1,
      surfaces: [
        { how: "declared", ref: "skills/foo" },
        { how: "fired", ref: "p:foo" },
      ],
    }),
  );
  assert.deepEqual(parsed?.surfaces, [{ how: "fired", ref: "p:foo" }]);
});

test("runHook attributes the hook it ran, not just that it ran", () => {
  // Derived from the command about to be executed — the author declares nothing.
  //
  // The guard has to be a REAL executable. It used to be `/repo/hooks/guard.sh`,
  // a path that exists nowhere: the shell exited 127 without launching anything
  // and the probe was recorded anyway, so this test asserted attribution over a
  // hook that never ran. Fixed with the launch check that now suppresses it.
  const dir = makeTmpDir("check-count-guard");
  try {
    const guard = join(dir, "guard.sh");
    writeFileSync(guard, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = runHook(
      '"$GUARD"',
      { hook_event_name: "PreToolUse" },
      {
        env: { GUARD: guard },
      },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: guard }]);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a hook command that names no program attributes nothing", () => {
  runHook("exit 0", { hook_event_name: "PreToolUse" });
  assert.equal(checksRecorded(), 1, "it still counts as a check");
  assert.deepEqual(surfacesRecorded(), [], "…and invents no surface");
});
