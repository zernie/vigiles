/**
 * Migrating the file earlier releases wrote: the recorded numbers carry over,
 * never the current size, except for the parts a version-1 file never recorded.
 */
import { describe, expect, it } from "vitest";

import type { Measurement } from "./baseline-store.js";
import { ALWAYS_LOADED_MEASURE } from "./always-loaded-limits.js";
import {
  PRE_RENAME_BASELINE_FILE,
  convertLegacyEntry,
  legacyBaselineFiles,
  parseLegacyBaseline,
} from "./legacy-baseline.js";

const current: Measurement = {
  unit: "chars",
  measure: ALWAYS_LOADED_MEASURE,
  parts: {
    instructions: { value: 500, files: { "ROOT.md": 500 } },
    "output-style": { value: 0 },
    "skill-listing": { value: 70, files: { "s/SKILL.md": 70 } },
  },
  value: 570,
};

const parsed = (file: unknown): ReturnType<typeof parseLegacyBaseline> =>
  parseLegacyBaseline(JSON.stringify(file));

const ok = (
  file: unknown,
): Extract<ReturnType<typeof parseLegacyBaseline>, { kind: "ok" }> => {
  const p = parsed(file);
  if (p.kind !== "ok") throw new Error(p.message);
  return p;
};

describe("legacyBaselineFiles", () => {
  it("names the rule's own file first, then the pre-rename one", () => {
    expect(legacyBaselineFiles("fixture-rule")).toEqual([
      ".vigiles/fixture-rule.json",
      PRE_RENAME_BASELINE_FILE,
    ]);
  });
});

describe("convertLegacyEntry", () => {
  it("version 2: keeps every recorded number; an absent part was zero", () => {
    const legacy = ok({
      version: 2,
      bundles: {
        ".": {
          unit: "chars",
          measure: 1,
          total: 400,
          files: { "ROOT.md": 400 },
          parts: {
            "skill-listing": {
              measure: 1,
              total: 60,
              files: { "s/SKILL.md": 60 },
            },
          },
        },
      },
    });
    expect(convertLegacyEntry(legacy, ".", current)).toEqual({
      direction: "shrink-only",
      unit: "chars",
      measure: ALWAYS_LOADED_MEASURE,
      value: 460,
      parts: {
        instructions: { value: 400, files: { "ROOT.md": 400 } },
        "skill-listing": { value: 60, files: { "s/SKILL.md": 60 } },
      },
    });
  });

  it("version 1: the instructions as recorded, the unrecorded parts at today's size", () => {
    const legacy = ok({
      version: 1,
      bundles: {
        ".": {
          unit: "chars",
          measure: 1,
          total: 400,
          files: { "ROOT.md": 400 },
        },
      },
    });
    expect(convertLegacyEntry(legacy, ".", current)?.value).toBe(470);
  });

  it("another measurement version becomes measure 0, which reads as re-record", () => {
    const legacy = ok({
      version: 1,
      bundles: {
        ".": { unit: "chars", measure: 9, total: 1, files: { "ROOT.md": 1 } },
      },
    });
    expect(convertLegacyEntry(legacy, ".", current)?.measure).toBe(0);
  });

  it("a bundle the old file never recorded has no entry", () => {
    expect(
      convertLegacyEntry(ok({ version: 1, bundles: {} }), ".", current),
    ).toBe(undefined);
  });
});

describe("parseLegacyBaseline", () => {
  it("refuses what it cannot convert", () => {
    expect(parseLegacyBaseline("{").kind).toBe("invalid");
    expect(parsed({ version: 3, bundles: {} }).kind).toBe("invalid");
  });
});
