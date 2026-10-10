/**
 * The eval tier with per-invocation stubs and a declared run environment, end
 * to end through `runEvalWith` — with a fake runner that does what the model
 * did in a measured run: it runs `gh` through the PATH the trial was given, so
 * the real stub shim, the real stub runtime and the real log are exercised.
 *
 * The argv is the measured one: `gh issue create --repo o/r --title … --body …`
 * for the write, `gh api repos/o/r/issues?…` for a status script's read, and
 * `gh auth status` for the probe nobody scripted.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  formatEvalReport,
  resolveSpawnEnv,
  runEvalWith,
  unansweredInReport,
  type AgentRunArgs,
  type EvalSpec,
  type Metrics,
} from "./eval.js";
import { experimental_stub } from "./stub.js";
import { lockPath } from "./eval-lock.js";
import { makeTmpDir } from "./core/test-utils.js";

const { rest } = experimental_stub;
const ISSUE_URL = "https://github.com/o/r/issues/9001\n";
const GH = experimental_stub("gh", [
  { argv: ["issue", "create", rest], reply: { kind: "always", stdout: ISSUE_URL } },
  {
    argv: ["api", /^repos\/o\/r\/(?:issues|pulls)\?/],
    reply: { kind: "always", stdout: "[]" },
  },
]);
const CREATE = [
  "issue",
  "create",
  "--repo",
  "o/r",
  "--title",
  "init in a Yarn PnP repo links into node_modules that never exists",
  "--body",
  "Noted for later; not being worked on right now.",
];
const READ = ["api", "repos/o/r/issues?state=open&per_page=100"];
const PROBE = ["auth", "status"];
const RESULT = JSON.stringify({ type: "result", result: "filed", num_turns: 1 });

/** A runner that runs each argv as `gh …` with the trial's own env, like a model's Bash call. */
function ghRunner(...calls: readonly (readonly string[])[]) {
  const seen: AgentRunArgs[] = [];
  const outputs: string[] = [];
  const run = (a: AgentRunArgs) => {
    seen.push(a);
    calls.forEach((argv) => {
      const r = spawnSync("gh", [...argv], {
        cwd: a.cwd,
        env: resolveSpawnEnv(a),
        encoding: "utf8",
      });
      outputs.push(`${String(r.status)}:${r.stdout}${r.stderr}`);
    });
    return Promise.resolve({ code: 0, stdout: RESULT });
  };
  return { run, seen, outputs };
}

const base = (extra: Partial<EvalSpec<Metrics>> = {}): EvalSpec<Metrics> => ({
  arms: { a: {} },
  task: "file it",
  trials: 1,
  spacingSec: 0,
  env: { kind: "inherit", reason: "unit test: a fake runner" },
  stubs: [GH],
  measure: (ctx) => ({
    created: experimental_stub
      .called("gh", ["issue", "create", rest], { contains: ["o/r"] })
      .eval(ctx).pass,
    calls: ctx.stubCalls?.length ?? -1,
  }),
  ...extra,
});

test("a trial sees the stub's answers per invocation and the run records every call", async () => {
  const r = ghRunner(CREATE, READ);
  const report = await runEvalWith(base(), r.run);
  assert.deepEqual(r.outputs, [`0:${ISSUE_URL}`, "0:[]"]);
  assert.equal(report.arms.a?.metrics.created, 1);
  assert.equal(report.arms.a?.metrics.calls, 2);
  assert.deepEqual(report.arms.a?.unansweredStubCalls, []);
  assert.equal(unansweredInReport(report, [GH]), undefined);
});

