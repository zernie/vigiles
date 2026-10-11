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
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  formatEvalReport,
  resolveSpawnEnv,
  runEvalReporting,
  runEvalWith,
  unansweredInReport,
  type AgentRunArgs,
  type EvalSpec,
  type Metrics,
} from "./eval.js";
// eslint-disable-next-line local/no-harness-names -- the test reads the auth file the real adapter declares, rather than spelling its path
import { claudeCodeRuntime } from "./adapters/claude-code/runtime.js";
import { experimental_stub } from "./stub.js";
import { lockPath } from "./eval-lock.js";
import { makeTmpDir } from "./core/test-utils.js";

const { rest } = experimental_stub;
// The harness's own auth file, HOME-relative, as its adapter declares it.
// eslint-disable-next-line local/no-harness-names -- same: the adapter's declared auth file
const [AUTH_FILE = ""] = claudeCodeRuntime.runEnv?.keepHomeFiles ?? [];
const AUTH_DIR = dirname(AUTH_FILE);
const ISSUE_URL = "https://github.com/o/r/issues/9001\n";
const GH = experimental_stub("gh", [
  {
    argv: ["issue", "create", rest],
    reply: { kind: "always", stdout: ISSUE_URL },
  },
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
const RESULT = JSON.stringify({
  type: "result",
  result: "filed",
  num_turns: 1,
});

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

/** A spec the type forbids, as a plain-JS eval file can still write it. */
const looseSpec = (spec: unknown): EvalSpec<Metrics> =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the shapes under test are exactly the ones the type rules out
  spec as EvalSpec<Metrics>;

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
  assert.match(
    formatEvalReport(report),
    /⚠ a: 1 stub call\(s\) went unanswered/,
  );
});

test("a rate-limited attempt that is retried leaves no stub state behind: the retry starts from a clean log", async () => {
  // One answer only: if the discarded attempt's call stayed in the log, the
  // retry's identical call would find the inOrder answers used up.
  const once = experimental_stub("gh", [
    {
      argv: ["issue", "create", rest],
      reply: { kind: "inOrder", answers: [{ stdout: ISSUE_URL }] },
    },
  ]);
  const outputs: string[] = [];
  let attempt = 0;
  const run = (a: AgentRunArgs) => {
    const r = spawnSync("gh", CREATE, {
      cwd: a.cwd,
      env: resolveSpawnEnv(a),
      encoding: "utf8",
    });
    outputs.push(`${String(r.status)}:${r.stdout}${r.stderr}`);
    attempt += 1;
    return Promise.resolve(
      attempt === 1
        ? { code: 1, stdout: "", stderr: "API Error: 429 rate_limit_error" }
        : { code: 0, stdout: RESULT },
    );
  };
  const report = await runEvalWith(
    base({ stubs: [once], rateLimitRetries: 1, retryBackoffMs: 0 }),
    run,
  );
  assert.deepEqual(outputs, [`0:${ISSUE_URL}`, `0:${ISSUE_URL}`]);
  assert.equal(report.arms.a?.metrics.calls, 1, "only the kept attempt's call");
  assert.equal(report.arms.a?.metrics.created, 1);
  assert.deepEqual(report.arms.a?.unansweredStubCalls, []);
});

test("a stub that cannot log is never scored as answered: the model sees a miss and the run cannot pass", async () => {
  const outputs: string[] = [];
  const run = (a: AgentRunArgs) => {
    // break the log the way a confined shell would: nothing can be appended to it
    const bin = (resolveSpawnEnv(a).PATH ?? "").split(":")[0] ?? "";
    mkdirSync(join(dirname(bin), "calls.jsonl"));
    const r = spawnSync("gh", [...CREATE], {
      cwd: a.cwd,
      env: resolveSpawnEnv(a),
      encoding: "utf8",
    });
    outputs.push(`${String(r.status)}:${r.stdout}${r.stderr}`);
    return Promise.resolve({ code: 0, stdout: RESULT });
  };
  // the call was answerable, and still the trial must not score it as answered
  await assert.rejects(() => runEvalWith(base(), run));
  assert.deepEqual(outputs, ["97:gh: unsupported invocation (vigiles stub)\n"]);
});

