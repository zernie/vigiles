/**
 * What every linter's proof shares: the scope test, the pair verdict, and the
 * split of per-file reports.
 */
import { describe, expect, it } from "vitest";
import { inScope, judgePair, summarize } from "./pair.js";
import type { FileReport } from "./types.js";

const scope = { files: ["src/**/*.js"], ignores: ["src/vendor/**"] };

describe("inScope", () => {
  it("in when a files pattern matches and no ignore does", () => {
    expect(inScope("src/a.js", scope)).toBe(true);
    expect(inScope("src/.hidden/a.js", scope)).toBe(true);
  });
  it("out when no files pattern matches, or an ignore does", () => {
    expect(inScope("lib/a.js", scope)).toBe(false);
    expect(inScope("src/vendor/a.js", scope)).toBe(false);
  });
});

describe("judgePair", () => {
  const linted = (path: string, hits: number): FileReport => ({
    path,
    kind: "linted",
    hits,
  });
  it("proved: the bad file flagged, its twin clean", () => {
    expect(judgePair(linted("b", 1), linted("g", 0))).toEqual({
      kind: "proved",
    });
  });
  it("not proved: the counts say which direction failed", () => {
    expect(judgePair(linted("b", 0), linted("g", 0))).toEqual({
      kind: "not-proved",
      badHits: 0,
      goodHits: 0,
    });
    expect(judgePair(linted("b", 2), linted("g", 1))).toEqual({
      kind: "not-proved",
      badHits: 2,
      goodHits: 1,
    });
  });
  it("a planted file that did not parse, or was ignored, is not a verdict", () => {
    expect(
      judgePair(
        { path: "b", kind: "parse-error", message: "m" },
        linted("g", 0),
      ),
    ).toEqual({ kind: "not-run", stage: "parse", reason: "b: m" });
    expect(judgePair(linted("b", 1), { path: "g", kind: "ignored" })).toEqual({
      kind: "not-run",
      stage: "pair-ignored",
      reason: "g: the linter ignored the planted file",
    });
  });
});

describe("summarize", () => {
  it("splits reports into flagged, parse errors and ignored, sorted", () => {
    expect(
      summarize([
        { path: "z.js", kind: "linted", hits: 1 },
        { path: "a.js", kind: "linted", hits: 3 },
        { path: "c.js", kind: "linted", hits: 0 },
        { path: "p.js", kind: "parse-error", message: "m" },
        { path: "i.js", kind: "ignored" },
      ]),
    ).toEqual({
      linted: 3,
      flagged: ["a.js", "z.js"],
      parseErrors: ["p.js"],
      ignored: ["i.js"],
    });
  });
});
