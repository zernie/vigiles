/**
 * Instruction-weight suite (vitest, unit tier, nothing spawned).
 *
 * The load-bearing test is THE EVASION one: moving text out of the instruction
 * file into a sibling the harness also loads must not change the number. That
 * is not a hypothetical — it is what the measurement that produced this module
 * found, and a per-file check would have scored it as a 35% improvement.
 */
import { describe, it, expect } from "vitest";
import { weighInstructions, sizeIn } from "./instruction-weight.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { codexDialect } from "../adapters/codex/dialect.js";

const cc = claudeCodeDialect.instructionBudget;
const codex = codexDialect.instructionBudget;
if (!cc || !codex) throw new Error("fixture precondition: both budgets exist");

describe("the SUM is what is measured, not the file", () => {
  it("relocating text into .claude/rules/ does not change the total", () => {
    const body = "x".repeat(30000);
    const before = weighInstructions({ "CLAUDE.md": body }, cc);
    const after = weighInstructions(
      {
        "CLAUDE.md": body.slice(0, 10000),
        ".claude/rules/engineering.md": body.slice(10000, 20000),
        ".claude/rules/ci-and-git.md": body.slice(20000),
      },
      cc,
    );
    expect(after.total).toBe(before.total);
    // …and the file-level view DID change, which is exactly the illusion: a
    // per-file rule would report the biggest file shrinking by two thirds.
    expect(after.files[0]?.size).toBeLessThan(before.files[0]?.size ?? 0);
  });

  it("names where the weight is, heaviest first", () => {
    const w = weighInstructions(
      { "CLAUDE.md": "a".repeat(10), ".claude/rules/big.md": "b".repeat(99) },
      cc,
    );
    expect(w.files.map((f) => f.path)).toEqual([
      ".claude/rules/big.md",
      "CLAUDE.md",
    ]);
  });

  it("ignores a file the harness does NOT load unasked", () => {
    // A doc reachable only by an explicit read costs nothing until it is read —
    // counting it would make the number meaningless and the advice wrong.
    const w = weighInstructions(
      { "CLAUDE.md": "a".repeat(10), "docs/guide.md": "b".repeat(99999) },
      cc,
    );
    expect(w.total).toBe(10);
  });
});

describe("the unit is the harness's own", () => {
  it("chars and bytes diverge on non-ASCII — the reason a shared number would lie", () => {
    const cyrillic = "правило";
    expect(sizeIn(cyrillic, "chars")).toBe(7);
    expect(sizeIn(cyrillic, "bytes")).toBe(14);
  });

  it("Claude Code counts chars and WARNS; Codex counts bytes and TRUNCATES", () => {
    // The asymmetry the report exists to carry: over budget on one costs money,
    // on the other it means rules silently do not reach the model.
    expect([cc.unit, cc.onExceed]).toEqual(["chars", "warns"]);
    expect([codex.unit, codex.onExceed]).toEqual(["bytes", "truncates"]);
  });

  it("a nested AGENTS.md pays into the same Codex budget", () => {
    const w = weighInstructions(
      { "AGENTS.md": "a".repeat(100), "pkg/sub/AGENTS.md": "b".repeat(50) },
      codex,
    );
    expect(w.total).toBe(150);
  });
});

describe("over / under budget", () => {
  it("reports null when within budget, never a negative", () => {
    expect(weighInstructions({ "CLAUDE.md": "a".repeat(100) }, cc).overBy).toBe(
      null,
    );
  });

  it("reports how far over, in the harness's unit", () => {
    const w = weighInstructions({ "CLAUDE.md": "a".repeat(40100) }, cc);
    expect(w.overBy).toBe(100);
  });

  it("an empty repo weighs nothing and is not 'over'", () => {
    const w = weighInstructions({}, cc);
    expect([w.total, w.overBy]).toEqual([0, null]);
  });
});
