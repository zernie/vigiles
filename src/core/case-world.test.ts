/**
 * The pure rules of a regression case's world: which commits refuse, what
 * the symptom file and the installs must be, and the edits that turn the
 * world back into the fix. Every refusal has a case that reaches it and a
 * case one step short of it.
 */
import { describe, expect, it } from "vitest";
import {
  caseDeps,
  escapes,
  goldEditRows,
  goldRows,
  historyRefusal,
  parseTreeEntries,
  removedPaths,
  symptomRefusal,
  type DepsFacts,
  type TreeEntry,
} from "./case-world.js";

const file = (path: string, blob = `b-${path}`): TreeEntry => ({
  mode: "100644",
  blob,
  path,
});

describe("parseTreeEntries", () => {
  it("reads mode, blob and a path with spaces and tabs", () => {
    const z =
      "100644 blob aaa\tsrc/a b.ts\0" +
      "120000 blob bbb\tlink\0" +
      "160000 commit ccc\tvendor/sub\0";
    // Guards: a path is everything after the first tab, never split on spaces.
    expect(parseTreeEntries(z)).toEqual([
      { mode: "100644", blob: "aaa", path: "src/a b.ts" },
      { mode: "120000", blob: "bbb", path: "link" },
      { mode: "160000", blob: "ccc", path: "vendor/sub" },
    ]);
  });

  it("reads an empty tree as no entries", () => {
    expect(parseTreeEntries("")).toEqual([]);
  });
});

describe("historyRefusal", () => {
  const ok = { head: "h", parents: ["p"], isAncestor: () => true };

  it("passes a single-parent ancestor of head", () => {
    expect(historyRefusal("main", ok)).toBeUndefined();
  });

  it.each([
    [
      { ...ok, head: undefined },
      { kind: "head-not-a-commit", head: "main" },
    ],
    [{ ...ok, parents: undefined }, { kind: "commit-not-in-history" }],
    [
      { ...ok, parents: [] },
      { kind: "merge-commit", parents: 0 },
    ],
    [
      { ...ok, parents: ["p", "q"] },
      { kind: "merge-commit", parents: 2 },
    ],
    [
      { ...ok, isAncestor: () => false },
      { kind: "commit-not-ancestor-of-head", head: "main" },
    ],
  ])("refuses %o", (facts, refusal) => {
    expect(historyRefusal("main", facts)).toEqual(refusal);
  });

  it("asks ancestry of the resolved head, only once the rest holds", () => {
    const asked: string[] = [];
    const isAncestor = (h: string): boolean => {
      asked.push(h);
      return true;
    };
    historyRefusal("main", { ...ok, parents: ["p", "q"], isAncestor });
    historyRefusal("main", { ...ok, head: "resolved", isAncestor });
    // Guards: the declared name is never the commit ancestry is asked about.
    expect(asked).toEqual(["resolved"]);
  });
});

describe("escapes", () => {
  it.each(["/etc/x", "../x", "a/../b", "./a", "a//b", "a/"])(
    "%s escapes",
    (p) => {
      expect(escapes(p)).toBe(true);
    },
  );

  it.each(["a", "src/a.ts", ".github/ISSUE.md", "a..b"])(
    "%s stays inside",
    (p) => {
      expect(escapes(p)).toBe(false);
    },
  );
});

describe("symptomRefusal", () => {
  const entry = file("ISSUE.md", "blob1");

  it("passes a committed regular file the working copy did not change", () => {
    expect(symptomRefusal("ISSUE.md", entry, () => "blob1")).toBeUndefined();
  });

  it.each([
    ["../ISSUE.md", entry, "blob1", "symptom-path-escapes"],
    ["ISSUE.md", undefined, "blob1", "symptom-not-committed"],
    ["ISSUE.md", { ...entry, mode: "120000" }, "blob1", "symptom-not-a-file"],
    ["ISSUE.md", entry, "blob2", "symptom-uncommitted-changes"],
    ["ISSUE.md", entry, undefined, "symptom-uncommitted-changes"],
  ] as const)("%s %o %s → %s", (...[path, atHead, working, kind]) => {
    expect(symptomRefusal(path, atHead, () => working)).toEqual({
      kind,
      path,
    });
  });
});

describe("removedPaths", () => {
  it("removes the symptom file and every entry hide matches", () => {
    const entries = ["ISSUE.md", "notes/a.md", "notes/b.md", "src/a.ts"].map(
      (p) => file(p),
    );
    expect(removedPaths(entries, "ISSUE.md", ["notes/**"])).toEqual([
      "ISSUE.md",
      "notes/a.md",
      "notes/b.md",
    ]);
  });
});

