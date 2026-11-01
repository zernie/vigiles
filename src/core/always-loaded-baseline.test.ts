/**
 * The ratchet over the ALWAYS-LOADED CONTEXT (vitest, unit tier, nothing spawned):
 * the version-2 baseline shape, and the verdict decided on the sum of the
 * instructions and the recorded parts.
 *
 * Harness-agnostic on purpose: the weights are built by hand in one unit, so
 * what is proven is the comparison, not a renderer. The two load-bearing
 * cases are the migration ones — a version-1 file gets NOTES and never a
 * finding, and a move between parts nets out once version 2 is recorded.
 */
import { describe, expect, it } from "vitest";

import type { AlwaysLoadedContext, LoadedPart } from "./always-loaded.js";
import {
  carryUnmeasured,
  compareAlwaysLoadedToBaseline,
  entryFor,
  formatBaselineVerdict,
  formatUnrecordedParts,
  parseInstructionBaseline,
  recordEntries,
  serializeBaseline,
  type BaselineEntry,
} from "./instruction-baseline.js";

type Weight = Parameters<typeof entryFor>[0];

const weight = (size: number): Weight => ({
  unit: "chars",
  limit: 40000,
  onExceed: "warns",
  files: [{ path: "INSTRUCTIONS.md", size, role: "root", scope: "repo" }],
  committedTotal: size,
  effectiveTotal: size,
  overBy: null,
  unreadImports: [],
  unweighedPatterns: [],
  redirects: [],
});

const part = (path: string, size: number): LoadedPart =>
  size === 0
    ? { kind: "none" }
    : { kind: "counted", total: size, files: [{ path, size }] };

const loaded = (
  instructions: number,
  style: number,
  listing: number,
): AlwaysLoadedContext => ({
  unit: "chars",
  instructions,
  outputStyle: part("styles/terse.md", style),
  skillListing: part("skills/a/SKILL.md", listing),
  total: instructions + style + listing,
});

/** A recorded entry as `--update-baseline` would write it. */
const recorded = (i: number, s: number, l: number): BaselineEntry =>
  entryFor(weight(i), loaded(i, s, l));

describe("version 2 on disk", () => {
  it("records only the parts that are not zero", () => {
    const e = recorded(100, 0, 30);
    expect(e.parts).toEqual({
      "skill-listing": {
        measure: 1,
        total: 30,
        files: { "skills/a/SKILL.md": 30 },
      },
    });
    expect(recorded(100, 0, 0).parts).toBeUndefined();
  });

  it("writes version 2 only when some entry carries a part", () => {
    expect(recordEntries(undefined, [[".", recorded(100, 0, 0)]]).version).toBe(
      1,
    );
    const v2 = recordEntries(undefined, [[".", recorded(100, 20, 30)]]);
    expect(v2.version).toBe(2);
    const reread = parseInstructionBaseline(serializeBaseline(v2));
    expect(reread).toEqual({ kind: "ok", baseline: v2 });
  });

  it("refuses parts in a version-1 file, and a part whose total is not its sum", () => {
    const withParts = {
      version: 1,
      bundles: { ".": recorded(100, 20, 0) },
    };
    expect(parseInstructionBaseline(JSON.stringify(withParts)).kind).toBe(
      "invalid",
    );
    const badSum = {
      version: 2,
      bundles: {
        ".": {
          ...recorded(100, 0, 0),
          parts: { "output-style": { measure: 1, total: 9, files: { a: 1 } } },
        },
      },
    };
    expect(parseInstructionBaseline(JSON.stringify(badSum)).kind).toBe(
      "invalid",
    );
  });
});

describe("compareAlwaysLoadedToBaseline — a version-1 file", () => {
  it("decides on the instructions and lists each new part for a note", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 20, 30),
      entryFor(weight(100)),
      1,
    );
    expect(v.kind).toBe("instructions-only");
    expect(v.verdict.kind).toBe("held");
    expect(v.kind === "instructions-only" && v.unrecordedParts).toEqual([
      { part: "output-style", total: 20 },
      { part: "skill-listing", total: 30 },
    ]);
  });

  it("stays on the instructions with no file and nothing to add", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 0, 0),
      undefined,
      "absent",
    );
    expect(v.kind).toBe("instructions-only");
  });
});

describe("compareAlwaysLoadedToBaseline — a version-2 file decides on the sum", () => {
  it("nets out text moved from the instructions into the style", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(70),
      loaded(70, 50, 30),
      recorded(100, 20, 30),
      2,
    );
    expect(v.verdict).toEqual({ kind: "held", total: 150, unit: "chars" });
    expect(v.kind === "always-loaded" && v.byPart).toEqual([
      { part: "instructions", from: 100, to: 70 },
      { part: "output-style", from: 20, to: 50 },
      { part: "skill-listing", from: 30, to: 30 },
    ]);
    // On `held` too: the move is printed, or a doubled part hides in the sum.
    expect(formatBaselineVerdict(v, ".")).toContain(
      "instructions 70 (-30) · output style 50 (+30) · skill listing 30",
    );
  });
});

