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
import type { HarnessDialect } from "./dialect.js";
import { MOVE_OUT_OF_ALWAYS_LOADED } from "./instruction-remedies.js";
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
  it("flags a commands description that outgrew a pointer", async () => {
    const { warnings, errors } = await compile(
      spec({
        commands: { "npm run build": "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("entry-too-long");
    expect(warnings[0].message).toContain("npm run build");
    // A budget never blocks a compile — a faithful adoption of an oversized
    // file must still produce an artifact.
    expect(errors.filter((e) => e.type === "entry-too-long")).toHaveLength(0);
  });

  it("stays silent on a corpus of ordinary pointers", async () => {
    const { warnings } = await compile(
      spec({
        commands: {
          "npm test": "Run the tests.",
          "npm run build": "x".repeat(DEFAULT_MAX_ENTRY_CHARS),
        },
      }),
    );
    expect(warnings).toHaveLength(0);
  });

  it("does not budget keyFiles — deprecated, so a size budget would be a second instruction", async () => {
    // 500: over the entry budget, under the separate 800-character key-file
    // ERROR, which predates this rule and stays until keyFiles is removed.
    const { warnings, errors } = await compile(
      spec({ keyFiles: { "package.json": "y".repeat(500) } }),
    );
    expect(warnings.map((w) => w.type)).not.toContain("entry-too-long");
    expect(errors.map((e) => e.type)).not.toContain("entry-too-long");
  });

  it("can be disabled with 0", async () => {
    const { warnings } = await compileClaude(
      spec({ commands: { "npm test": "z".repeat(5000) } }),
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
    // The finding says where the text can go, not only that it is too long.
    expect(warnings[0]?.message).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
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
// At "error" (what vigiles:recommended sets, #350): the same budgets as ERRORS,
// plus the Rules total
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
 * WHY THE PRESET AND NOT A FLIPPED DEFAULT. Every budget above is a warning,
 * and on a 3.9x-over-budget file the only message was about one 314-character
 * entry: nothing could say "this is too big". `vigiles:recommended` sets
 * `compile-budget: "error"`, so a repo that extends it gets the gate on
 * upgrade (a major); a repo that lists its rules keeps byte-for-byte output.
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
        commands: { "npm test": "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) },
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
        commands: { "npm test": "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1) },
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
    expect(errors[0].message).toContain("(budget 2,000)");
    // Rendering shorter is one move; the rest are the carriers every
    // "too much always-loaded text" finding names.
    expect(errors[0].message).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });
});

describe("compile-budget does not measure the whole file", () => {
  it("leaves an over-budget file to instruction-weight, which sums the chain", async () => {
    // ~42,000 characters against a 40,000-character harness: no finding here.
    // One owner per number — `instruction-weight` and its `max` measure every
    // always-loaded file together, so moving text into a rules file does not
    // fool it, and this rule does not report the same overweight twice.
    const { errors } = await strict(bigSpec(), { dialect: countsChars });
    expect(budgetTypes(errors)).toEqual([]);
  });
});

describe("compile-budget at its default (warn) — unchanged", () => {
  it("does not evaluate the Rules total", async () => {
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

  it("evaluates a Rules total the repo configured explicitly, as a warning", async () => {
    const rules = {
      one: guidance("p".repeat(150)),
      two: guidance("r".repeat(150)),
    };
    const { warnings, errors } = await compileClaude(spec({ rules }), {
      specFile: "CLAUDE.md.spec.ts",
      catalogOnly: true,
      maxRulesChars: 200,
    });
    expect(warnings.map((w) => w.type)).toEqual(["rules-too-large"]);
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
