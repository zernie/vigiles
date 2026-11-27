/**
 * Steps 1-4 of the pre-flight over a stub host: each refusal is reached in
 * the order a user fixes them, and a case that passes them carries the world
 * patch (reverts, then removals) and gold over the reverted paths that
 * applied. The machine reads behind the stub are tested on a real repository
 * in `src/host/case-world.io.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { TreeEntry } from "./core/case-world.js";
import type { FixPath, RegressionCaseSpec } from "./core/regression-case.js";
import { caseWorldHost } from "./host/case-world.io.js";
import { repoCopyHost } from "./host/workspace-host.io.js";
import { planWorld, type PlanHost } from "./eval-case-plan.js";

const HEAD = "h".repeat(40);
const FIX = "f".repeat(40);

const file = (path: string): TreeEntry => ({
  mode: "100644",
  blob: `b-${path}`,
  path,
});

const ENTRIES: readonly TreeEntry[] = [
  file("ISSUE.md"),
  file("notes/a.md"),
  file("package-lock.json"),
  file("src/add.ts"),
  file("src/util.ts"),
  file("test/add.test.ts"),
];

const FIX_PATHS: readonly FixPath[] = [
  { status: "M", path: "src/add.ts" },
  { status: "M", path: "src/util.ts" },
  { status: "A", path: "src/gone.ts" },
  { status: "A", path: "test/add.test.ts" },
];

const SPEC: RegressionCaseSpec = {
  repo: ".",
  commit: FIX,
  head: "main",
  tests: { run: ["test/**/*.test.ts"], data: [] },
  testCommand: ["node", "--test"],
  build: { kind: "none", reason: "plain JS" },
  deps: { kind: "none" },
  symptom: { kind: "file", path: "ISSUE.md" },
  hide: ["notes/**"],
};

/**
 * The ports the plan reads, each overridable, over the real adapters: a
 * port the plan should not read would run git on a path that does not
 * exist and fail the test.
 */
function stub(over: Partial<PlanHost> = {}): PlanHost {
  return {
    ...repoCopyHost,
    ...caseWorldHost,
    resolveCommit: () => HEAD,
    parents: () => ["p".repeat(40)],
    isAncestor: () => true,
    treeEntries: () => ENTRIES,
    fixPaths: () => FIX_PATHS,
    workingBlob: (_top, path) => `b-${path}`,
    findInstalls: () => ["node_modules"],
    revertPatches: (_top, at) => ({
      patch: at.paths.map((p) => `rev ${p}\n`).join(""),
      failed: [],
    }),
    removalPatch: (_top, _head, paths) => `del ${paths.join(" ")}\n`,
    ...over,
  };
}

describe("planWorld", () => {
  it("plans the world: reverts, then removals, and gold over what applied", () => {
    const plan = planWorld(stub(), "/nonexistent-repo", SPEC);
    expect(plan).toEqual({
      kind: "planned",
      head: HEAD,
      split: {
        oracle: ["test/add.test.ts"],
        testPaths: ["test/add.test.ts"],
        reverted: ["src/add.ts", "src/util.ts", "src/gone.ts"],
      },
      deps: { installs: [], lockfiles: [] },
      patch:
        "rev src/add.ts\nrev src/util.ts\nrev src/gone.ts\n" +
        "del ISSUE.md notes/a.md\n",
      gold: [
        {
          status: "M",
          path: "src/add.ts",
          entry: { kind: "file", mode: "100644", blob: "b-src/add.ts" },
        },
        {
          status: "M",
          path: "src/util.ts",
          entry: { kind: "file", mode: "100644", blob: "b-src/util.ts" },
        },
        { status: "D", path: "src/gone.ts", entry: { kind: "absent" } },
      ],
      markdownKeptAtHead: [],
    });
  });
});

describe("planWorld: what it reverts", () => {
  it("does not revert a path the world removes anyway", () => {
    const asked: string[][] = [];
    const host = stub({
      revertPatches: (_top, at) => {
        asked.push([...at.paths]);
        return { patch: "", failed: [] };
      },
    });
    planWorld(host, "/nonexistent-repo", {
      ...SPEC,
      hide: ["notes/**", "src/util.ts"],
    });
    // Guards: a hidden path is deleted, never first reversed into the world.
    expect(asked).toEqual([["src/add.ts", "src/gone.ts"]]);
  });

  it("keeps a Markdown file that did not revert, and leaves it out of gold", () => {
    const host = stub({
      fixPaths: () => [...FIX_PATHS, { status: "M", path: "docs/api.md" }],
      revertPatches: () => ({ patch: "", failed: ["docs/api.md"] }),
    });
    const plan = planWorld(host, "/nonexistent-repo", SPEC);
    expect(plan).toMatchObject({ markdownKeptAtHead: ["docs/api.md"] });
    expect(
      plan.kind === "planned" && plan.gold.map((g) => g.path),
    ).not.toContain("docs/api.md");
  });
});

describe("planWorld: refusals", () => {
  it("refuses a non-Markdown file that did not revert as outdated", () => {
    const host = stub({
      revertPatches: () => ({ patch: "", failed: ["src/util.ts"] }),
    });
    expect(planWorld(host, "/nonexistent-repo", SPEC)).toEqual({
      kind: "refused",
      refusal: {
        kind: "outdated",
        why: "revert-conflict",
        files: [{ path: "src/util.ts" }],
      },
    });
  });
});

describe("planWorld: installs", () => {
  it("reads the installs only when the case declares them", () => {
    const deps: RegressionCaseSpec["deps"] = { kind: "node-modules" };
    expect(
      planWorld(stub(), "/nonexistent-repo", { ...SPEC, deps }),
    ).toMatchObject({
      kind: "planned",
      deps: {
        installs: ["node_modules"],
        lockfiles: [file("package-lock.json")],
      },
    });
    expect(
      planWorld(stub({ findInstalls: () => [] }), "/nonexistent-repo", {
        ...SPEC,
        deps,
      }),
    ).toEqual({
      kind: "refused",
      refusal: { kind: "deps-unsupported", why: "no-node-modules" },
    });
  });
});

describe("planWorld: refusal order", () => {
  it.each([
    [
      "an unresolved head",
      { resolveCommit: () => undefined },
      { kind: "head-not-a-commit", head: "main" },
    ],
    [
      "a fix missing from history",
      { parents: () => undefined },
      { kind: "commit-not-in-history" },
    ],
    [
      "a fix that is not an ancestor",
      { isAncestor: () => false },
      { kind: "commit-not-ancestor-of-head", head: "main" },
    ],
    [
      "an oracle missing at head",
      { treeEntries: () => ENTRIES.filter((e) => !e.path.startsWith("test/")) },
      { kind: "oracle-missing-in-world", paths: ["test/add.test.ts"] },
    ],
    [
      "a symptom the working copy changed",
      { workingBlob: () => "edited" },
      { kind: "symptom-uncommitted-changes", path: "ISSUE.md" },
    ],
  ] as const)("refuses %s", (_name, over, refusal) => {
    expect(planWorld(stub(over), "/nonexistent-repo", SPEC)).toEqual({
      kind: "refused",
      refusal,
    });
  });

  it("refuses in the order a user fixes them: history before paths", () => {
    const host = stub({ isAncestor: () => false, fixPaths: () => [] });
    expect(planWorld(host, "/nonexistent-repo", SPEC)).toMatchObject({
      refusal: { kind: "commit-not-ancestor-of-head" },
    });
  });
});