describe("compareAlwaysLoadedToBaseline — a version-2 file reports growth by part", () => {
  it("names the part a file grew in", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 20, 45),
      recorded(100, 20, 30),
      2,
    );
    expect(v.verdict.kind).toBe("grew");
    expect(formatBaselineVerdict(v, ".")).toContain(
      "always-loaded context grew 150 → 165 chars (+15)",
    );
    expect(formatBaselineVerdict(v, ".")).toContain(
      "skills/a/SKILL.md (skill listing) +15",
    );
  });

  it("reads a part missing from a version-2 entry as growth, not a note", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 20, 30),
      recorded(100, 20, 0),
      2,
    );
    expect(v.verdict.kind).toBe("grew");
  });
});

describe("compareAlwaysLoadedToBaseline — a version-2 file whose measurement changed", () => {
  it("asks to re-record a part whose measurement changed, by name", () => {
    const old = recorded(100, 20, 30);
    const stale: BaselineEntry = {
      ...old,
      parts: {
        ...old.parts,
        "skill-listing": { measure: 0, total: 30, files: { a: 30 } },
      },
    };
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 20, 30),
      stale,
      2,
    );
    expect(v.verdict).toEqual({
      kind: "measure-changed",
      recorded: 0,
      current: 1,
      part: "skill-listing",
    });
    expect(formatBaselineVerdict(v, ".")).toContain(
      "baseline's skill listing was recorded by measurement 0",
    );
  });

  it("with no file and something to add, reports the always-loaded total unrecorded", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 20, 30),
      undefined,
      "absent",
    );
    expect(v.kind).toBe("always-loaded");
    expect(formatBaselineVerdict(v, ".")).toContain(
      "(150 chars always loaded)",
    );
  });
});

describe("compareAlwaysLoadedToBaseline — a recorded part this run cannot measure", () => {
  const unmeasurable: readonly LoadedPart[] = [
    { kind: "not-modelled" },
    { kind: "not-supported" },
    { kind: "unresolved", name: "Gone" },
  ];

  it.each(unmeasurable)(
    "carries a $kind listing at its recorded size, never as 0",
    (now) => {
      const v = compareAlwaysLoadedToBaseline(
        weight(100),
        { ...loaded(100, 0, 0), skillListing: now },
        recorded(100, 0, 30),
        2,
      );
      // Not "shrank 130 → 100": the part was not measured, not cut.
      expect(v.verdict).toEqual({ kind: "held", total: 130, unit: "chars" });
      expect(v.kind === "always-loaded" && v.unmeasured).toEqual([
        { part: "skill-listing", kind: now.kind, recorded: 30 },
      ]);
      const text = formatBaselineVerdict(v, ".");
      expect(text).toContain(
        `skill listing: recorded 30, not measured in this run (${now.kind})`,
      );
      expect(text).not.toContain("Lock the cut in");
    },
  );

  it("still sees the instructions grow while a part is carried", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(110),
      { ...loaded(110, 20, 0), skillListing: { kind: "not-modelled" } },
      recorded(100, 20, 30),
      2,
    );
    expect(v.verdict.kind).toBe("grew");
    expect(v.verdict.kind === "grew" && v.verdict.to).toBe(160);
  });

  it("reads `none` as a real zero: a listing emptied on purpose is a shrink", () => {
    const v = compareAlwaysLoadedToBaseline(
      weight(100),
      loaded(100, 0, 0),
      recorded(100, 0, 30),
      2,
    );
    expect(v.verdict.kind).toBe("shrank");
    expect(v.kind === "always-loaded" && v.unmeasured).toEqual([]);
  });

  it("keeps the part on re-record, so the file stays version 2", () => {
    const old = recorded(100, 0, 30);
    const now = {
      ...loaded(100, 0, 0),
      skillListing: { kind: "not-modelled" } as const,
    };
    const { entry } = carryUnmeasured(entryFor(weight(100), now), now, old);
    expect(entry.parts).toEqual(old.parts);
    expect(recordEntries(undefined, [[".", entry]]).version).toBe(2);
  });
});

describe("formatUnrecordedParts", () => {
  it("names each part, the command, and the cost of an older reader", () => {
    const text = formatUnrecordedParts(
      [
        { part: "output-style", total: 8616 },
        { part: "skill-listing", total: 31210 },
      ],
      "chars",
      ".",
    );
    expect(text).toContain(
      "output style (8,616 chars) and skill listing (31,210 chars) load at session start",
    );
    expect(text).toContain("vigiles lint --update-baseline");
    expect(text).toContain("an older release cannot read version 2");
  });
});
