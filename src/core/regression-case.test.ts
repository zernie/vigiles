/** The pure half of a regression case, on planted paths and texts; no git. */
import { keys } from "remeda";
import { describe, expect, it } from "vitest";
import {
  CASE_KEY_FIELDS,
  caseKeyView,
  defaultSource,
  driftVerdict,
  inSource,
  mayHoldSource,
  pathRefusal,
  resolvedSource,
  splitFix,
  type FixPath,
  type FixSplit,
  type PathFacts,
  type RegressionCaseSpec,
} from "./regression-case.js";

const TESTS = {
  run: ["**/*.test.ts"],
  data: ["test/**", "**/__snapshots__/**"],
};

const row =
  (status: FixPath["status"]) =>
  (path: string): FixPath => ({ status, path });
const A = row("A");
const M = row("M");
const D = row("D");
const fix = (...rows: FixPath[]): FixPath[] => rows;

describe("splitFix", () => {
  it("makes the added and modified runnable tests the oracle", () => {
    const split = splitFix(
      fix(M("src/a.ts"), M("src/a.test.ts"), A("src/b.test.ts")),
      TESTS,
    );
    // Guards: A and M under tests.run are scored.
    expect(split.oracle).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    // Guards: a non-test path is reverted.
    expect(split.reverted).toEqual(["src/a.ts"]);
  });

  it("keeps a deleted test and test data in test territory, never in the oracle", () => {
    const split = splitFix(
      fix(
        D("src/old.test.ts"),
        M("test/fixtures/x.json"),
        M("src/__snapshots__/a.snap"),
        M("src/a.ts"),
      ),
      TESTS,
    );
    // Guards: a test the fix deleted does not exist at head to be run.
    expect(split.oracle).toEqual([]);
    // Guards: data and deleted tests stay at head (not reverted).
    expect(split.testPaths).toEqual([
      "src/old.test.ts",
      "test/fixtures/x.json",
      "src/__snapshots__/a.snap",
    ]);
    expect(split.reverted).toEqual(["src/a.ts"]);
  });

  it("matches dot paths, so a test under a dot dir is test territory", () => {
    const split = splitFix(fix(M(".ci/x.test.ts"), M(".env")), TESTS);
    // Guards: minimatch runs with dot: true.
    expect(split.oracle).toEqual([".ci/x.test.ts"]);
    expect(split.reverted).toEqual([".env"]);
  });
});

describe("defaultSource", () => {
  it("takes the top-level dir of each non-Markdown path, and a root file as itself", () => {
    // Guards: src/core/a.ts gives the dir src, a root file only itself, Markdown nothing.
    const paths = "src/x/a.ts src/b.ts t.json d/x.md R.md l/c.js".split(" ");
    expect(defaultSource(paths)).toEqual({
      kind: "default",
      roots: [
        { kind: "dir", dir: "l" },
        { kind: "dir", dir: "src" },
        { kind: "file", path: "t.json" },
      ],
    });
  });

  it.each([
    ["[app]/x.ts", "a/x.ts"],
    ["{app,lib}/x.ts", "lib/x.ts"],
    ["!app/x.ts", "lib/x.ts"],
    ["#app/x.ts", "app/x.ts"],
    ["*.ts", "b.ts"],
    ["!x.ts", "y.ts"],
  ])("names %s literally, never as a pattern", (own, other) => {
    const source = defaultSource([own]);
    // Guards: a default root is a path, so no character in it is pattern syntax.
    expect(inSource(own, source)).toBe(true);
    expect(inSource(other, source)).toBe(false);
  });

  it("matches a dir root by a whole first segment, not a prefix", () => {
    // Guards: the root `src` does not cover `srcx/a.ts` or the bare name `src`.
    const source = defaultSource(["src/a.ts"]);
    expect(inSource("src/deep/b.ts", source)).toBe(true);
    expect(inSource("srcx/a.ts", source)).toBe(false);
    expect(inSource("src", source)).toBe(false);
  });

  it("is overridden by a declared source, read as globs", () => {
    const split: FixSplit = {
      oracle: [],
      testPaths: [],
      reverted: ["src/a.ts"],
    };
    const declared = resolvedSource(["lib/**"], split);
    // Guards: the declaration wins and stays a glob; the default is only for an unset source.
    expect(declared).toEqual({ kind: "declared", globs: ["lib/**"] });
    expect(inSource("lib/a/b.ts", declared)).toBe(true);
    expect(inSource("src/a.ts", declared)).toBe(false);
    expect(resolvedSource(undefined, split)).toEqual(
      defaultSource(["src/a.ts"]),
    );
  });
});

describe("mayHoldSource", () => {
  const declared = { kind: "declared", globs: ["src/**/*.ts"] } as const;

  it.each([
    ["a default dir root holds a directory under it", "src/nest/", true],
    ["a default dir root holds nothing outside it", "scratch/", false],
    ["a file root holds no directory", "a.ts/", false],
  ])("%s", (_, entry, held) => {
    const source = defaultSource(["src/a.ts", "a.ts"]);
    // Guards: an unstaged directory unscores a trial only where it may hold a carried edit.
    expect(mayHoldSource(entry, source)).toBe(held);
  });

  it.each([
    ["a directory a glob can match beneath", "src/nest/", true],
    ["a directory no glob can reach", "lib/nest/", false],
    ["a file, judged as itself", "src/a.ts", true],
    ["a file the glob does not match", "src/a.js", false],
  ])("for declared globs: %s", (_, entry, held) => {
    // Guards: the match is minimatch's own partial mode, the carry's matcher, never git's pathspec (fable G1).
    expect(mayHoldSource(entry, declared)).toBe(held);
  });
});

