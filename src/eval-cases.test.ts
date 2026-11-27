/**
 * `experimental_regressionCases` through `runEvalWith`, on a real repository
 * built here and a fake agent runner (no model): an agent that fixes the bug
 * solves the case and one that does nothing does not; a tree that cannot be
 * scored is counted apart; and a case refused before any trial (a fix that
 * does not qualify, no agent binary, too little disk) stops the run before
 * the runner is called, leaving nothing in the temp dir. Under the lock, an
 * engine without a fingerprint is never replayed and never recorded.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withVigilesRunner } from "./core/eval-load-phase.js";
import type { EvalHost } from "./core/eval-host.js";
import { unscoredInReport } from "./core/eval-report-failures.js";
import type { RegressionCaseEntry } from "./core/regression-case-entries.js";
import { RegressionCaseRefusalError } from "./core/regression-case-refusal.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { WorkspaceRefusalError } from "./core/workspace.js";
import {
  registerAgentProbe,
  runEvalWith,
  type AgentRunArgs,
  type AgentRunner,
  type EvalReport,
  type EvalSpec,
} from "./eval.js";
import { formatEvalReport } from "./eval-format.js";
import { readLock } from "./eval-lock.js";
import { IDENTITY } from "./host/git-env.io.js";
import { evalHost } from "./host/workspace-host.io.js";

const RESULT = JSON.stringify({ type: "result", num_turns: 1 });

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tmp = (label: string): string => {
  const dir = makeTmpDir(label);
  cleanup.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...IDENTITY },
  });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const commit = (repo: string, message: string): string => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
};

const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

/**
 * A repository whose fix corrects `src/add.mjs` and adds its test, and a
 * `head` that adds the symptom; `sum` is what the test expects of add(2, 2).
 */
function caseEntry(id: string, sum = 4): RegressionCaseEntry {
  const repo = tmp("cases-repo");
  git(repo, "init", "-q");
  write(repo, "src/add.mjs", BUGGY);
  write(
    repo,
    "runner.mjs",
    'import { pathToFileURL } from "node:url";\n' +
      "await import(pathToFileURL(process.argv[2]).href);\n",
  );
  commit(repo, "base");
  write(repo, "src/add.mjs", FIXED);
  write(
    repo,
    "test/add.test.mjs",
    `import { add } from "../src/add.mjs";\nif (add(2, 2) !== ${String(sum)}) process.exit(1);\n`,
  );
  const fix = commit(repo, "fix");
  write(repo, "ISSUE.md", "add(2, 2) is not 4\n");
  return {
    id,
    repo,
    commit: fix,
    head: commit(repo, "head"),
    tests: { run: ["test/**/*.test.mjs"], data: [] },
    testCommand: [process.execPath, "runner.mjs"],
    build: { kind: "none", reason: "plain node, nothing to build" },
    deps: { kind: "none" },
    symptom: { kind: "file", path: "ISSUE.md" },
  };
}

const spec = (cases: readonly RegressionCaseEntry[]): EvalSpec => ({
  env: { kind: "inherit", reason: "unit test: a fake runner" },
  experimental_regressionCases: cases,
  trials: 1,
  spacingSec: 0,
});

/** `runEvalWith` as `vigiles eval` calls it: inside the runner, where a case may run its commands. */
const runCases = (
  cases: readonly RegressionCaseEntry[],
  runner: AgentRunner,
  host: EvalHost = evalHost,
): Promise<EvalReport> =>
  withVigilesRunner("eval-cli", () => runEvalWith(spec(cases), runner, host));

/** A runner that edits the trial's tree as an agent would, and counts its calls. */
function agent(edit: (cwd: string) => void = () => undefined) {
  const calls: string[] = [];
  const run = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> => {
    calls.push(a.cwd);
    edit(a.cwd);
    return Promise.resolve({ code: 0, stdout: RESULT });
  };
  return { run, calls };
}

const fixes = (cwd: string): void => {
  writeFileSync(join(cwd, "src/add.mjs"), FIXED);
};

/** Run `f` with a private TMPDIR: what it threw, and what is left in it afterwards. */
async function refusedIn(
  f: () => Promise<unknown>,
): Promise<{ readonly thrown: unknown; readonly left: readonly string[] }> {
  const own = tmp("own-tmp");
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try {
    const thrown = await f().then(
      () => undefined,
      (e: unknown) => e,
    );
    return { thrown, left: readdirSync(own) };
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = saved;
  }
}

describe("runEvalWith on regression cases: the score", () => {
  it("an agent that fixes the bug solves the case; one that does nothing does not", async () => {
    const entry = caseEntry("add");
    const solved = await runCases([entry], agent(fixes).run);
    const idle = await runCases([entry], agent().run);
    // Guards: the case is scored by its own tests on the tree the agent left.
    expect(solved.experimental_regressionCases?.[0]?.arms).toEqual({
      default: { solved: 1, scored: 1, unscored: 0 },
    });
    expect(idle.experimental_regressionCases?.[0]?.arms).toEqual({
      default: { solved: 0, scored: 1, unscored: 0 },
    });
    // Guards: the arm's metrics carry the documented `case.*` keys.
    expect(Object.keys(solved.arms.default?.metrics ?? {})).toContain(
      "case.solved",
    );
    // Guards: the printed report gives each case its own line (the documented output format).
    expect(formatEvalReport(solved).split("\n")).toContainEqual(
      expect.stringMatching(
        /^ {2}case add @ [0-9a-f]{7} {2}default 1\/1 solved$/,
      ),
    );
  });
});

