/**
 * The boundary of `experimental_regressionCases`: a well-formed list passes as
 * written, and every malformed field is refused as an `EvalSpecRefusalError`
 * whose line names the field, before anything runs.
 */
import { describe, expect, it } from "vitest";
import {
  depsRoots,
  EvalSpecRefusalError,
  parseRegressionCases,
  type RegressionCaseEntry,
} from "./regression-case-entries.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

const entry: RegressionCaseEntry = {
  id: "prefix-spelling",
  repo: ".",
  commit: A,
  head: B,
  tests: { run: ["**/*.test.ts"], data: [] },
  testCommand: ["npx", "vitest", "run"],
  build: { kind: "none", reason: "no build step" },
  deps: { kind: "node-modules" },
  symptom: { kind: "file", path: "cases/x.md" },
};

/** The message of the refusal `raw` raises. */
function refusal(raw: unknown): string {
  try {
    parseRegressionCases(raw);
  } catch (e) {
    // Guards: every malformed shape is the spec-refusal class, never a bare Error.
    expect(e).toBeInstanceOf(EvalSpecRefusalError);
    return e instanceof Error ? e.message : "";
  }
  throw new Error("parsed without a refusal");
}

describe("parseRegressionCases", () => {
  it("passes a well-formed list through and leaves an absent key absent", () => {
    // Guards: the parse returns the entries as written.
    expect(parseRegressionCases([entry])).toEqual([entry]);
    expect(parseRegressionCases(undefined)).toBeUndefined();
  });

  it.each([
    ["an empty list", [], "experimental_regressionCases"],
    ["a short commit", [{ ...entry, commit: "abc1234" }], "[0].commit"],
    ["a missing head", [{ ...entry, head: undefined }], "[0].head"],
    ["an empty testCommand", [{ ...entry, testCommand: [] }], "testCommand"],
    [
      "an empty tests.run",
      [{ ...entry, tests: { run: [], data: [] } }],
      "tests.run",
    ],
    [
      "an unknown key",
      [{ ...entry, task: "x" }],
      "experimental_regressionCases[0]",
    ],
    ["an id with capitals", [{ ...entry, id: "Fix" }], "[0].id"],
    ["a repeated id", [entry, { ...entry }], "[1].id"],
    [
      "an empty deps.roots",
      [{ ...entry, deps: { kind: "node-modules", roots: [] } }],
      "deps.roots",
    ],
  ])("refuses %s, naming the field", (_what, raw, field) => {
    // Guards: the refusal line names the field the author has to fix.
    expect(refusal(raw)).toContain(field);
  });
});

describe("depsRoots", () => {
  it("defaults to the repository root, and is empty without installs", () => {
    // Guards: an install with no declared roots is keyed by the root lockfile.
    expect(depsRoots(entry)).toEqual(["."]);
    expect(
      depsRoots({ ...entry, deps: { kind: "node-modules", roots: ["web"] } }),
    ).toEqual(["web"]);
    expect(depsRoots({ ...entry, deps: { kind: "none" } })).toEqual([]);
  });
});
