/**
 * The pure scoring rules of a regression case: which touched rows are
 * carried, and how a tree's outcome becomes a trial's metrics. Each rule is
 * proved twice: a planted defect fails toward "not scored" or "dropped", and
 * a correct tree still scores.
 */
import { describe, expect, it } from "vitest";
import {
  caseScore,
  carryVerdict,
  type CarryRules,
  type ScoringRun,
  type TreeOutcome,
} from "./case-scoring.js";
import type { TouchedRow, TouchedSet, Unstaged } from "./workspace.js";

const BLOB = "b".repeat(40);
const file = (path: string): TouchedRow => ({
  status: "M",
  path,
  entry: { kind: "file", mode: "100644", blob: BLOB },
});
const RULES: CarryRules = {
  territory: ["**/*.test.ts", "test/**"],
  source: { kind: "declared", globs: ["src/**"] },
  armPaths: ["notes.md", "plugin"],
};
const set = (
  rows: readonly TouchedRow[],
  unstaged: Unstaged = { kind: "none" },
): TouchedSet => ({
  rows,
  unstaged,
  ignoredNewFiles: 0,
});

describe("carryVerdict", () => {
  it("carries a regular file and a deletion inside source", () => {
    const rows = [
      file("src/a.ts"),
      { status: "D", path: "src/b.ts", entry: { kind: "absent" } },
    ] as const;
    // Guards: silent on correct — the agent's real fix reaches the scoring tree whole.
    expect(carryVerdict(set(rows), RULES)).toEqual({
      kind: "carry",
      kept: rows,
      droppedEdits: 0,
    });
  });

  it.each([
    ["a directory inside source", "src/nest/"],
    ["a file inside source", "src/b.ts"],
  ])("never scores a set that left %s unstaged", (_, entry) => {
    const unstaged: Unstaged = { kind: "paths", paths: ["scratch/", entry] };
    // Guards: what was not staged is state outside the scored tree, so the trial is unscored, not scored on the part that staged.
    expect(carryVerdict(set([file("src/a.ts")], unstaged), RULES)).toEqual({
      kind: "integrity",
      why: "unstaged",
    });
  });

  it("never scores a set whose staging failed without naming a path", () => {
    const unstaged: Unstaged = { kind: "unknown", detail: "fatal" };
    // Guards: an unnamed failure may hide anything, so it fails toward unscored.
    expect(carryVerdict(set([], unstaged), RULES).kind).toBe("integrity");
  });

  it("scores a set whose unstaged entries all lie outside source and the tests", () => {
    const unstaged: Unstaged = {
      kind: "paths",
      paths: ["scratch/", "test/nest/"],
    };
    // Guards: silent on correct — a `git init scratch/` outside source no longer unscores the trial (fable G1).
    expect(carryVerdict(set([file("src/a.ts")], unstaged), RULES).kind).toBe(
      "carry",
    );
  });

  it("an edit under tests.run or tests.data is edited-tests, whatever else is carried", () => {
    const verdict = carryVerdict(
      set([file("src/a.ts"), file("src/a.test.ts"), file("test/fx.json")]),
      RULES,
    );
    // Guards: an agent that edits the oracle or its data cannot be scored solved.
    expect(verdict.kind).toBe("edited-tests");
  });
});

describe("carryVerdict drops", () => {
  it.each([
    ["a symlink", { kind: "symlink" }],
    ["a gitlink", { kind: "gitlink" }],
    ["an unknown mode", { kind: "other", mode: "040000" }],
  ] as const)("drops %s inside source", (_, entry) => {
    const row: TouchedRow = { status: "T", path: "src/a.ts", entry };
    // Guards: a non-regular entry's content is outside the tree (a link target, a nested repo), so it is never carried.
    expect(carryVerdict(set([row, file("src/b.ts")]), RULES)).toEqual({
      kind: "carry",
      kept: [file("src/b.ts")],
      droppedEdits: 1,
    });
  });

  it("drops an edit outside source (a root runner config) and on an arm's path", () => {
    const verdict = carryVerdict(
      set([
        file("vitest.config.ts"),
        file("notes.md"),
        file("plugin/x.json"),
        file("src/a.ts"),
      ]),
      RULES,
    );
    // Guards: a root config edited to exit 0 stays at head; an arm's own file is not the agent's edit.
    expect(verdict).toEqual({
      kind: "carry",
      kept: [file("src/a.ts")],
      droppedEdits: 3,
    });
  });
});

