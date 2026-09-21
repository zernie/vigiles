/**
 * Optimize test suite (vitest): the deterministic spine of `vigiles optimize` (A2).
 * Pure over a hand-built `ScanReport` (no fs, no model). Each case proves a scan
 * finding becomes a typed, actionable recommendation with the right action verb —
 * and that a clean repo hands off to the measured layer rather than inventing work
 * (the fix is the product, tested as much as the score).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { optimize, formatOptimize } from "./optimize.js";
import type { ScanReport, ScanSkill, ScanAgent } from "./scan.js";

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    dir: "myrepo",
    instructions: null,
    skills: [],
    agents: [],
    hooks: [],
    inlineHooks: 0,
    manualHookCount: 0,
    commands: 0,
    mcp: false,
    danglingRefs: [],
    hookEventIssues: [],
    frontmatterIssues: [],
    frontmatterValueIssues: [],
    skillMetaIssues: [],
    mcpIssues: [],
    mcpHookIssues: [],
    descriptionOverlaps: [],
    descriptionBudgetIssues: [],
    trifectaFindings: [],
    skillResourceIssues: [],
    skillFenceIssues: [],
    pluginLayoutIssues: [],
    unclaimedSurfaces: [],
    delegationTrifecta: [],
    hookBlockFindings: [],
    hookMatcherFindings: [],
    malformedFrontmatter: [],
    warnings: [],
    instructionWeight: null,
    untested: 0,
    puritySummary: { pure: 0, bounded: 0, unrestricted: 0 },
    ...over,
  };
}

function skill(over: Partial<ScanSkill> = {}): ScanSkill {
  return {
    name: "s",
    path: "skills/s/SKILL.md",
    hasDescription: true,
    userInvoked: false,
    resourceIssues: [],
    trifecta: null,
    fenceIssue: null,
    ...over,
  };
}

function agent(over: Partial<ScanAgent> = {}): ScanAgent {
  return {
    name: "a",
    path: "agents/a.md",
    tools: ["Read"],
    toolIssues: [],
    mcpToolIssues: [],
    disallowedToolIssues: [],
    purity: "bounded",
    effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
    trifecta: null,
    ...over,
  };
}

test("a structurally clean repo → top score, no fixes, hand off to measurement", () => {
  const plan = optimize(report({ skills: [skill()], agents: [agent()] }));
  assert.equal(plan.score, 100);
  assert.equal(plan.grade, "A");
  assert.equal(plan.empty, false);
  assert.equal(plan.recommendations.length, 0);
  const out = formatOptimize(plan);
  assert.match(out, /No deterministic fixes/);
  // The clean case must point at the MEASURED layer, not invent work.
  assert.match(out, /vigiles measure/);
  assert.match(out, /subscription/);
});

test("an empty machine is reported as empty, NOT 'clean'", () => {
  // No skills/agents/hooks/commands, no MCP → nothing loaded.
  const plan = optimize(report());
  assert.equal(plan.score, 0);
  assert.equal(plan.grade, "F");
  assert.equal(plan.empty, true);
  const out = formatOptimize(plan);
  assert.match(out, /Nothing loaded/);
  assert.doesNotMatch(out, /structure is clean/);
});

test("description overlap → a DIFFERENTIATE recommendation (possible)", () => {
  const plan = optimize(
    report({
      skills: [skill({ name: "caveman" }), skill({ name: "compress" })],
      descriptionOverlaps: [
        {
          a: "caveman",
          b: "compress",
          similarity: 0.86,
          message:
            "skills caveman and compress have near-identical descriptions",
        },
      ],
    }),
  );
  assert.equal(plan.recommendations.length, 1);
  const r = plan.recommendations[0];
  assert.equal(r.action, "differentiate");
  assert.equal(r.detector, "description-overlap");
  assert.equal(r.confidence, "possible");
  assert.match(r.surface, /caveman ↔ compress/);
  assert.match(formatOptimize(plan), /\[DIFFERENTIATE\]/);
});

test("a dropped tool → a FIX recommendation (likely) with the swap", () => {
  const plan = optimize(
    report({
      agents: [
        agent({
          name: "reviewer",
          tools: ["Reed"],
          toolIssues: [
            {
              tool: "Reed",
              kind: "unknown",
              verdict: "unrecognised",
              severity: "scored",
              suggestion: "Read",
              message: 'tool "Reed" is not available (did you mean "Read"?)',
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(plan.recommendations.length, 1);
  const r = plan.recommendations[0];
  assert.equal(r.action, "fix");
  assert.equal(r.confidence, "likely");
  assert.equal(r.surface, "reviewer");
  assert.match(r.fix, /Read/);
});

test("likely dead-ends are ordered before possible proxies", () => {
  const plan = optimize(
    report({
      // a `possible` overlap …
      descriptionOverlaps: [
        {
          a: "x",
          b: "y",
          similarity: 0.9,
          message: "near-identical descriptions",
        },
      ],
      // … and a `likely` no-description skill
      skills: [skill({ name: "z", hasDescription: false })],
    }),
  );
  assert.equal(plan.recommendations.length, 2);
  assert.equal(plan.recommendations[0].confidence, "likely");
  assert.equal(plan.recommendations[1].confidence, "possible");
});

test("the score tracks structural penalties (missing descriptions drop the grade)", () => {
  const plan = optimize(
    report({
      skills: [
        skill({ name: "x", hasDescription: false }),
        skill({ name: "y", hasDescription: false }),
        skill({ name: "z", hasDescription: false }),
      ],
    }),
  );
  assert.equal(plan.score, 70); // -10 each for three no-description skills
  assert.equal(plan.grade, "C");
  assert.match(formatOptimize(plan), /3 deterministic fix/);
});
