/**
 * Instruction-weight suite (vitest, unit tier, nothing spawned).
 *
 * The load-bearing test is still THE EVASION one: moving text out of the
 * instruction file into a sibling the harness also loads must not change the
 * number. That is not a hypothetical — it is what the measurement that produced
 * this module found, and a per-file check would have scored it as a 35%
 * improvement.
 *
 * What is NEW here is the second half of the same idea. The old suite weighed a
 * file map through a glob list, so it could only ask "is this path matched?".
 * The weight now takes a CHAIN, so it can ask the two questions a glob could not
 * answer and got wrong in production: does a file the harness loads ON DEMAND
 * stay out of the sum, and does a PER-MACHINE file stay out of the SCORED sum
 * while still being visible.
 */
import { describe, it, expect } from "vitest";
import { weighInstructions, sizeIn } from "./instruction-weight.js";
import type { InstructionBudget } from "./instruction-weight.js";
import type { InstructionChain } from "./instruction-chain.js";
import { claudeCodeLayout } from "../adapters/claude-code/layout.js";
import { codexLayout } from "../adapters/codex/layout.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { codexDialect } from "../adapters/codex/dialect.js";

const cc = claudeCodeDialect.instructionBudget;
const codex = codexDialect.instructionBudget;
if (!cc || !codex) throw new Error("fixture precondition: both budgets exist");

/** Weigh a map the way the engines do: the harness classifies, the sum follows. */
function weighThrough(
  layout: {
    instructionChain: (f: Readonly<Record<string, string>>) => InstructionChain;
  },
  files: Record<string, string>,
  budget: InstructionBudget,
): ReturnType<typeof weighInstructions> {
  return weighInstructions(layout.instructionChain(files), files, budget);
}

describe("the SUM is what is measured, not the file", () => {
  it("relocating text into the rules dir does not change the total", () => {
    const body = "x".repeat(30000);
    const before = weighThrough(claudeCodeLayout, { "CLAUDE.md": body }, cc);
    const after = weighThrough(
      claudeCodeLayout,
      {
        "CLAUDE.md": body.slice(0, 10000),
        ".claude/rules/engineering.md": body.slice(10000, 20000),
        ".claude/rules/ci-and-git.md": body.slice(20000),
      },
      cc,
    );
    expect(after.committedTotal).toBe(before.committedTotal);
    // …and the file-level view DID change, which is exactly the illusion: a
    // per-file rule would report the biggest file shrinking by two thirds.
    expect(after.files[0]?.size).toBeLessThan(before.files[0]?.size ?? 0);
  });

  it("names where the weight is, heaviest first", () => {
    const w = weighThrough(
      claudeCodeLayout,
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
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "a".repeat(10), "docs/guide.md": "b".repeat(99999) },
      cc,
    );
    expect(w.committedTotal).toBe(10);
  });

  it("a rule in a SUBDIRECTORY of the rules dir counts — the dir is read recursively", () => {
    // The flat `[^/]+\.md` this replaced meant a nested rule was read by the
    // loader and classified by nothing: never frontmatter-checked, never
    // counted, never weighed (#262 §3).
    const w = weighThrough(
      claudeCodeLayout,
      {
        "CLAUDE.md": "a".repeat(10),
        ".claude/rules/team/x.md": "b".repeat(20),
      },
      cc,
    );
    expect(w.committedTotal).toBe(30);
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
});

describe("what the glob list got WRONG, and the chain gets right", () => {
  it("a nested AGENTS.md does NOT pay into the Codex budget at a root session", () => {
    // 🔴 THIS ASSERTION IS REVERSED FROM THE ONE IT REPLACED, which read "a
    // nested AGENTS.md pays into the same Codex budget" and so encoded the
    // over-report as if it were the contract. Vendor (zernie/vigiles#262): the
    // walk goes root→cwd taking at most ONE file per directory, so at the root
    // it is one file. A monorepo with twelve package-level files was told it was
    // 12x over a budget no session ever approaches.
    const files = {
      "AGENTS.md": "a".repeat(100),
      "pkg/sub/AGENTS.md": "b".repeat(50),
    };
    const w = weighThrough(codexLayout, files, codex);
    expect(w.committedTotal).toBe(100);
    expect(w.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
    // …and the file is not merely dropped: the chain says WHY, which is what
    // makes the difference reviewable instead of invisible.
    expect(codexLayout.instructionChain(files).unloaded).toEqual([
      {
        path: "pkg/sub/AGENTS.md",
        role: "root",
        scope: "repo",
        reason: { kind: "on-demand", when: "subdirectory" },
      },
    ]);
  });

  it("a path-scoped rule is shown as on-demand and left OUT of the sum", () => {
    const files = {
      "CLAUDE.md": "a".repeat(10),
      ".claude/rules/always.md": "b".repeat(20),
      ".claude/rules/scoped.md": `---\npaths: ["src/**"]\n---\n${"c".repeat(9999)}`,
    };
    const w = weighThrough(claudeCodeLayout, files, cc);
    expect(w.committedTotal).toBe(30);
    expect(
      claudeCodeLayout
        .instructionChain(files)
        .unloaded.map((e) => [e.path, e.reason]),
    ).toEqual([
      [".claude/rules/scoped.md", { kind: "on-demand", when: "path-scoped" }],
    ]);
  });

  it("a per-machine file is SHOWN but not SCORED — two totals, one budget", () => {
    // The reproducibility rule, as a number: a teammate on the same commit
    // computes `committedTotal`; this working copy also pays `effectiveTotal`.
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "a".repeat(100), "CLAUDE.local.md": "b".repeat(7) },
      cc,
    );
    expect([w.committedTotal, w.effectiveTotal]).toEqual([100, 107]);
    expect(w.files.map((f) => [f.path, f.scope])).toEqual([
      ["CLAUDE.md", "repo"],
      ["CLAUDE.local.md", "local"],
    ]);
  });

  it("the budget verdict is taken on the COMMITTED total, never the effective one", () => {
    // A gitignored file must not be able to push a published grade over — that
    // is what makes the grade reproducible from a commit alone, and what keeps
    // the CLI and the browser twin (which can never see one) in agreement.
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "a".repeat(39999), "CLAUDE.local.md": "b".repeat(5000) },
      cc,
    );
    expect(w.overBy).toBe(null);
    expect(w.effectiveTotal).toBeGreaterThan(cc.limit);
  });
});

