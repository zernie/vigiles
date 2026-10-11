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

import {
  compileClaude,
  DEFAULT_MAX_ENTRY_CHARS,
  DEFAULT_MAX_KEY_FILES_CHARS,
} from "./compile.js";
import type { HarnessDialect } from "./dialect.js";
import type { InstructionBudget } from "./instruction-weight.js";
import { guidance } from "./spec.js";

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

// ---------------------------------------------------------------------------
// The strict tier (#350): the same budgets as ERRORS, plus the aggregates
// ---------------------------------------------------------------------------

/**
 * A harness reduced to what the budget reads: its instruction budget. The two
 * real shapes, without naming a harness (core code is harness-agnostic): one
 * that counts characters and warns, one that counts bytes and truncates.
 */
const harness = (budget: Omit<InstructionBudget, "capturedFrom">) =>
  ({
    name: `test-${budget.unit}`,
    builtinAgentTools: [],
    neverAvailableTools: [],
    mcpToolPattern: /^mcp__/,
    hookEvents: [],
    instructionTargets: ["CLAUDE.md"],
    pluginRootToken: "${PLUGIN_ROOT}",
    skillFrontmatterKeys: ["name", "description"],
    instructionBudget: { ...budget, capturedFrom: "test fixture" },
  }) satisfies HarnessDialect;

const countsChars = harness({ unit: "chars", limit: 40000, onExceed: "warns" });
const countsBytes = harness({
  unit: "bytes",
  limit: 32768,
  onExceed: "truncates",
});

/** ~42,000 characters of plain sections: over a 40,000-character budget. */
const bigSpec = () =>
  spec({
    sections: {
      A: "a".repeat(14000),
      B: "b".repeat(14000),
      C: "c".repeat(14000),
    },
  });

/**
 * WHY A SEPARATE TIER AND NOT A FLIPPED DEFAULT. Every budget above is a
 * warning, and on a 3.9x-over-budget file the only message was about one
 * 314-character entry: nothing could say "this is too big". The fix is a
 * severity the repo CHOOSES (`compile-budget: "error"`, which the
 * `vigiles:strict` preset sets), so an adopting repo is not failed on day one
 * and the default output is byte-for-byte what it was.
 */
const strict = async (
  s: Parameters<typeof compileClaude>[0],
  extra: Parameters<typeof compileClaude>[1] = {},
) =>
  await compileClaude(s, {
    specFile: "CLAUDE.md.spec.ts",
    catalogOnly: true,
    budgetSeverity: "error",
    ...extra,
  });

/** Budget findings only: a key file that does not exist is another finding. */
const budgetTypes = (errors: readonly { type: string }[]) =>
  errors.filter((e) => e.type !== "stale-file").map((e) => e.type);