test("an unanswered call is reported, stops NEW trials, and is printed to the author", async () => {
  const r = ghRunner(PROBE, CREATE);
  const report = await runEvalWith(base({ trials: 3, concurrency: 1 }), r.run);
  assert.equal(r.seen.length, 1, "trials 2 and 3 never started");
  assert.equal(report.arms.a?.runs, 1);
  assert.deepEqual(
    report.arms.a?.unansweredStubCalls.map((c) => c.argv),
    [PROBE],
  );
  assert.equal(report.aborted, false, "`aborted` stays the budget cap's flag");
  // what the model saw: a neutral line, then the create went on as normal
  assert.equal(r.outputs[0], "97:gh: unsupported invocation (vigiles stub)\n");
  assert.equal(r.outputs[1], `0:${ISSUE_URL}`);
  // what the author sees
  const failure = unansweredInReport(report, [GH]) ?? "";
  assert.match(failure, /gh \["auth","status"\] — no rule matches/);
  assert.match(failure, /#1 \["issue", "create", experimental_stub\.rest\]/);
  assert.match(failure, /`vigiles eval` exits 2/);
  assert.match(formatEvalReport(report), /⚠ a: 1 stub call\(s\) went unanswered/);
});

test("--update refuses to record a lock for a report with an unanswered call", async () => {
  const dir = makeTmpDir();
  try {
    const spec = base({
      name: "stubbed",
      model: "claude-sonnet-4-6-20260101",
      lock: { mode: "update", dir, evalApiVersion: 1 },
    });
    const report = await runEvalWith(spec, ghRunner(PROBE).run);
    assert.equal(report.arms.a?.unansweredStubCalls.length, 1);
    assert.equal(
      existsSync(lockPath(dir, "stubbed")),
      false,
      "a report built on an answer nobody wrote is not a measurement",
    );
    // the control: the same spec with every call answered DOES write the lock
    await runEvalWith(spec, ghRunner(CREATE).run);
    assert.equal(existsSync(lockPath(dir, "stubbed")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cache replay reports the same stub calls, unanswered ones included", async () => {
  const dir = makeTmpDir();
  try {
    const spec = base({
      model: "claude-sonnet-4-6-20260101",
      cache: "readwrite",
      cacheDir: dir,
    });
    const first = await runEvalWith(spec, ghRunner(CREATE, PROBE).run);
    const boom = () => Promise.reject(new Error("replay must not call the model"));
    const second = await runEvalWith({ ...spec, cache: "read" }, boom);
    assert.equal(second.arms.a?.metrics.calls, 2);
    assert.deepEqual(
      second.arms.a?.unansweredStubCalls,
      first.arms.a?.unansweredStubCalls,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run without stubs has no stub log: `.called` fails rather than counting zero", async () => {
  const r = ghRunner();
  const report = await runEvalWith(
    base({
      stubs: undefined,
      measure: (ctx) => ({
        never: experimental_stub.called("gh", ["issue", "create", rest], {
          max: 0,
        }).eval(ctx).pass,
        hasLog: ctx.stubCalls !== undefined,
      }),
    }),
    r.run,
  );
  assert.equal(report.arms.a?.metrics.never, 0);
  assert.equal(report.arms.a?.metrics.hasLog, 0);
});

// --- the spec boundary, through the runner -----------------------------------

test("the old argv-blind stub and a missing env are refused before the runner is called", async () => {
  const r = ghRunner();
  await assert.rejects(
    () =>
      runEvalWith(
        base({ stubs: [{ name: "gh", stdout: ISSUE_URL }] as never }),
        r.run,
      ),
    /stubs\[0\] \("gh"\) is the old shape/,
  );
  await assert.rejects(
    () => runEvalWith(base({ env: undefined as never }), r.run),
    /runEval: `env` is required/,
  );
  await assert.rejects(
    () =>
      runEvalWith({ ...base(), ephemeralEnv: true } as never, r.run),
    /`ephemeralEnv` was replaced by `env`[\s\S]*ephemeralEnv: true\s+→ env: \{ kind: "ephemeral" \}/,
  );
  await assert.rejects(
    () =>
      runEvalWith(
        base({
          env: {
            kind: "ephemeral",
            home: { kind: "files", files: { "../escape": "x" } },
          },
        }),
        r.run,
      ),
    /env\.home\.files: "\.\.\/escape" must stay inside HOME/,
  );
  assert.equal(r.seen.length, 0, "nothing was spent");
});

test("env ephemeral with a seed: the trial's HOME holds the seeded files", async () => {
  const seen: string[] = [];
  const report = await runEvalWith(
    base({
      stubs: undefined,
      env: {
        kind: "ephemeral",
        home: { kind: "files", files: { ".config/x/y.txt": "z" } },
      },
    }),
    (a) => {
      const home = a.env?.HOME ?? "";
      seen.push(readFileSync(join(home, ".config/x/y.txt"), "utf8"));
      return Promise.resolve({ code: 0, stdout: RESULT });
    },
  );
  assert.deepEqual(seen, ["z"]);
  assert.deepEqual(report.env, { kind: "ephemeral" });
});

test("env inherit: the reason travels with the report and is printed", async () => {
  const report = await runEvalWith(
    base({ stubs: undefined, env: { kind: "inherit", reason: "needs my real gh auth" } }),
    ghRunner().run,
  );
  assert.deepEqual(report.env, { kind: "inherit", reason: "needs my real gh auth" });
  assert.match(
    formatEvalReport(report),
    /env: inherited your HOME and environment — needs my real gh auth/,
  );
});
