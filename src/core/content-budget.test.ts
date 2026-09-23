/**
 * Content-budget suite — the per-ENTRY and per-SECTION character budgets.
 *
 * Both halves matter and neither is worth anything alone: the check must fire
 * on an entry that outgrew a pointer, and stay silent on a corpus of normal
 * ones. A budget that flags everything is switched off the day it lands, which
 * is why these are WARNINGS and why the quiet half is asserted at all.
 *
 * The section half exists because the LINE guard measured useless on the shape
 * that bites: this repo's own `Positioning` was 24 lines and 20 416 characters,
 * passing a 200-line gate with two orders of magnitude to spare.
 */
import { describe, it, expect } from "vitest";

import { compileClaude, DEFAULT_MAX_ENTRY_CHARS } from "./compile.js";

const spec = (
  extra: Partial<Parameters<typeof compileClaude>[0]>,
): Parameters<typeof compileClaude>[0] =>
  ({
    _specType: "claude",
    rules: {},
    ...extra,
  }) as Parameters<typeof compileClaude>[0];

const compile = async (s: Parameters<typeof compileClaude>[0]) =>
  await compileClaude(s, { specFile: "CLAUDE.md.spec.ts", catalogOnly: true });

describe("per-entry budget", () => {
  it("flags a keyFiles description that outgrew a pointer", async () => {
    const { warnings, errors } = await compile(
      spec({
        keyFiles: { "package.json": "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("entry-too-long");
    expect(warnings[0].message).toContain("package.json");
    // A budget never blocks a compile — a faithful adoption of an oversized
    // file must still produce an artifact.
    expect(errors.filter((e) => e.type === "entry-too-long")).toHaveLength(0);
  });

  it("stays silent on a corpus of ordinary pointers", async () => {
    const { warnings } = await compile(
      spec({
        keyFiles: {
          "package.json": "The manifest.",
          "README.md": "x".repeat(DEFAULT_MAX_ENTRY_CHARS),
        },
      }),
    );
    expect(warnings).toHaveLength(0);
  });

  it("holds commands to the same budget", async () => {
    const { warnings } = await compile(
      spec({ commands: { build: "y".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) } }),
    );
    expect(warnings.map((w) => w.type)).toEqual(["entry-too-long"]);
  });

  it("can be disabled with 0", async () => {
    const { warnings } = await compileClaude(
      spec({ keyFiles: { "package.json": "z".repeat(5000) } }),
      { specFile: "CLAUDE.md.spec.ts", catalogOnly: true, maxEntryChars: 0 },
    );
    expect(warnings).toHaveLength(0);
  });
});

describe("per-section character budget", () => {
  it("flags a section the LINE guard cannot see — few lines, many characters", async () => {
    const { warnings, errors } = await compileClaude(
      spec({ sections: { Positioning: "a".repeat(600) } }),
      {
        specFile: "CLAUDE.md.spec.ts",
        catalogOnly: true,
        maxSectionChars: 500,
      },
    );
    expect(warnings.map((w) => w.type)).toEqual(["section-too-large"]);
    // The point of the char budget: this same section passes the line guard.
    expect(errors.filter((e) => e.type === "section-too-long")).toHaveLength(0);
  });

  it("stays silent on a section within budget", async () => {
    const { warnings } = await compileClaude(
      spec({ sections: { Positioning: "a".repeat(400) } }),
      {
        specFile: "CLAUDE.md.spec.ts",
        catalogOnly: true,
        maxSectionChars: 500,
      },
    );
    expect(warnings).toHaveLength(0);
  });
});
