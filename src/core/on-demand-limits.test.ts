/**
 * The on-demand detector alone, over hand-built chains: which entries it
 * weighs, the boundary, the override, and "not modelled" when the harness
 * declares no cut. The disk walk and the CLI are covered by the two
 * `on-demand-lint.test.ts` files beside each adapter.
 */
import { describe, expect, it } from "vitest";

import type { InstructionChain } from "./instruction-chain.js";
import {
  checkOnDemandFiles,
  onDemandEntries,
  type OnDemandFileLimit,
} from "./on-demand-limits.js";

const RULE: OnDemandFileLimit = {
  unit: "chars",
  limit: 10,
  since: "v1",
  larger: "20 on a large window",
  excludeSetting: { key: "excludes", file: "settings.json" },
  capturedFrom: "test",
};

const chain = (unloaded: InstructionChain["unloaded"]): InstructionChain => ({
  loaded: [{ path: "ROOT.md", role: "root", scope: "repo" }],
  unloaded,
  imports: [],
  patterns: [],
  redirects: [],
});

const CHAIN = chain([
  {
    path: "a/F.md",
    role: "root",
    scope: "repo",
    reason: { kind: "on-demand", when: "subdirectory" },
  },
  {
    path: "r/x.md",
    role: "rule",
    scope: "repo",
    reason: { kind: "on-demand", when: "path-scoped" },
  },
  {
    path: "b/F.md",
    role: "root",
    scope: "repo",
    reason: {
      kind: "excluded-by-settings",
      key: "excludes",
      by: "settings.json",
      byScope: "repo",
    },
  },
  {
    path: "c/F.local.md",
    role: "root-local",
    scope: "local",
    reason: { kind: "on-demand", when: "subdirectory" },
  },
]);

const FILES: Readonly<Record<string, string>> = {
  "ROOT.md": "x".repeat(100),
  "a/F.md": "x".repeat(11),
  "r/x.md": "x".repeat(10),
  "b/F.md": "x".repeat(100),
  "c/F.local.md": "x".repeat(100),
};

describe("onDemandEntries", () => {
  it("keeps every committed on-demand entry, of both triggers, and nothing else", () => {
    // Guards: excluded, launch-time and per-machine files are never weighed.
    expect(onDemandEntries(CHAIN).map((e) => [e.path, e.when])).toEqual([
      ["a/F.md", "subdirectory"],
      ["r/x.md", "path-scoped"],
    ]);
  });
});

describe("checkOnDemandFiles", () => {
  it("is not modelled when the harness declares no cut", () => {
    // Guards: an absent cut reads as unmodelled, never as "nothing over".
    expect(
      checkOnDemandFiles({
        chain: CHAIN,
        files: FILES,
        rule: undefined,
        limit: undefined,
      }),
    ).toEqual({
      kind: "not-modelled",
    });
  });

  it("flags a file strictly over the cut, not one at it", () => {
    const check = checkOnDemandFiles({
      chain: CHAIN,
      files: FILES,
      rule: RULE,
      limit: undefined,
    });
    if (check.kind !== "checked") throw new Error(check.kind);
    // Guards: the boundary is inclusive, as the harness's own cut is.
    expect(check.over.map((f) => f.path)).toEqual(["a/F.md"]);
    expect(check.files.map((f) => f.path)).toEqual(["a/F.md", "r/x.md"]);
  });

  it("an override replaces the harness's floor", () => {
    const check = checkOnDemandFiles({
      chain: CHAIN,
      files: FILES,
      rule: RULE,
      limit: 11,
    });
    if (check.kind !== "checked") throw new Error(check.kind);
    // Guards: a repository that runs only larger windows can raise the floor.
    expect(check.limit).toBe(11);
    expect(check.over).toEqual([]);
  });

  it("skips an entry whose text it was not handed", () => {
    const check = checkOnDemandFiles({
      chain: CHAIN,
      files: { "a/F.md": "x" },
      rule: RULE,
      limit: undefined,
    });
    if (check.kind !== "checked") throw new Error(check.kind);
    // Guards: no size is invented for a file that was not read.
    expect(check.files.map((f) => f.path)).toEqual(["a/F.md"]);
  });
});