describe("runEvalWith on regression cases: per-case results", () => {
  it("each case is reported in the spec's order, with its own head and build", async () => {
    const report = await runCases(
      [caseEntry("one"), caseEntry("two")],
      agent(fixes).run,
    );
    const cases = report.experimental_regressionCases ?? [];
    // Guards: one result per case, never merged across cases.
    expect(cases.map((c) => c.id)).toEqual(["one", "two"]);
    expect(cases[0]?.build).toEqual({
      kind: "none",
      reason: "plain node, nothing to build",
    });
  });

  it("a tree that cannot be staged is counted unscored, and the report fails for it", async () => {
    const nested = (cwd: string): void => {
      fixes(cwd);
      mkdirSync(join(cwd, "src/scratch"), { recursive: true });
      git(join(cwd, "src/scratch"), "init", "-q");
      write(cwd, "src/scratch/x.txt", "x\n");
    };
    const report = await runCases([caseEntry("add")], agent(nested).run);
    // Guards: an untrustworthy tree is neither solved nor unsolved.
    expect(report.experimental_regressionCases?.[0]?.arms.default).toEqual({
      solved: 0,
      scored: 0,
      unscored: 1,
    });
    expect(unscoredInReport(report)).toBeDefined();
    expect(formatEvalReport(report)).toContain(
      "default 0/0 solved, 1 unscored",
    );
  });
});

describe("runEvalWith on regression cases: refused before any trial", () => {
  it("a fix whose test passes before it refuses the run, naming the case, and removes the cases built first", async () => {
    const good = caseEntry("good");
    const passesAnyway = caseEntry("passes-anyway", 0);
    const { run, calls } = agent(fixes);
    const { thrown, left } = await refusedIn(() =>
      runCases([good, passesAnyway], run),
    );
    // Guards: a case that does not qualify costs no trial, and the run stops.
    expect(thrown).toBeInstanceOf(RegressionCaseRefusalError);
    expect(thrown).toMatchObject({ id: "passes-anyway" });
    expect(calls).toEqual([]);
    // Guards: the world the good case built before the refusal is removed.
    expect(left).toEqual([]);
  });

  it("a missing agent binary refuses the run before any case is qualified", async () => {
    const entry = caseEntry("add");
    const { run, calls } = agent(fixes);
    registerAgentProbe(run, () => ({ kind: "missing", binary: "agent-cli" }));
    const { thrown, left } = await refusedIn(() => runCases([entry], run));
    // Guards: no build or test suite runs for an eval that cannot run a trial.
    expect(thrown).toMatchObject({
      refusal: { kind: "agent-binary-missing", binary: "agent-cli" },
    });
    expect(calls).toEqual([]);
    expect(left).toEqual([]);
  });

  it("too little disk for the trials in flight refuses the run and removes every case", async () => {
    const entry = caseEntry("add");
    const full: EvalHost = { ...evalHost, freeBytes: () => 0 };
    const { run, calls } = agent(fixes);
    const { thrown, left } = await refusedIn(() =>
      runCases([entry], run, full),
    );
    expect(thrown).toBeInstanceOf(WorkspaceRefusalError);
    expect(thrown).toMatchObject({
      refusal: { kind: "not-enough-disk", freeBytes: 0 },
    });
    expect(calls).toEqual([]);
    expect(left).toEqual([]);
  });
});

describe("runEvalWith on regression cases: a throw after qualification", () => {
  it("a read error while building a case's trial plan removes that case and the ones built before it", async () => {
    const reads: string[] = [];
    const failsSecond: EvalHost = {
      ...evalHost,
      readWorld: (template) => {
        reads.push(template.tree);
        if (reads.length > 1) throw new Error("disk read failed");
        return evalHost.readWorld(template);
      },
    };
    const entries = [caseEntry("one"), caseEntry("two")];
    const { run, calls } = agent(fixes);
    const { thrown, left } = await refusedIn(() =>
      runCases(entries, run, failsSecond),
    );
    expect(thrown).toMatchObject({ message: "disk read failed" });
    expect(calls).toEqual([]);
    // Guards: a throw past qualification still leaves no case world behind.
    expect(left).toEqual([]);
  });
});

describe("runEvalWith on regression cases: the lock", () => {
  const MISSING: EvalHost = {
    ...evalHost,
    engineFingerprint: () => ({ kind: "missing", path: "/x/eval-engine.json" }),
  };
  const FOUND: EvalHost = {
    ...evalHost,
    engineFingerprint: () => ({ kind: "found", hash: "e1" }),
  };
  const locked = (
    entry: RegressionCaseEntry,
    mode: "check" | "update",
    dir: string,
  ): EvalSpec => ({ ...spec([entry]), name: "cases", lock: { mode, dir } });
  const runLocked = (s: EvalSpec, run: AgentRunner, host: EvalHost) =>
    withVigilesRunner("eval-cli", () => runEvalWith(s, run, host));

  it("under check, an engine without a fingerprint refuses before any trial", async () => {
    const dir = tmp("locks");
    const { run, calls } = agent(fixes);
    const thrown = await runLocked(
      locked(caseEntry("add"), "check", dir),
      run,
      MISSING,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Guards: a lock that cannot go stale with the engine is never replayed.
    expect(thrown).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });

  it("under update, the run happens but no lock is written without a fingerprint", async () => {
    const entry = caseEntry("add");
    const [bare, pinned] = [tmp("locks"), tmp("locks")];
    const missing = agent(fixes);
    await runLocked(locked(entry, "update", bare), missing.run, MISSING);
    await runLocked(locked(entry, "update", pinned), agent(fixes).run, FOUND);
    // Guards: the report is still produced; only the record of it is refused.
    expect(missing.calls).toHaveLength(1);
    expect(readLock(bare, "cases")).toBeNull();
    // Guards: silent on correct — with a fingerprint the lock is written.
    expect(readLock(pinned, "cases")).not.toBeNull();
  });
});
