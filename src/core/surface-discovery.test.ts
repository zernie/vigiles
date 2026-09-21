/**
 * Tests for the PURE half of surface discovery (`src/core/surface-discovery.ts`):
 * the bounded-root shape rule, and what a layout claims.
 *
 * Every case carries BOTH halves on the same input — the shape that must be
 * found AND the near-miss beside it that must not be — because a discovery rule
 * that stopped discovering and a fixture that never had the file look identical
 * from the quiet side. Model-free, IO-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { claudeCodeLayout } from "../adapters/claude-code/layout.js";
import { codexLayout } from "../adapters/codex/layout.js";
import {
  declaredRootClaims,
  discoverSurfaces,
  layoutClaims,
  unclaimedSurfaceFindings,
} from "./surface-discovery.js";

const ccClaims = (p: string): boolean => layoutClaims(claudeCodeLayout, p);
const codexClaims = (p: string): boolean => layoutClaims(codexLayout, p);
const both = [claudeCodeLayout, codexLayout];

/**
 * The BOUND: a surface dir sits directly under the repo root or under a
 * DEPTH-1 DOT-DIRECTORY, and nowhere else.
 *
 * The negative half is the reason the bound exists at all, in the reporter's own
 * words (#240): an unbounded `**\/SKILL.md` in that repo finds 53 VENDORED
 * third-party plugin skills beside the 37 real ones and grades them as one
 * machine. `src/skills/…` and `packages/x/skills/…` are that class.
 */
test("discovery finds a surface under the root or a dot-dir, and nowhere else", () => {
  const found = discoverSurfaces([
    ".ai/skills/check-dor/SKILL.md", // dot-dir root      → found
    "skills/alpha/SKILL.md", // repo root         → found
    ".claude/agents/reviewer.md", // dot-dir root      → found
    ".cursor/commands/ship.md", // dot-dir root      → found
    "src/skills/nope/SKILL.md", // NOT a root        → not found
    "packages/x/skills/nope/SKILL.md", // NOT a root        → not found
    "docs/agents/note.md", // NOT a root        → not found
    ".ai/skills/check-dor/README.md", // not a loadable    → not found
  ]);
  assert.deepEqual(
    found.map((f) => `${f.kind}:${f.path}`),
    [
      "skill:.ai/skills/check-dor/SKILL.md",
      "skill:skills/alpha/SKILL.md",
      "agent:.claude/agents/reviewer.md",
      "command:.cursor/commands/ship.md",
    ],
  );
});

/**
 * #240, reduced: skills in a directory no shipped harness reads become a
 * FINDING, while the identical skills one directory over stay silent.
 *
 * The silent half is on the SAME call, so "the rule stopped firing" cannot pass
 * as "the repo was clean".
 */
test("a surface no registered harness claims is a finding; a claimed one is not", () => {
  const findings = unclaimedSurfaceFindings(
    [
      ".ai/skills/check-dor/SKILL.md",
      ".ai/skills/decompose/SKILL.md",
      ".claude/skills/alpha/SKILL.md", // claimed by claude-code
      ".agents/skills/beta/SKILL.md", // claimed by codex
      "skills/gamma/SKILL.md", // claimed by claude-code
    ],
    both,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].dir, ".ai/skills");
  assert.equal(findings[0].count, 2);
  assert.equal(findings[0].kind, "skill");
  assert.match(findings[0].message, /vigiles audit \.ai/);
});

/**
 * "Unclaimed" means NO REGISTERED harness reads it — not "the detected one
 * doesn't". Drop codex from the claimers and `.agents/skills` becomes a finding;
 * that is the same call with one claimer removed, so the difference is the rule
 * and not the fixture.
 */
test("claims are read across every registered harness, not just the detected one", () => {
  const paths = [".agents/skills/beta/SKILL.md"];
  assert.deepEqual(unclaimedSurfaceFindings(paths, both), []);
  assert.deepEqual(
    unclaimedSurfaceFindings(paths, [claudeCodeLayout]).map((f) => f.dir),
    [".agents/skills"],
  );
});

/**
 * 🔴 THE TRAP THAT WOULD SWITCH THE WHOLE MECHANISM OFF SILENTLY.
 * `codexLayout.materializeRoot` is `""`. If a `""` prefix ever matched every
 * path, Codex would claim the entire repository, no surface anywhere could be
 * unclaimed, and the report would be green in a way indistinguishable from a
 * working one.
 *
 * ⚠️ TWO guards stand between here and that, and the test pins the pair because
 * MEASUREMENT showed removing either ALONE is survivable: with `located()`
 * deleted, `dirs` really does contain `""` (probed) and this test still passes,
 * because `layoutClaims` compares against `` `${d}/` `` and no repo-relative
 * path starts with `/`. A green single mutation here is a fact about the guard
 * being redundant, not about the test being weak — so the asserted case is the
 * behaviour, and the neighbouring boundary test covers the other guard.
 */