describe("compile-budget at error: the old budgets become errors", () => {
  it("turns an over-long entry into an error, not a warning", async () => {
    const { warnings, errors } = await strict(
      spec({
        keyFiles: { "package.json": "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) },
      }),
    );
    expect(warnings).toHaveLength(0);
    expect(budgetTypes(errors)).toEqual(["entry-too-long"]);
  });

  it("turns an over-large section into an error", async () => {
    const { errors } = await strict(
      spec({ sections: { Positioning: "a".repeat(600) } }),
      { maxSectionChars: 500 },
    );
    expect(errors.map((e) => e.type)).toEqual(["section-too-large"]);
  });

  it("budget errors are marked as budget findings, so lint can name the right rule", async () => {
    const { errors, budgetFindings } = await strict(
      spec({
        keyFiles: { "package.json": "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) },
      }),
    );
    expect(budgetFindings).toHaveLength(1);
    expect(errors).toContain(budgetFindings[0]);
  });

  it("stays silent on a small, ordinary spec — the quiet half", async () => {
    const { errors, warnings } = await strict(
      spec({
        sections: { Overview: "A short overview." },
        rules: { one: guidance("Short."), two: guidance("Also short.") },
      }),
      { dialect: countsChars },
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("compile-budget at error: the sums", () => {
  it("budgets the Rules section as a whole — the place the weight is", async () => {
    const rules = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `rule-${String(i)}`,
        guidance("y".repeat(150)),
      ]),
    );
    const { errors } = await strict(spec({ rules }), { maxRulesChars: 2000 });
    expect(errors.map((e) => e.type)).toEqual(["rules-too-large"]);
    expect(errors[0].message).toContain("30 rules");
  });

  it("budgets the Key Files sum when every entry is under its own budget — clipping rows does not meet it", async () => {
    // Each row is a legal 190-character pointer; only the SUM is over.
    const rows = Math.ceil(DEFAULT_MAX_KEY_FILES_CHARS / 190) + 1;
    const keyFiles = Object.fromEntries(
      Array.from({ length: rows }, (_, i) => [
        `f${String(i)}.md`,
        "k".repeat(190),
      ]),
    );
    const { errors } = await strict(spec({ keyFiles }));
    expect(budgetTypes(errors)).toEqual(["key-files-too-large"]);
  });

  it("takes a configured Key Files threshold", async () => {
    const keyFiles = {
      "package.json": "p".repeat(150),
      "README.md": "r".repeat(150),
    };
    const { errors } = await strict(spec({ keyFiles }), {
      maxKeyFilesChars: 200,
    });
    expect(budgetTypes(errors)).toEqual(["key-files-too-large"]);
  });
});

describe("compile-budget at error: the whole file, in the harness's unit", () => {
  it("compares the output with the budget of a harness that counts characters", async () => {
    const { errors } = await strict(bigSpec(), { dialect: countsChars });
    const over = errors.filter((e) => e.type === "output-too-large");
    expect(over).toHaveLength(1);
    expect(over[0].message).toContain("40,000 chars");
  });

  it("compares in bytes for a harness that counts bytes", async () => {
    // 17,000 two-byte characters: 17,000 chars, 34,000 bytes — under a char
    // budget of 32,768, over the byte budget the harness truncates at.
    const { errors } = await strict(
      spec({ sections: { A: "é".repeat(17000) } }),
      { dialect: countsBytes, maxSectionChars: 0 },
    );
    const over = errors.filter((e) => e.type === "output-too-large");
    expect(over).toHaveLength(1);
    expect(over[0].message).toContain("32,768 bytes");
    expect(over[0].message).toContain("TRUNCATES");
  });

  it("a token maxTokens neither replaces nor lifts the char ceiling", async () => {
    // The harness counts characters; a ceiling in estimated tokens is a
    // different number (offline estimates undercount the real tokenizer).
    const { errors } = await strict(bigSpec(), {
      dialect: countsChars,
      maxTokens: 50000,
    });
    expect(errors.map((e) => e.type)).toEqual(["output-too-large"]);
  });

  it("maxOutput moves the ceiling, in the harness's unit", async () => {
    const raised = await strict(bigSpec(), {
      dialect: countsChars,
      maxOutput: 60000,
    });
    expect(raised.errors).toHaveLength(0);
    const off = await strict(bigSpec(), { dialect: countsChars, maxOutput: 0 });
    expect(off.errors).toHaveLength(0);
  });
});

describe("compile-budget at its default (warn) — unchanged", () => {
  it("does not evaluate the new aggregates or the harness budget", async () => {
    // 150 rules (~25 kB of Rules) and ~42 kB of output: over every strict
    // default, and still exactly today's result.
    const rules = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `rule-${String(i)}`,
        guidance("y".repeat(150)),
      ]),
    );
    const { errors, warnings } = await compileClaude(
      { ...bigSpec(), rules },
      {
        specFile: "CLAUDE.md.spec.ts",
        catalogOnly: true,
        dialect: countsChars,
      },
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("evaluates an aggregate the repo configured explicitly, as a warning", async () => {
    const keyFiles = {
      "package.json": "p".repeat(150),
      "README.md": "r".repeat(150),
    };
    const { warnings, errors } = await compileClaude(spec({ keyFiles }), {
      specFile: "CLAUDE.md.spec.ts",
      catalogOnly: true,
      maxKeyFilesChars: 200,
    });
    expect(warnings.map((w) => w.type)).toEqual(["key-files-too-large"]);
    expect(budgetTypes(errors)).toEqual([]);
  });

  it("is silenced entirely when the rule is off", async () => {
    const { warnings, errors } = await compileClaude(
      // 500: over the 200 budget, under the separate 800-character key-file
      // ERROR, which is not a budget and stays on.
      spec({ keyFiles: { "package.json": "z".repeat(500) } }),
      {
        specFile: "CLAUDE.md.spec.ts",
        catalogOnly: true,
        budgetSeverity: false,
      },
    );
    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