describe("what could NOT be weighed is printed, not dropped", () => {
  it("an import the run never read is named", () => {
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "see @docs/style.md for prose" },
      cc,
    );
    expect(w.unreadImports).toEqual(["docs/style.md"]);
  });

  it("an import that WAS read is weighed like any other loaded file", () => {
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "@docs/style.md", "docs/style.md": "z".repeat(40) },
      cc,
    );
    expect(w.committedTotal).toBe("@docs/style.md".length + 40);
    expect(w.unreadImports).toEqual([]);
  });
});

describe("an imported file carries its PROVENANCE into the report", () => {
  it("says who named it and with what text", () => {
    // `AGENTS.md` inside a CLAUDE CODE weight reads as a bug — Claude Code does
    // not auto-load it — until the line says `via @AGENTS.md in CLAUDE.md`. The
    // user wrote that line; it is the thing they can act on.
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "@AGENTS.md", "AGENTS.md": "z".repeat(40) },
      cc,
    );
    expect(w.files.map((f) => [f.path, f.via])).toEqual([
      ["AGENTS.md", { from: "CLAUDE.md", token: "@AGENTS.md" }],
      ["CLAUDE.md", undefined],
    ]);
  });

  it("a file that got in by LOCATION carries no provenance", () => {
    // The other half: if every entry had a `via` the field would say nothing.
    const w = weighThrough(claudeCodeLayout, { "CLAUDE.md": "body" }, cc);
    expect(w.files[0]?.via).toBe(undefined);
  });
});

describe("a pure-redirect instruction file is a FINDING, not a size", () => {
  it("is reported, with what it points at", () => {
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "z".repeat(40000) },
      cc,
    );
    expect(w.redirects).toEqual([{ path: "CLAUDE.md", to: ["AGENTS.md"] }]);
    // …and the number is no longer the fourteen bytes of the pointer.
    expect(w.committedTotal).toBeGreaterThan(40000);
  });

  it("an ordinary instruction file is NOT reported as one", () => {
    expect(
      weighThrough(claudeCodeLayout, { "CLAUDE.md": "real rules" }, cc)
        .redirects,
    ).toEqual([]);
  });
});

describe("over / under budget", () => {
  it("reports null when within budget, never a negative", () => {
    expect(
      weighThrough(claudeCodeLayout, { "CLAUDE.md": "a".repeat(100) }, cc)
        .overBy,
    ).toBe(null);
  });

  it("reports how far over, in the harness's unit", () => {
    const w = weighThrough(
      claudeCodeLayout,
      { "CLAUDE.md": "a".repeat(40100) },
      cc,
    );
    expect(w.overBy).toBe(100);
  });

  it("an empty repo weighs nothing and is not 'over'", () => {
    const w = weighThrough(claudeCodeLayout, {}, cc);
    expect([w.committedTotal, w.effectiveTotal, w.overBy]).toEqual([
      0,
      0,
      null,
    ]);
  });
});
