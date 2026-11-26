/**
 * `scoreTree` and the serialised trial scorer on a real fixture repository,
 * built here: a one-line bug in `src/add.mjs`, the fix commit that corrects it
 * and adds `test/add.test.mjs`, and a world at `head` with the fix's source
 * reverted. Each integrity rule gets a planted defect that must fail toward
 * unscored or dropped, beside the real fix that must still score solved.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaseScore } from "./core/case-scoring.js";
import { withVigilesRunner } from "./core/eval-load-phase.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { IDENTITY } from "./host/git-env.io.js";
import { regressionCaseHost } from "./host/regression-case.io.js";
import { repoCopyHost } from "./host/workspace-host.io.js";
import {
  caseScorer,
  scoreTree,
  type CaseHost,
  type ScoredTrial,
  type ScoringWorld,
} from "./eval-regression-case.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";
const HOST: CaseHost = { ...repoCopyHost, ...regressionCaseHost };

/** The fixture repo and the case's scoring world over it. */
function caseWorld(host: CaseHost = HOST): ScoringWorld {
  const repo = tmp("case-repo");
  git(repo, "init", "-q");
  write(repo, "src/add.mjs", BUGGY);
  // The root runner: a config outside `source` that could fake a pass.
  write(repo, "runner.json", '{ "skip": false }\n');
  write(
    repo,
    "runner.mjs",
    'import { readFileSync } from "node:fs";\n' +
      'import { pathToFileURL } from "node:url";\n' +
      'if (JSON.parse(readFileSync("runner.json", "utf-8")).skip) process.exit(0);\n' +
      "await import(pathToFileURL(process.argv[2]).href);\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  write(repo, "src/add.mjs", FIXED);
  write(
    repo,
    "test/add.test.mjs",
    'import { add } from "../src/add.mjs";\nif (add(2, 2) !== 4) process.exit(1);\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix");
  const patch = git(
    repo,
    "diff",
    "--binary",
    "HEAD",
    "HEAD^",
    "--",
    "src/add.mjs",
  );
  const template = host.buildTemplate({ dir: repo, ref: "HEAD", patch });
  cleanup.push(template.root);
  return {
    template,
    top: repo,
    installs: [],
    oracle: ["test/add.test.mjs"],
    territory: ["test/**/*.test.mjs", "test/fixtures/**"],
    source: ["src/**"],
    build: { kind: "command", argv: [process.execPath, "-e", "0"] },
    testCommand: [process.execPath, "runner.mjs"],
    timeoutMs: 30_000,
  };
}

/** A trial on the world: cloned, its base recorded, then `agent` edits it. */
function trial(world: ScoringWorld, agent: (cwd: string) => void): ScoredTrial {
  const cwd = tmp("case-trial");
  const gitDir = tmp("case-trial-base");
  HOST.cloneTemplate(world.template, cwd);
  const baseTree = HOST.recordTrialBase(world.template, {
    gitDir,
    cwd,
    armPaths: [],
  });
  agent(cwd);
  return {
    cwd,
    experimental_workspace: { arm: "a", baseTree, gitDir, armPaths: [] },
  };
}

const score = (
  world: ScoringWorld,
  agent: (cwd: string) => void,
  host: CaseHost = HOST,
): Promise<CaseScore> =>
  withVigilesRunner("eval-cli", () =>
    caseScorer(host, world)(trial(world, agent)),
  );

const fix = (cwd: string): void => {
  write(cwd, "src/add.mjs", FIXED);
};

describe("scoreTree on a fixture repository", () => {
  it("the real fix scores solved, and doing nothing does not", async () => {
    const world = caseWorld();
    // Guards: silent on correct — the gold patch applied by an agent reaches the oracle and passes.
    expect(await score(world, fix)).toEqual({
      kind: "scored",
      metrics: {
        solved: true,
        editedTests: false,
        droppedEdits: 0,
        ignoredNewFiles: 0,
        scoringTimedOut: false,
      },
    });
    // Guards: the world as shipped to the agent still fails its oracle.
    expect(await score(world, () => undefined)).toMatchObject({
      metrics: { solved: false },
    });
  });

  it("an edit to the oracle is editedTests, never solved", async () => {
    const world = caseWorld();
    const cheat = (cwd: string): void => {
      write(cwd, "test/add.test.mjs", "process.exit(0);\n");
    };
    // Guards: an agent that rewrites the test to pass is caught, not scored.
    expect(await score(world, cheat)).toMatchObject({
      metrics: { solved: false, editedTests: true },
    });
  });
});

describe("scoreTree drops what must not be carried", () => {
  it("a root runner config edited to skip the tests is dropped and the oracle still runs", async () => {
    const world = caseWorld();
    const cheat = (cwd: string): void => {
      write(cwd, "runner.json", '{ "skip": true }\n');
    };
    // Guards: outside `source` the config stays at head, so the cheat neither carries nor passes.
    expect(await score(world, cheat)).toMatchObject({
      metrics: { solved: false, droppedEdits: 1 },
    });
  });

  it("a symlink to a fixed file outside the tree is dropped, never carried", async () => {
    const world = caseWorld();
    const outside = tmp("case-outside");
    write(outside, "add.mjs", FIXED);
    const link = (cwd: string): void => {
      rmSync(join(cwd, "src/add.mjs"));
      symlinkSync(join(outside, "add.mjs"), join(cwd, "src/add.mjs"));
    };
    // Guards: a score must not depend on state outside the scoring tree.
    expect(await score(world, link)).toMatchObject({
      metrics: { solved: false, droppedEdits: 1 },
    });
  });
});

describe("scoreTree leaves an untrustworthy tree unscored", () => {
  it("a fix beside a nested repo without a commit is unscored, not solved", async () => {
    const world = caseWorld();
    const agent = (cwd: string): void => {
      fix(cwd);
      mkdirSync(join(cwd, "scratch"));
      git(join(cwd, "scratch"), "init", "-q");
      write(cwd, "scratch/x.txt", "x\n");
    };
    // Guards: what could not be staged is not scored on what could.
    expect(await score(world, agent)).toEqual({
      kind: "integrity",
      why: "unstaged",
    });
  });

  it("a broken base record is unscored", async () => {
    const world = caseWorld();
    const t = trial(world, fix);
    rmSync(t.experimental_workspace?.gitDir ?? "", {
      recursive: true,
      force: true,
    });
    const got = await withVigilesRunner("eval-cli", () =>
      caseScorer(HOST, world)(t),
    );
    // Guards: a shadow that cannot read its base yields no score at all.
    expect(got).toEqual({ kind: "integrity", why: "shadow-unhealthy" });
  });

  it("a link out of the final scoring tree is unscored, even when the carry let it in", async () => {
    const world = caseWorld();
    const leaky: CaseHost = {
      ...HOST,
      carryRows: (gitDir, rows, dest) => {
        HOST.carryRows(gitDir, rows, dest);
        symlinkSync("/tmp", join(dest, "src/out"));
      },
    };
    // Guards: step 4a rescans the tree that will run, so a defect in step 3 cannot leak a link into scoring.
    expect(await score(world, fix, leaky)).toEqual({
      kind: "integrity",
      why: "outside-link",
    });
  });
});

describe("caseScorer", () => {
  it("two trials scored at once never run their suites at the same time", async () => {
    const world = caseWorld();
    const live = { now: 0, max: 0 };
    const counting: CaseHost = {
      ...HOST,
      runScoring: async (argv, at) => {
        live.now += 1;
        live.max = Math.max(live.max, live.now);
        const run = await HOST.runScoring(argv, at);
        live.now -= 1;
        return run;
      },
    };
    const scorer = caseScorer(counting, world);
    const a = trial(world, fix);
    const b = trial(world, () => undefined);
    const both = await withVigilesRunner("eval-cli", () =>
      Promise.all([scorer(a), scorer(b)]),
    );
    // Guards: the mutex — fixed ports and shared temp paths of a suite are never shared by two runs.
    expect(live.max).toBe(1);
    expect(both.map((s) => s.kind === "scored" && s.metrics.solved)).toEqual([
      true,
      false,
    ]);
  });
});

describe("caseScorer faults", () => {
  it("a scoring that rejects does not stall the trials queued behind it", async () => {
    const world = caseWorld();
    const fails = { left: 1 };
    const flaky: CaseHost = {
      ...HOST,
      cloneTemplate: (template, dest) => {
        if (fails.left-- > 0) throw new Error("disk full");
        HOST.cloneTemplate(template, dest);
      },
    };
    const scorer = caseScorer(flaky, world);
    const [first, second] = await withVigilesRunner("eval-cli", () =>
      Promise.allSettled([
        scorer(trial(world, fix)),
        scorer(trial(world, fix)),
      ]),
    );
    // Guards: a machine fault rejects (it is not the agent's result) and the lock still releases for the next trial.
    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({
      status: "fulfilled",
      value: { metrics: { solved: true } },
    });
  });

  it("refuses a trial without its workspace view, and refuses to run outside a runner", async () => {
    const world = caseWorld();
    // Guards: a wiring fault rejects instead of scoring the agent.
    await expect(caseScorer(HOST, world)({ cwd: world.top })).rejects.toThrow(
      /no experimental_workspace view/,
    );
    const t = trial(world, fix);
    const view = t.experimental_workspace;
    if (view === undefined) throw new Error("fixture has a view");
    // Guards: the user's build and tests never run outside a vigiles runner (P0 3).
    await expect(
      scoreTree(HOST, world, { cwd: t.cwd, base: view, armPaths: [] }),
    ).rejects.toThrow(/outside a vigiles runner/);
  });
});