/** A stream-json run whose Bash call came back with `text`, as the harness records it. */
const streamWithBashResult = (text: string): string =>
  [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "gh" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: text }],
      },
    }),
    RESULT,
  ].join("\n");

test("a stub dir the agent's shell cannot write at all: no log file, and the neutral line in the trace still fails the run", async () => {
  const logs: boolean[] = [];
  const run = (a: AgentRunArgs) => {
    const bin = (resolveSpawnEnv(a).PATH ?? "").split(":")[0] ?? "";
    // the confined shell never created a log: the stub printed its line and nothing else survived
    logs.push(existsSync(join(dirname(bin), "calls.jsonl")));
    return Promise.resolve({
      code: 0,
      stdout: streamWithBashResult(
        "gh: unsupported invocation (vigiles stub)\n",
      ),
    });
  };
  const report = await runEvalWith(base(), run);
  assert.deepEqual(logs, [false]);
  const missed = report.arms.a?.unansweredStubCalls ?? [];
  assert.equal(missed.length, 1);
  assert.equal(missed[0]?.tool, "gh");
  assert.equal(missed[0]?.outcome.kind, "unlogged");
  const failure = unansweredInReport(report, [GH]) ?? "";
  assert.match(
    failure,
    /gh: the stub printed its unsupported-invocation line but could not log the call/,
  );
  assert.match(failure, /writable from the agent's shell/);
  // the control: a trace without the line, and no log, is a run that called nothing
  const clean = await runEvalWith(base(), () =>
    Promise.resolve({ code: 0, stdout: streamWithBashResult("[]") }),
  );
  assert.deepEqual(clean.arms.a?.unansweredStubCalls, []);
});

test("a miss that is both logged and in the trace counts once; a line for a tool that is not stubbed is not ours", async () => {
  const both = (a: AgentRunArgs) => {
    const r = spawnSync("gh", [...PROBE], {
      cwd: a.cwd,
      env: resolveSpawnEnv(a),
      encoding: "utf8",
    });
    return Promise.resolve({
      code: 0,
      stdout: streamWithBashResult(r.stderr),
    });
  };
  const report = await runEvalWith(base(), both);
  assert.deepEqual(
    report.arms.a?.unansweredStubCalls.map((c) => c.outcome.kind),
    ["no-rule"],
  );
  const other = await runEvalWith(base(), () =>
    Promise.resolve({
      code: 0,
      stdout: streamWithBashResult(
        "git: unsupported invocation (vigiles stub)\n",
      ),
    }),
  );
  assert.deepEqual(other.arms.a?.unansweredStubCalls, []);
});

test("calling runEval directly is not silent about an unanswered stub call", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const report = await runEvalReporting(base(), ghRunner(PROBE).run);
    assert.equal(report.arms.a?.unansweredStubCalls.length, 1);
    const printed = err.mock.calls.map((c) => String(c[0])).join("\n");
    assert.match(printed, /gh \["auth","status"\] — no rule matches/);
    assert.match(printed, /the report is not a measurement/i);

    // the control: every call answered, nothing about stubs is printed
    err.mockClear();
    await runEvalReporting(base(), ghRunner(CREATE).run);
    const quiet = err.mock.calls.map((c) => String(c[0])).join("\n");
    assert.doesNotMatch(quiet, /unanswered|no rule matches/);
  } finally {
    err.mockRestore();
  }
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
    const boom = () =>
      Promise.reject(new Error("replay must not call the model"));
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
        never: experimental_stub
          .called("gh", ["issue", "create", rest], {
            max: 0,
          })
          .eval(ctx).pass,
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
        looseSpec({ ...base(), stubs: [{ name: "gh", stdout: ISSUE_URL }] }),
        r.run,
      ),
    /stubs\[0\] \("gh"\) is the old shape/,
  );
  await assert.rejects(
    () => runEvalWith(looseSpec({ ...base(), env: undefined }), r.run),
    /runEval: `env` is required/,
  );
  await assert.rejects(
    () => runEvalWith(looseSpec({ ...base(), ephemeralEnv: true }), r.run),
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
  await assert.rejects(
    () =>
      runEvalWith(
        base({
          env: {
            kind: "ephemeral",
            home: {
              kind: "files",
              files: { [AUTH_DIR]: "x", [`${AUTH_DIR}/x`]: "y" },
            },
          },
        }),
        r.run,
      ),
    /env\.home\.files: ".* is written as a file but ".*\/x" needs it to be a directory/,
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

/** Every file under `dir` as `relative path → text`. */
function filesUnder(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = join(e.parentPath, e.name);
        return [full, readFileSync(full, "utf8")];
      }),
  );
}

