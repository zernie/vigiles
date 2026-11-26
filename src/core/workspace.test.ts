/**
 * The pure half of a repo workspace: reading git's raw diff into one row per
 * path, and which declared harnesses a workspace eval refuses.
 */
import { describe, expect, it } from "vitest";
import {
  describeWorkspaceRefusal,
  harnessRefusal,
  parseRawDiff,
} from "./workspace.js";

const SHA = "0".repeat(40);

describe("parseRawDiff", () => {
  it("reads one row per NUL-separated entry with the new side's entry kind", () => {
    const B = "b".repeat(40);
    const z = [
      `:100644 100755 ${SHA} ${B} M`,
      "src/a b.ts",
      `:000000 160000 ${SHA} ${SHA} A`,
      "vendor/lib",
      `:100644 120000 ${SHA} ${SHA} T`,
      "src/link",
      `:100644 000000 ${SHA} ${SHA} D`,
      "src/gone.ts",
      `:000000 040000 ${SHA} ${SHA} A`,
      "src/odd",
      "",
    ].join("\0");
    // Guards: a scorer carries only `file` rows, so a symlink, a gitlink or an unknown mode must never read as one, and the blob id is the new side's.
    expect(parseRawDiff(z)).toEqual([
      {
        status: "M",
        path: "src/a b.ts",
        entry: { kind: "file", mode: "100755", blob: B },
      },
      { status: "A", path: "vendor/lib", entry: { kind: "gitlink" } },
      { status: "T", path: "src/link", entry: { kind: "symlink" } },
      { status: "D", path: "src/gone.ts", entry: { kind: "absent" } },
      {
        status: "A",
        path: "src/odd",
        entry: { kind: "other", mode: "040000" },
      },
    ]);
  });

  it("reads an empty diff as no rows", () => {
    expect(parseRawDiff("")).toEqual([]);
  });

  it("refuses a rename row, which --no-renames must have ruled out", () => {
    const z = `:100644 100644 ${SHA} ${SHA} R100\0a\0b\0`;
    // Guards: a rename row would hide one side of the move from the scorer.
    expect(() => parseRawDiff(z)).toThrow(/unexpected git raw diff entry/);
  });
});

describe("harnessRefusal", () => {
  it("runs a repo that declares nothing, or declares the driven harness", () => {
    expect(harnessRefusal([], "a")).toBeUndefined();
    expect(harnessRefusal(["b", "a"], "a")).toBeUndefined();
  });

  it("refuses a repo whose declared harnesses leave out the driven one", () => {
    const r = harnessRefusal(["b"], "a");
    expect(r).toEqual({
      kind: "harness-not-driven",
      declared: ["b"],
      driven: "a",
    });
    // Guards: the line names both sides, so the user knows what to change.
    expect(
      describeWorkspaceRefusal(r ?? { kind: "workspace-with-fixture" }),
    ).toMatch(/declares b .* drives a only/);
  });
});
