/**
 * Every finding that says "too much always-loaded text" names where the text
 * can go. An error that only says "cut content" leaves one move — delete — and
 * the reader deletes rules that still matter instead of moving them to a
 * carrier that loads them only when they apply.
 */
import { describe, it, expect } from "vitest";

import { compileClaude } from "./compile.js";
import {
  checkCeiling,
  formatCeiling,
  formatRefusal,
  formatVerdict,
} from "./instruction-baseline.js";
import { weighInstructions } from "./instruction-weight.js";
import { MOVE_OUT_OF_ALWAYS_LOADED } from "./instruction-remedies.js";
import { claudeCodeLayout } from "../adapters/claude-code/layout.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";

const cc = claudeCodeDialect.instructionBudget;
if (!cc) throw new Error("fixture precondition: the Claude Code budget exists");

const weighCc = (files: Record<string, string>) =>
  weighInstructions(claudeCodeLayout.instructionChain(files), files, cc);

const over = checkCeiling(
  weighCc({ "CLAUDE.md": "r".repeat(30_000), "a.md": "a".repeat(8_000) }),
  20_000,
);
if (!over) throw new Error("fixture precondition: over the ceiling");

describe("the remedy list", () => {
  it("names each carrier an always-loaded rule can move to", () => {
    expect(MOVE_OUT_OF_ALWAYS_LOADED.split("\n")).toEqual([
      "Move what does not apply to every request:",
      "  - a rule for one folder → that folder's nested CLAUDE.md or AGENTS.md (loads only there)",
      "  - a step tied to one action → a hook",
      "  - a procedure for one kind of task → a skill",
      "  - a fact a machine can check → a lint rule or a test, then delete the prose",
      "  - measurements and history → docs, linked, not loaded",
      "  - text another file already says → delete it",
    ]);
  });
});

describe("every over-weight finding carries it", () => {
  it("the ceiling finding", () => {
    expect(formatCeiling(over, ".")).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("the refusal to record a baseline above the ceiling", () => {
    expect(formatRefusal(over, ".")).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("growth over the recorded baseline", () => {
    const msg = formatVerdict(
      { kind: "grew", from: 10, to: 20, unit: "chars", changes: [] },
      ".",
    );
    expect(msg).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("a section over its character budget", async () => {
    const { warnings } = await compileClaude(
      {
        _specType: "claude",
        rules: {},
        sections: { Positioning: "a".repeat(600) },
      } as Parameters<typeof compileClaude>[0],
      {
        specFile: "CLAUDE.md.spec.ts",
        catalogOnly: true,
        maxSectionChars: 500,
      },
    );
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining(MOVE_OUT_OF_ALWAYS_LOADED),
    ]);
  });
});