test("a cache snapshot never holds the throwaway HOME: no credentials, no seed", async () => {
  const realHome = makeTmpDir();
  const cacheDir = makeTmpDir();
  vi.stubEnv("HOME", realHome);
  try {
    mkdirSync(join(realHome, AUTH_DIR), { recursive: true });
    writeFileSync(join(realHome, AUTH_FILE), "SECRET-TOKEN");
    const spec = base({
      stubs: undefined,
      env: {
        kind: "ephemeral",
        home: { kind: "files", files: { ".config/x/seed.txt": "SEED-BODY" } },
      },
      model: "claude-sonnet-4-6-20260101",
      cache: "readwrite",
      cacheDir,
    });
    const homes: string[] = [];
    await runEvalWith(spec, (a) => {
      // the trial really has the credentials and the seed in its HOME …
      const home = a.env?.HOME ?? "";
      homes.push(
        readFileSync(join(home, AUTH_FILE), "utf8"),
        readFileSync(join(home, ".config/x/seed.txt"), "utf8"),
      );
      // … and leaves a file of its own in the work dir, which IS snapshotted
      writeFileSync(join(a.cwd, "made.txt"), "kept");
      return Promise.resolve({ code: 0, stdout: RESULT });
    });
    assert.deepEqual(homes, ["SECRET-TOKEN", "SEED-BODY"]);
    const record = Object.values(filesUnder(cacheDir)).join("\n");
    assert.match(record, /made\.txt/, "the work dir is still snapshotted");
    assert.doesNotMatch(
      record,
      /SECRET-TOKEN|credentials\.json|SEED-BODY|seed\.txt/,
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(realHome, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the throwaway HOME lives beside the work dir and is removed with the trial", async () => {
  const seen: { home: string; cwd: string }[] = [];
  await runEvalWith(
    base({ stubs: undefined, env: { kind: "ephemeral" } }),
    (a) => {
      seen.push({ home: a.env?.HOME ?? "", cwd: a.cwd });
      return Promise.resolve({ code: 0, stdout: RESULT });
    },
  );
  const [one] = seen;
  assert.ok(one && one.home !== "");
  assert.ok(!one.home.startsWith(one.cwd + "/"), "HOME is not inside the cwd");
  assert.equal(existsSync(one.home), false, "and it is gone after the trial");
});

test("env inherit: the reason travels with the report and is printed", async () => {
  const report = await runEvalWith(
    base({
      stubs: undefined,
      env: { kind: "inherit", reason: "needs my real gh auth" },
    }),
    ghRunner().run,
  );
  assert.deepEqual(report.env, {
    kind: "inherit",
    reason: "needs my real gh auth",
  });
  assert.match(
    formatEvalReport(report),
    /env: inherited your HOME and environment — needs my real gh auth/,
  );
});
