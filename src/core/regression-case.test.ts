/** The pure half of a regression case, on planted paths and texts; no git. */
import { keys } from "remeda";
import { describe, expect, it } from "vitest";
import {
  CASE_KEY_FIELDS,
  caseKeyView,
  defaultSource,
  driftVerdict,
  fileDrift,
  matchesAny,
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
    // Guards: src/core/a.ts gives src/**, a root file only itself, Markdown nothing.
    const paths = "src/x/a.ts src/b.ts t.json d/x.md R.md l/c.js".split(" ");
    expect(defaultSource(paths)).toEqual(["l/**", "src/**", "t.json"]);
  });

  it("escapes glob characters, so a default names its own path literally", () => {
    const source = defaultSource(["[app]/x.ts", "*.ts"]);
    // Guards: `[app]/**` as a glob matches `a/x.ts`, not `[app]/x.ts`.
    expect(matchesAny("[app]/x.ts", source)).toBe(true);
    expect(matchesAny("a/x.ts", source)).toBe(false);
    // Guards: a root file named `*.ts` covers itself only, not every root `.ts`.
    expect(matchesAny("*.ts", source)).toBe(true);
    expect(matchesAny("b.ts", source)).toBe(false);
  });

  it("is overridden by a declared source", () => {
    const split: FixSplit = {
      oracle: [],
      testPaths: [],
      reverted: ["src/a.ts"],
    };
    // Guards: the declaration wins; the default is only for an unset source.
    expect(resolvedSource(["lib/**"], split)).toEqual(["lib/**"]);
    expect(resolvedSource(undefined, split)).toEqual(["src/**"]);
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

const CODE_AT_FIX = "// old note\nexport const a = 1;\n";

describe("fileDrift and driftVerdict", () => {
  it("keeps Markdown at head and puts back code changed only in comments", () => {
    const v = driftVerdict([
      { path: "docs/x.md", atFix: "a", atHead: "b" },
      {
        path: "src/a.ts",
        atFix: CODE_AT_FIX,
        atHead: "// new note\nexport const a = 1;\n",
      },
    ]);
    // Guards: neither file makes the case outdated, and each is listed for the report.
    expect(v).toEqual({
      kind: "kept",
      markdownKeptAtHead: ["docs/x.md"],
      commentOnlyPutBack: ["src/a.ts"],
    });
    // Guards: an empty failure list is not outdated.
    expect(driftVerdict([]).kind).toBe("kept");
  });

  it("makes the case outdated naming only the files that conflict, each with its reason", () => {
    const v = driftVerdict([
      { path: "docs/x.md", atFix: "a", atHead: "b" },
      { path: "src/a.ts", atFix: CODE_AT_FIX, atHead: "export const a = 2;\n" },
      { path: "tool.py", atFix: "a", atHead: "b" },
      { path: "src/b.ts", atFix: "const = ;", atHead: "const b = 1;" },
    ]);
    // Guards: a code change, an unread language and a parse error each refuse with their own drift.
    expect(v).toEqual({
      kind: "outdated",
      files: [
        { path: "src/a.ts", drift: "not-comment-only" },
        { path: "tool.py", drift: "language-not-supported" },
        { path: "src/b.ts", drift: "unparsable" },
      ],
    });
  });

  it("reads a code file absent on either side as changed in code", () => {
    const sides = [
      [undefined, "x"],
      ["x", undefined],
    ] as const;
    // Guards: a deleted or new file is never comment-only.
    expect(
      sides.map(([atFix, atHead]) =>
        fileDrift({ path: "a.ts", atFix, atHead }),
      ),
    ).toEqual(Array(2).fill({ kind: "conflict", drift: "not-comment-only" }));
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
