/**
 * Score-explainer test suite (vitest): the deterministic WHY behind a behavioral
 * symptom. Pure over a hand-built `ScanReport` (no fs, no model). Each case proves
 * a cross-ref finding maps to the right symptom + an ACTIONABLE fix (the fix is the
 * product — tested as much as the verdict), reusing the leaderboard's report shape.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  explainScore,
  explainSurface,
  formatExplanations,
} from "./score-explainer.js";
import type { ScanReport, ScanSkill, ScanAgent } from "./scan.js";

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    dir: "x",
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

test("a structurally clean report yields no explanations", () => {
  const exps = explainScore(report({ skills: [skill()], agents: [agent()] }));
  assert.equal(exps.length, 0);
  assert.match(formatExplanations(exps), /No deterministic cause/);
});

test("description overlap → wrong-skill-fires, with a differentiate fix", () => {
  const exps = explainScore(
    report({
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
  assert.equal(exps.length, 1);
  assert.equal(exps[0].symptom, "wrong-skill-fires");
  assert.equal(exps[0].detector, "description-overlap");
  assert.equal(exps[0].confidence, "possible");
  assert.match(exps[0].fix, /Differentiate/);
  assert.match(exps[0].fix, /caveman/);
  assert.match(exps[0].fix, /0\.86/);
});

test("skill with no description → skill-never-fires (likely)", () => {
  const exps = explainScore(
    report({ skills: [skill({ name: "lonely", hasDescription: false })] }),
  );
  assert.equal(exps.length, 1);
  assert.equal(exps[0].symptom, "skill-never-fires");
  assert.equal(exps[0].confidence, "likely");
  assert.equal(exps[0].detector, "skill-frontmatter");
  assert.match(exps[0].fix, /Add a "description:" to "lonely"/);
});

test("a described skill produces no explanation", () => {
  const exps = explainScore(
    report({ skills: [skill({ name: "fine", hasDescription: true })] }),
  );
  assert.equal(exps.length, 0);
});

test("agent tool issue with a suggestion → swap fix; without → remove fix", () => {
  const withSuggestion = explainScore(
    report({
      agents: [
        agent({
          name: "rev",
          toolIssues: [
            {
              tool: "Reed",
              kind: "unknown",
              verdict: "unrecognised",
              severity: "scored",
              suggestion: "Read",
              message: 'unknown tool "Reed" (did you mean "Read"?)',
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(withSuggestion[0].symptom, "agent-underperforms");
  assert.equal(withSuggestion[0].detector, "subagent-tool-contract");
  assert.match(withSuggestion[0].fix, /change the tool "Reed" to "Read"/);

  const noSuggestion = explainScore(
    report({
      agents: [
        agent({
          toolIssues: [
            {
              tool: "AskUserQuestion",
              kind: "never-available",
              verdict: "withheld",
              severity: "scored",
              suggestion: null,
              message: 'tool "AskUserQuestion" is never available to subagents',
            },
          ],
        }),
      ],
    }),
  );
  assert.match(
    noSuggestion[0].fix,
    /remove or correct the tool "AskUserQuestion"/,
  );
});

test("agent MCP tool naming an undeclared server → agent-underperforms", () => {
  const exps = explainScore(
    report({
      agents: [
        agent({
          name: "browser",
          mcpToolIssues: [
            {
              tool: "mcp__playwright__click",
              server: "playwright",
              message:
                'MCP tool "mcp__playwright__click" names undeclared server "playwright"',
            },
          ],
        }),
      ],
    }),
  );
  assert.equal(exps[0].symptom, "agent-underperforms");
  assert.equal(exps[0].detector, "mcp-tool-resolves");
  assert.match(exps[0].fix, /playwright/);
  assert.match(exps[0].fix, /can't resolve/);
});

test("hook on an unknown event → hook-never-runs (with/without suggestion)", () => {
  const typo = explainScore(
    report({
      hookEventIssues: [
        {
          event: "PreToolUze",
          verdict: "unrecognised",
          suggestion: "PreToolUse",
          severity: "scored",
          message:
            'unknown hook event "PreToolUze" (did you mean "PreToolUse"?)',
        },
      ],
    }),
  );
  assert.equal(typo[0].symptom, "hook-never-runs");
  assert.equal(typo[0].detector, "hook-events");
  assert.match(
    typo[0].fix,
    /Change the hook event "PreToolUze" to "PreToolUse"/,
  );

  const bare = explainScore(
    report({
      hookEventIssues: [
        {
          event: "Whenever",
          verdict: "unrecognised",
          suggestion: null,
          severity: "scored",
          message: 'unknown hook event "Whenever"',
        },
      ],
    }),
  );
  assert.match(bare[0].fix, /Fix the hook event "Whenever"/);
});

test("a missing hook script → hook-never-runs", () => {
  const exps = explainScore(
    report({
      hooks: [
        {
          command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/gate.sh",
          script: "${CLAUDE_PLUGIN_ROOT}/hooks/gate.sh",
          status: "missing",
        },
        { command: "bash hooks/ok.sh", script: "hooks/ok.sh", status: "ok" },
      ],
    }),
  );
  assert.equal(exps.length, 1);
  assert.equal(exps[0].symptom, "hook-never-runs");
  assert.equal(exps[0].detector, "hook-script-exists");
  assert.match(exps[0].fix, /never runs/);
});

test("subagent missing frontmatter → subagent-never-dispatches; a skill issue is ignored", () => {
  const exps = explainScore(
    report({
      frontmatterIssues: [
        {
          path: "agents/broken.md",
          kind: "agent",
          missing: ["name", "description"],
          message: "subagent agents/broken.md is missing name, description",
        },
        // a skill-kind frontmatter issue must NOT produce a subagent explanation
        {
          path: "skills/x/SKILL.md",
          kind: "skill",
          missing: ["name"],
          message: "skill is missing name",
        },
      ],
    }),
  );
  assert.equal(exps.length, 1);
  assert.equal(exps[0].symptom, "subagent-never-dispatches");
  assert.equal(exps[0].detector, "subagent-frontmatter");
  assert.match(exps[0].fix, /name \+ description/);
});

test("likely causes sort before possible (overlap) ones", () => {
  const exps = explainScore(
    report({
      descriptionOverlaps: [
        { a: "x", b: "y", similarity: 0.9, message: "x and y overlap" },
      ],
      skills: [skill({ name: "nodesc", hasDescription: false })],
    }),
  );
  assert.equal(exps.length, 2);
  assert.equal(exps[0].confidence, "likely"); // the no-description dead-end first
  assert.equal(exps[1].confidence, "possible"); // the overlap proxy after
});

test("explainSurface filters to one surface, including overlap pairs", () => {
  const r = report({
    descriptionOverlaps: [
      { a: "caveman", b: "compress", similarity: 0.86, message: "overlap" },
    ],
    agents: [
      agent({
        name: "reviewer",
        toolIssues: [
          {
            tool: "Reed",
            kind: "unknown",
            verdict: "unrecognised",
            severity: "scored",
            suggestion: "Read",
            message: "typo",
          },
        ],
      }),
    ],
  });
  // the overlap pair "caveman ↔ compress" matches a query for "caveman"
  const cav = explainSurface(r, "caveman");
  assert.equal(cav.length, 1);
  assert.equal(cav[0].symptom, "wrong-skill-fires");
  // case-insensitive, matches the agent
  assert.equal(explainSurface(r, "REVIEWER").length, 1);
  assert.equal(explainSurface(r, "absent").length, 0);
});

test("formatExplanations renders the symptom, cause+detector, and fix", () => {
  const out = formatExplanations(
    explainScore(
      report({ skills: [skill({ name: "ghost", hasDescription: false })] }),
    ),
  );
  assert.match(out, /ghost — the skill never fires/);
  assert.match(out, /cause:.*\[skill-frontmatter\]/);
  assert.match(out, /fix:\s+Add a "description:"/);
});
