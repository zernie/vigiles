/**
 * The pure half of the per-trial context check (vigiles#416): which pieces of
 * an instruction file must appear in the request, and the evidence that
 * follows. The normalisation mirrors what Claude Code 2.1.330 was measured to
 * do to a file on its way into the request.
 */
import { describe, expect, it } from "vitest";

import {
  contextEvidence,
  contextFailure,
  contextSummaryLines,
  deliveredIn,
  instructionSegments,
  unobservableContext,
} from "./context-evidence.js";

describe("instructionSegments", () => {
  it("drops a BOM, CRLF, HTML comments and leading frontmatter", () => {
    expect(
      instructionSegments("\uFEFF---\na: 1\n---\nA\r\n<!-- x -->\r\nB\r\n"),
    ).toEqual(["A", "B"]);
  });
});

describe("deliveredIn", () => {
  it("needs every piece, in order", () => {
    expect(deliveredIn("A\n<!--c-->\nB", "pre A\nB post")).toBe(true);
    expect(deliveredIn("A\n<!--c-->\nB", "B then A")).toBe(false);
    expect(deliveredIn("A", "nothing")).toBe(false);
  });
});

describe("contextEvidence", () => {
  const expected = [
    { path: "CLAUDE.md", text: "rule one" },
    { path: "docs/style.md", text: "rule two" },
  ];
  it("tells the four outcomes apart", () => {
    expect(contextEvidence([], "x")).toEqual({ kind: "nothing-expected" });
    expect(contextEvidence(expected, undefined)).toEqual({
      kind: "unobservable",
      why: "no-request-body",
      files: ["CLAUDE.md", "docs/style.md"],
    });
    expect(contextEvidence(expected, "rule one, rule two")).toEqual({
      kind: "delivered",
      files: ["CLAUDE.md", "docs/style.md"],
    });
    expect(contextEvidence(expected, "rule one")).toEqual({
      kind: "missing",
      files: ["docs/style.md"],
      delivered: ["CLAUDE.md"],
    });
    expect(unobservableContext([], "opted-out")).toEqual({
      kind: "nothing-expected",
    });
  });
});

describe("contextSummaryLines and contextFailure", () => {
  const missing = {
    kind: "missing",
    files: ["AGENTS.md"],
    delivered: [],
  } as const;
  const delivered = { kind: "delivered", files: ["AGENTS.md"] } as const;
  it("names the file and the trial count", () => {
    expect(contextSummaryLines([missing, missing, delivered])).toEqual([
      "✗ context: AGENTS.md missing from the model's request in 2 of 3 trials — not scored",
      "✓ context: AGENTS.md delivered in 1 of 3 trials",
    ]);
    expect(
      contextSummaryLines([
        { kind: "unobservable", why: "opted-out", files: ["AGENTS.md"] },
      ]),
    ).toEqual([
      "⚠ context not checked: experimental_contextCheck is false in 1 of 1 trials",
    ]);
    expect(contextSummaryLines([])).toEqual([]);
    expect(contextFailure({ a: { context: [delivered] } })).toBeUndefined();
    expect(contextFailure({ a: { context: [missing] }, b: {} })).toBe(
      "a: ✗ context: AGENTS.md missing from the model's request in 1 of 1 trials — not scored",
    );
  });
});