describe("goldRows", () => {
  it("writes a regular file, deletes an absent one, leaves a link out", () => {
    const entries = [
      file("src/a.ts", "aaa"),
      { mode: "100755", blob: "xxx", path: "bin/run" },
      { mode: "120000", blob: "lll", path: "src/link" },
    ];
    expect(
      goldRows(["src/a.ts", "bin/run", "src/gone.ts", "src/link"], entries),
    ).toEqual([
      {
        status: "M",
        path: "src/a.ts",
        entry: { kind: "file", mode: "100644", blob: "aaa" },
      },
      {
        status: "M",
        path: "bin/run",
        entry: { kind: "file", mode: "100755", blob: "xxx" },
      },
      { status: "D", path: "src/gone.ts", entry: { kind: "absent" } },
    ]);
  });
});

describe("goldEditRows", () => {
  const gold = goldRows(["src/a.ts"], [file("src/a.ts")]);

  it("adds the deletion of the first oracle", () => {
    expect(goldEditRows(gold, ["test/a.test.ts", "test/b.test.ts"])).toEqual([
      ...gold,
      { status: "D", path: "test/a.test.ts", entry: { kind: "absent" } },
    ]);
  });

  it("is gold alone with no oracle", () => {
    expect(goldEditRows(gold, [])).toEqual(gold);
  });
});

const facts = (
  installs: readonly string[],
  entries: readonly TreeEntry[],
  working: DepsFacts["working"] = (p) =>
    entries.find((e) => e.path === p)?.blob,
): DepsFacts => ({ installs, entries, working });

describe("caseDeps: what a case copies", () => {
  it("keeps the installs under the roots and every lockfile at a root, sorted", () => {
    const entries = [
      file("yarn.lock"),
      file("package-lock.json"),
      file("docs/package-lock.json"),
    ];
    expect(
      caseDeps(["."], facts(["node_modules", "other/node_modules"], entries)),
    ).toEqual({
      kind: "deps",
      deps: {
        installs: ["node_modules", "other/node_modules"],
        lockfiles: [file("package-lock.json"), file("yarn.lock")],
      },
    });
  });

  it("drops an install outside every declared root", () => {
    const entries = [file("app/pnpm-lock.yaml")];
    const got = caseDeps(
      ["app"],
      facts(["node_modules", "app/node_modules"], entries),
    );
    expect(got).toEqual({
      kind: "deps",
      deps: { installs: ["app/node_modules"], lockfiles: entries },
    });
  });
});

describe("caseDeps: what refuses", () => {
  it.each([
    [[], [file("package-lock.json")], "no-node-modules"],
    [["node_modules"], [], "no-lockfile"],
    [["node_modules"], [file("sub/package-lock.json")], "no-lockfile"],
  ] as const)("refuses %o %o as %s", (installs, entries, why) => {
    expect(caseDeps(["."], facts(installs, entries))).toEqual({
      kind: "deps-unsupported",
      why,
    });
  });

  it("refuses a lockfile the working copy changed", () => {
    const entries = [file("package-lock.json", "head")];
    // Guards: an install built from another lockfile is not head's install.
    expect(
      caseDeps(
        ["."],
        facts(["node_modules"], entries, () => "edited"),
      ),
    ).toEqual({
      kind: "host-install-not-at-head",
      lockfile: "package-lock.json",
    });
  });
});

describe("caseDeps: a lockfile under a root", () => {
  it("refuses a lockfile between a root and an install under it", () => {
    const entries = [file("package-lock.json"), file("pkg/yarn.lock")];
    expect(caseDeps(["."], facts(["pkg/sub/node_modules"], entries))).toEqual({
      kind: "deps-unsupported",
      why: "nested-lockfile",
      dir: "pkg",
    });
  });

  it("refuses a lockfile at the install's own package", () => {
    const entries = [file("package-lock.json"), file("pkg/yarn.lock")];
    expect(caseDeps(["."], facts(["pkg/node_modules"], entries))).toEqual({
      kind: "deps-unsupported",
      why: "nested-lockfile",
      dir: "pkg",
    });
  });

  it("accepts that lockfile once its directory is a declared root", () => {
    const entries = [file("package-lock.json"), file("pkg/yarn.lock")];
    expect(
      caseDeps([".", "pkg"], facts(["pkg/sub/node_modules"], entries)),
    ).toMatchObject({ kind: "deps" });
  });

  it("ignores a lockfile beside, not above, an install", () => {
    const entries = [file("package-lock.json"), file("other/yarn.lock")];
    expect(caseDeps(["."], facts(["pkg/node_modules"], entries))).toMatchObject(
      { kind: "deps" },
    );
  });
});