describe("carryVerdict with the default source", () => {
  it("matches a default root literally, so a directory named like a glob carries only itself", () => {
    const rules: CarryRules = {
      ...RULES,
      source: {
        kind: "default",
        roots: [
          { kind: "dir", dir: "{app,lib}" },
          { kind: "file", path: "[t].json" },
        ],
      },
    };
    const verdict = carryVerdict(
      set([
        file("{app,lib}/x.ts"),
        file("app/x.ts"),
        file("lib/x.ts"),
        file("[t].json"),
        file("t.json"),
      ]),
      rules,
    );
    // Guards: a fix's own directory `{app,lib}` read as a glob would carry edits in `app/` and `lib/`, outside source.
    expect(verdict).toEqual({
      kind: "carry",
      kept: [file("{app,lib}/x.ts"), file("[t].json")],
      droppedEdits: 3,
    });
  });
});

const ok = { kind: "exited", code: 0 } as const;
const fail = { kind: "exited", code: 1 } as const;
const late = { kind: "timed-out", ms: 5 } as const;
const ran = (
  build: ScoringRun | undefined,
  tests: readonly ScoringRun[],
): TreeOutcome => ({
  kind: "ran",
  build,
  tests,
  droppedEdits: 2,
  ignoredNewFiles: 1,
});
const metricsOf = (o: TreeOutcome, oracle = 2): unknown => caseScore(o, oracle);

describe("caseScore", () => {
  it("is solved when the build and every oracle path exit 0", () => {
    // Guards: silent on correct — a real fix scores true, and the counts ride along.
    expect(metricsOf(ran(ok, [ok, ok]))).toEqual({
      kind: "scored",
      metrics: {
        solved: true,
        editedTests: false,
        droppedEdits: 2,
        ignoredNewFiles: 1,
        scoringTimedOut: false,
      },
    });
    expect(metricsOf(ran(undefined, [ok, ok]))).toMatchObject({
      metrics: { solved: true },
    });
  });

  it.each([
    ["a failing build", ran(fail, [])],
    ["a failing oracle path", ran(ok, [ok, fail])],
    ["an oracle path that never ran", ran(ok, [ok])],
    [
      "a build that could not start",
      ran({ kind: "not-started", detail: "spawn x ENOENT" }, []),
    ],
    [
      "an oracle path killed by a signal",
      ran(ok, [ok, { kind: "signalled", signal: "SIGSEGV" }]),
    ],
  ])("is not solved after %s", (_, outcome) => {
    // Guards: every oracle path must have run and passed; a short list is never a pass.
    expect(metricsOf(outcome)).toMatchObject({ metrics: { solved: false } });
  });
});

describe("caseScore beyond a plain run", () => {
  it("a timeout anywhere forces solved false and is reported", () => {
    // Guards: a hung suite is not a pass.
    expect(metricsOf(ran(late, []))).toMatchObject({
      metrics: { solved: false, scoringTimedOut: true },
    });
    expect(metricsOf(ran(ok, [ok, late]))).toMatchObject({
      metrics: { solved: false, scoringTimedOut: true },
    });
  });

  it("edited-tests is scored false with editedTests, and integrity stays unscored", () => {
    const edited: TreeOutcome = {
      kind: "edited-tests",
      droppedEdits: 0,
      ignoredNewFiles: 0,
    };
    // Guards: editedTests forces solved false.
    expect(metricsOf(edited)).toMatchObject({
      metrics: { solved: false, editedTests: true },
    });
    // Guards: an integrity outcome never becomes a metric value.
    expect(metricsOf({ kind: "integrity", why: "outside-link" })).toEqual({
      kind: "integrity",
      why: "outside-link",
    });
  });
});