test("a layout with an empty materializeRoot does not claim the whole repo", () => {
  assert.equal(codexClaims(".agents/skills/beta/SKILL.md"), true);
  assert.equal(codexClaims("AGENTS.md"), true);
  assert.equal(codexClaims(".codex/config.toml"), true);
  assert.equal(codexClaims(".ai/skills/check-dor/SKILL.md"), false);
  assert.equal(codexClaims("src/index.ts"), false);
  assert.equal(codexClaims("random-file.md"), false);
});

/** A claim is a prefix on a path BOUNDARY, never a bare string prefix. */
test("a claim does not leak to a sibling whose name merely starts the same", () => {
  assert.equal(ccClaims(".claude/skills/alpha/SKILL.md"), true);
  assert.equal(ccClaims(".claude-plugin/plugin.json"), true);
  assert.equal(ccClaims(".claudey/skills/alpha/SKILL.md"), false);
  assert.equal(ccClaims("skills-archive/alpha/SKILL.md"), false);
});

/**
 * Step 4 of #240: the repo owner answers the finding in their OWN config, and it
 * goes away — while the identical unnamed directory beside it still fires.
 *
 * Both halves on ONE call, because "declaring silenced it" and "the rule stopped
 * firing" are the same output from the quiet side.
 */
test("a declared root stops being a finding; an undeclared sibling still is", () => {
  const paths = [
    ".ai/skills/check-dor/SKILL.md",
    ".ai/skills/decompose/SKILL.md",
    ".vendor/skills/theirs/SKILL.md",
  ];
  assert.deepEqual(
    unclaimedSurfaceFindings(paths, both).map((f) => f.dir),
    [".ai/skills", ".vendor/skills"],
    "undeclared: both fire",
  );
  assert.deepEqual(
    unclaimedSurfaceFindings(paths, both, {
      layout: claudeCodeLayout,
      roots: [".ai"],
    }).map((f) => f.dir),
    [".vendor/skills"],
    "declaring `.ai` silences `.ai/skills` and NOTHING else",
  );
});

/**
 * 🔴 A DECLARATION SILENCES ONLY WHAT IT MAKES READABLE.
 *
 * `declaredRootClaims` is derived from the DETECTED layout's `surfaceDirs`, so
 * under Codex — whose skills live at `.agents/skills` — declaring `.ai` does not
 * reach `.ai/skills`, and the finding must SURVIVE. Otherwise setting the key
 * would buy silence about a directory that is still read by nobody, which is the
 * exact failure this whole module exists to end.
 *
 * The positive half is on the same input: `.ai/.agents/skills` IS what Codex
 * would read under that root, and it is silenced.
 */
test("a declaration reaches only the detected layout's own surface dirs", () => {
  const paths = [
    ".ai/skills/check-dor/SKILL.md",
    ".ai/.agents/skills/beta/SKILL.md",
  ];
  const declared = { roots: [".ai"] };
  assert.deepEqual(
    unclaimedSurfaceFindings(paths, both, {
      ...declared,
      layout: codexLayout,
    }).map((f) => f.dir),
    [".ai/skills"],
    "codex reads `.agents/skills`, so `.ai/skills` is still nobody's",
  );
  assert.deepEqual(
    unclaimedSurfaceFindings(paths, both, {
      ...declared,
      layout: claudeCodeLayout,
    }).map((f) => f.dir),
    [],
    "claude-code reads `skills`, so both dirs under `.ai` are covered",
  );
});

/** A declared claim is a path-BOUNDARY prefix, exactly as a layout claim is. */
test("a declared root does not leak to a sibling whose name starts the same", () => {
  const claims = (p: string): boolean =>
    declaredRootClaims(claudeCodeLayout, [".ai"], p);
  assert.equal(claims(".ai/skills/x/SKILL.md"), true);
  assert.equal(claims(".ai/skills"), true);
  assert.equal(claims(".airline/skills/x/SKILL.md"), false);
  assert.equal(claims(".ai/skillsets/x/SKILL.md"), false);
  assert.equal(claims(".ai/README.md"), false);
});
