/**
 * The detector: each limited part against its limit, where each limit comes
 * from, and what the store is handed. Harness-agnostic — fixture weights and
 * contexts; the adapters' real numbers are in their own tests.
 */
import { describe, expect, it } from "vitest";

import type { AlwaysLoadedContext, LoadedPart } from "./always-loaded.js";
import {
  ALWAYS_LOADED_MEASURE,
  CONSEQUENCE,
  alwaysLoadedMeasurement,
  checkAlwaysLoadedLimits,
  checkCeiling,
  formatOverLimit,
} from "./always-loaded-limits.js";
import type { InstructionWeight } from "./instruction-weight.js";

const weight = (
  total: number,
  limit = 100,
  onExceed: InstructionWeight["onExceed"] = "warns",
): InstructionWeight => ({
  unit: "chars",
  limit,
  onExceed,
  files: [
    { path: "ROOT.md", size: total, role: "root", scope: "repo" },
    { path: "LOCAL.md", size: 7, role: "root", scope: "local" },
  ],
  committedTotal: total,
  effectiveTotal: total + 7,
  overBy: total > limit ? total - limit : null,
  unreadImports: [],
  unweighedPatterns: [],
  redirects: [],
});

const counted = (path: string, size: number): LoadedPart => ({
  kind: "counted",
  total: size,
  files: [{ path, size }],
});

const loaded = (
  instructions: number,
  style: LoadedPart,
  listing: LoadedPart,
  listingLimit: AlwaysLoadedContext["skillListingLimit"] = {
    kind: "limit",
    limit: 50,
  },
): AlwaysLoadedContext => ({
  unit: "chars",
  instructions,
  outputStyle: style,
  skillListing: listing,
  total:
    instructions +
    (style.kind === "counted" ? style.total : 0) +
    (listing.kind === "counted" ? listing.total : 0),
  skillListingLimit: listingLimit,
});

describe("checkAlwaysLoadedLimits", () => {
  it("under every limit: both parts listed, nothing over", () => {
    const c = checkAlwaysLoadedLimits(
      weight(40),
      loaded(40, { kind: "none" }, counted("s/SKILL.md", 10)),
    );
    expect(c.parts.map((p) => [p.part, p.size, p.limit])).toEqual([
      ["instructions", 40, 100],
      ["skill-listing", 10, 50],
    ]);
    expect(c.over).toEqual([]);
  });

  it("the selected output style counts with the instructions", () => {
    const c = checkAlwaysLoadedLimits(
      weight(90),
      loaded(90, counted("style.md", 20), { kind: "none" }),
    );
    expect(c.over.map((p) => [p.part, p.size])).toEqual([
      ["instructions", 110],
    ]);
  });

  it("at the limit is not over", () => {
    const c = checkAlwaysLoadedLimits(
      weight(100),
      loaded(100, { kind: "none" }, counted("s", 50)),
    );
    expect(c.over).toEqual([]);
  });

  it("a listing the adapter does not model, or with no modelled budget, has no limit", () => {
    expect(
      checkAlwaysLoadedLimits(
        weight(1),
        loaded(1, { kind: "none" }, { kind: "not-modelled" }),
      ).parts.map((p) => p.part),
    ).toEqual(["instructions"]);
    expect(
      checkAlwaysLoadedLimits(
        weight(1),
        loaded(1, { kind: "none" }, counted("s", 999), {
          kind: "not-modelled",
        }),
      ).over,
    ).toEqual([]);
  });
});

describe("where a limit comes from", () => {
  it("an override replaces a limit, even one the harness does not model", () => {
    const c = checkAlwaysLoadedLimits(
      weight(40),
      loaded(40, { kind: "none" }, counted("s", 30), { kind: "not-modelled" }),
      { instructions: 30, "skill-listing": 20 },
    );
    expect(c.over.map((p) => [p.part, p.limit, p.source.kind])).toEqual([
      ["instructions", 30, "config"],
      ["skill-listing", 20, "config"],
    ]);
  });

  it("a committed setting is named as the source", () => {
    const c = checkAlwaysLoadedLimits(
      weight(1),
      loaded(1, { kind: "none" }, counted("s", 30), {
        kind: "limit",
        limit: 20,
        setBy: "listingSetting",
      }),
    );
    expect(formatOverLimit(c, "pkg")).toContain(
      "pkg: always-loaded context is over the harness's limit: skill listing 30 chars, limit 20 (set by `listingSetting` in the committed settings)",
    );
  });

  it("each part's consequence is said as a behaviour", () => {
    const c = checkAlwaysLoadedLimits(
      weight(200, 100, "truncates"),
      loaded(200, { kind: "none" }, counted("s", 60)),
    );
    const text = formatOverLimit(c, ".");
    expect(text).toContain(CONSEQUENCE.truncates);
    expect(text).toContain(CONSEQUENCE["drops-descriptions"]);
  });
});

describe("alwaysLoadedMeasurement — what the store is handed", () => {
  it("the scored files only, each part, and a part it cannot measure as null", () => {
    const m = alwaysLoadedMeasurement(
      weight(40),
      loaded(40, { kind: "unresolved", name: "X" }, counted("s", 10)),
    );
    expect(m).toEqual({
      unit: "chars",
      measure: ALWAYS_LOADED_MEASURE,
      parts: {
        instructions: { value: 40, files: { "ROOT.md": 40 } },
        "output-style": { value: null },
        "skill-listing": { value: 10, files: { s: 10 } },
      },
      value: 50,
    });
  });

  it("a part that loads nothing is a real zero", () => {
    const m = alwaysLoadedMeasurement(
      weight(1),
      loaded(1, { kind: "none" }, { kind: "not-supported" }),
    );
    expect(m.parts?.["output-style"]).toEqual({ value: 0 });
    expect(m.parts?.["skill-listing"]).toEqual({ value: null });
  });
});

describe("checkCeiling — the max no baseline lifts", () => {
  it("is decided on the scored instructions alone", () => {
    expect(checkCeiling(weight(50), undefined)).toBe(undefined);
    expect(checkCeiling(weight(50), 50)).toBe(undefined);
    expect(checkCeiling(weight(51), 50)).toEqual({
      total: 51,
      max: 50,
      unit: "chars",
      largest: [{ path: "ROOT.md", size: 51 }],
    });
  });
});
