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
  it("reads one row per NUL-separated entry and marks a gitlink", () => {
    const z = [
      `:100644 100644 ${SHA} ${SHA} M`,
      "src/a.ts",
      `:000000 160000 ${SHA} ${SHA} A`,
      "vendor/lib",
      "",
    ].join("\0");
    // Guards: a path with spaces or newlines survives, since -z keeps it verbatim.
    expect(parseRawDiff(z)).toEqual([
      { status: "M", path: "src/a.ts", gitlink: false },
      { status: "A", path: "vendor/lib", gitlink: true },
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