const facts = (over: Partial<PathFacts> = {}): PathFacts => ({
  declaredSource: undefined,
  atHead: () => true,
  ...over,
});

const refusalKind = (rows: FixPath[], f: PathFacts = facts()) =>
  pathRefusal(splitFix(fix(...rows), TESTS), f);

describe("pathRefusal", () => {
  it("passes a fix with code and an oracle that exists at head", () => {
    // Guards: a good fix is not refused.
    expect(refusalKind([M("src/a.ts"), M("src/a.test.ts")])).toBeUndefined();
  });

  it("refuses a fix with no oracle, and a fix with nothing to revert", () => {
    // Guards: no added/modified test → no oracle.
    expect(refusalKind([M("src/a.ts"), D("src/a.test.ts")])).toEqual({
      kind: "no-test-in-fix",
    });
    // Guards: only tests → nothing to revert.
    expect(refusalKind([M("src/a.test.ts")])).toEqual({
      kind: "fix-touches-only-tests",
    });
    // Guards: the oracle refusal comes first when both hold.
    expect(refusalKind([M("test/data.json")])).toEqual({
      kind: "no-test-in-fix",
    });
  });

  it("refuses an oracle path missing at head, naming it", () => {
    const f = facts({ atHead: (p) => p !== "src/b.test.ts" });
    // Guards: checked from the tree, before any process runs.
    expect(
      refusalKind([M("src/a.ts"), M("src/a.test.ts"), A("src/b.test.ts")], f),
    ).toEqual({ kind: "oracle-missing-in-world", paths: ["src/b.test.ts"] });
  });

  it("refuses a fix outside a DECLARED source only, Markdown exempt", () => {
    const rows = [
      M("src/a.ts"),
      M("action.yml"),
      M("docs/x.md"),
      M("src/a.test.ts"),
    ];
    // Guards: a declared source refuses the non-test, non-Markdown paths outside it.
    expect(refusalKind(rows, facts({ declaredSource: ["src/**"] }))).toEqual({
      kind: "fix-outside-source",
      paths: ["action.yml"],
    });
    // Guards: the default source is derived from the fix, so it never refuses it.
    expect(refusalKind(rows)).toBeUndefined();
  });

  it("refuses a revert that changes a manifest or a lockfile, nested ones too", () => {
    // Guards: the copied install would not match a reverted manifest.
    expect(
      refusalKind([
        M("src/a.ts"),
        M("pkg/package.json"),
        M("yarn.lock"),
        M("src/a.test.ts"),
      ]),
    ).toEqual({
      kind: "revert-touches-manifest",
      paths: ["pkg/package.json", "yarn.lock"],
    });
  });
});

describe("driftVerdict", () => {
  it("keeps Markdown at head and lists it for the report", () => {
    // Guards: a Markdown file that did not revert does not make the case outdated.
    expect(driftVerdict(["docs/x.md"])).toEqual({
      kind: "kept",
      markdownKeptAtHead: ["docs/x.md"],
    });
    // Guards: an empty failure list is not outdated.
    expect(driftVerdict([]).kind).toBe("kept");
  });

  it("makes the case outdated naming every non-Markdown file, a comment change included", () => {
    // Guards: no file is put back as "only comments changed": any drift in code refuses.
    expect(driftVerdict(["docs/x.md", "src/a.ts", "tool.py"])).toEqual({
      kind: "outdated",
      files: [{ path: "src/a.ts" }, { path: "tool.py" }],
    });
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const CASE: RegressionCaseSpec = {
  repo: ".",
  commit: SHA_A,
  head: SHA_B,
  tests: TESTS,
  testCommand: ["npx", "vitest", "run"],
  build: { kind: "none", reason: "no build" },
  deps: { kind: "none" },
  symptom: { kind: "file", path: "cases/a.md" },
};

/** One changed value per field of the spec, so every field is exercised. */
const CHANGED: {
  readonly [K in keyof RegressionCaseSpec]-?: RegressionCaseSpec[K];
} = {
  repo: "/elsewhere/checkout",
  commit: "c".repeat(40),
  head: "d".repeat(40),
  tests: { run: ["**/*.spec.ts"], data: [] },
  testCommand: ["npx", "jest"],
  build: { kind: "command", argv: ["npx", "tsc"] },
  deps: { kind: "node-modules" },
  symptom: { kind: "file", path: "cases/b.md" },
  source: ["lib/**"],
  hide: ["cases/**"],
  runs: 3,
  scoringTimeoutMs: 1000,
};

describe("caseKeyView", () => {
  it("changes when any keyed field changes and not when only an excluded one does", () => {
    const base = JSON.stringify(caseKeyView(CASE));
    const fields = keys(CHANGED);
    const moved = fields.filter(
      (k) => JSON.stringify(caseKeyView({ ...CASE, [k]: CHANGED[k] })) !== base,
    );
    // Guards: the key follows the table — every keyed field moves it, `repo` alone never does.
    expect(moved).toEqual(fields.filter((k) => CASE_KEY_FIELDS[k] === "keyed"));
    // Guards: the decision itself (the #416 design): `repo` is the ONLY field a lock may ignore; excluding any other makes a stale lock replay.
    expect(fields.filter((k) => !moved.includes(k))).toEqual(["repo"]);
  });

  it("leaves an unset optional field out and holds a set one as written", () => {
    const view = caseKeyView({ ...CASE, runs: 2 });
    // Guards: unset optional fields are absent, not undefined-valued.
    expect(Object.keys(caseKeyView(CASE))).not.toContain("source");
    // Guards: a set field is kept as written (no default folded in).
    expect(view.runs).toBe(2);
    expect(view.repo).toBeUndefined();
  });
});
