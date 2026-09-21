/**
 * Verdict-engine suite (vitest, no fs/model): pure over a hand-built ScanReport.
 * The verdict sentence + per-recommendation `pointsIfFixed` are derived by
 * RE-SCORING (auditScore run again with a finding removed) and diffing the
 * overall — never a hardcoded number. We feed the REAL `auditScore` + `optimize`
 * outputs in (the same pieces buildAuditReport holds) so the detector→finding
 * mapping is exercised end-to-end, not mocked.
 */
import { describe, it, expect } from "vitest";
import { computeVerdict } from "./audit-verdict.js";
import { auditScore } from "./audit-score.js";
import { optimize } from "./optimize.js";
import type { ScanReport } from "./scan.js";

/** A clean, loaded report; override fields per test. */
function makeReport(over: Partial<ScanReport> = {}): ScanReport {
  return {
    dir: "/x",
    instructions: null,
    skills: [],
    agents: [],
    hooks: [],
    inlineHooks: 0,
    manualHookCount: 0,
    commands: 1, // a surface, so it's not the empty machine
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
    untested: 0,
    puritySummary: { pure: 0, bounded: 0, unrestricted: 0 },
    ...over,
  } as ScanReport;
}

/** The verdict computed from a report's REAL score + recommendations. */
function verdictFor(report: ScanReport) {
  return computeVerdict({
    report,
    score: auditScore(report),
    recommendations: optimize(report).recommendations,
  });
}

/** N model-invocable skills with no usable description (each a −10 finding + a rec). */
function noDescSkills(names: readonly string[]): ScanReport["skills"] {
  return names.map((name) => ({
    name,
    path: `skills/${name}/SKILL.md`,
    hasDescription: false,
    userInvoked: false,
    resourceIssues: [],
    trifecta: null,
    fenceIssue: null,
  })) as unknown as ScanReport["skills"];
}

describe("computeVerdict", () => {
  it("a clean report reads A — nothing blocking", () => {
    const v = verdictFor(makeReport());
    expect(v.grade).toBe("A");
    expect(v.pointsToNextGrade).toBeNull();
    expect(v.fixesToNextGrade).toBeNull();
    expect(v.perRecommendation).toEqual([]);
    expect(v.sentence).toBe("A — clean. Nothing blocking, nothing flagged.");
  });

  it("an A that carries a graded finding names it (never 'clean')", () => {
    // An agent naming an unknown model alias: 100 − 5 = 95 (A), graded but NOT a
    // recommendation. The verdict must not claim clean while the report shows it.
    //
    // Deliberately NOT a dangling ref any more, which is what this test used
    // before 2026-08-28: a broken reference is a CONFIDENT BREAKAGE and now caps
    // the score at 89, so "an A carrying a dangling ref" is a state that can no
    // longer exist. An invalid model alias is a SILENT FALLBACK — the agent still
    // registers, it just ignores the value — so it dents without capping, which is
    // exactly the line the cap is drawn on (score-core.ts::confidentBreakages).
    // (A description overlap was tried first and rejected: it IS a recommendation,
    // which would have changed what this test asserts.)
    const report = makeReport({
      frontmatterValueIssues: [
        {
          path: "agents/x.md",
          field: "model",
          value: "sonnet-4",
          suggestion: "sonnet",
          message: 'model "sonnet-4" is not a known alias — silent fallback',
        },
      ],
    });
    expect(auditScore(report).overall).toBe(95);
    const v = verdictFor(report);
    expect(v.grade).toBe("A");
    expect(v.sentence).not.toMatch(/clean/);
    expect(v.sentence).toMatch(/flagged/);
  });

  it("names the fix COUNT + target grade when fixing recs raises the grade (one fix)", () => {
    // Two no-description skills → 100 − 2×10 = 80 (B). Removing ONE reaches 90 (A).
    const report = makeReport({ skills: noDescSkills(["alpha", "beta"]) });
    expect(auditScore(report).overall).toBe(80);

    const v = verdictFor(report);
    expect(v.grade).toBe("B");
    expect(v.pointsToNextGrade).toBe(10);
    expect(v.fixesToNextGrade).toBe(1);
    expect(v.sentence).toBe("One fix away from an A.");
    expect(v.perRecommendation).toHaveLength(2);
  });

  it("names the fix COUNT (two) when a single fix is NOT enough to cross the band", () => {
    // One agent with three dead tools (−8 each) + an invalid model (−5, NOT a rec):
    // 100 − 24 − 5 = 71 (C). Reaching B (80) needs +9 → one −8 fix (→79) is short,
    // two (→87) cross. So the count must be 2, proven by cumulative re-score.
    const agents = [
      {
        name: "planner",
        path: "agents/planner.md",
        tools: ["Reed", "Wrote", "Bosh"],
        toolIssues: [
          {
            tool: "Reed",
            kind: "unknown",
            suggestion: "Read",
            message: 'tool "Reed" is not available',
          },
          {
            tool: "Wrote",
            kind: "unknown",
            suggestion: "Write",
            message: 'tool "Wrote" is not available',
          },
          {
            tool: "Bosh",
            kind: "unknown",
            suggestion: "Bash",
            message: 'tool "Bosh" is not available',
          },
        ],
        mcpToolIssues: [],
        disallowedToolIssues: [],
        purity: "unrestricted" as const,
        effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
        trifecta: null,
      },
    ] as unknown as ScanReport["agents"];
    const frontmatterValueIssues = [
      {
        path: "agents/planner.md",
        field: "model",
        value: "sonet",
        suggestion: "sonnet",
        message: 'agent has model "sonet" — silently falls back',
      },
    ] as unknown as ScanReport["frontmatterValueIssues"];

    const report = makeReport({ agents, frontmatterValueIssues });
    expect(auditScore(report).overall).toBe(71);

    const v = verdictFor(report);
    expect(v.grade).toBe("C");
    expect(v.pointsToNextGrade).toBe(9);
    expect(v.fixesToNextGrade).toBe(2);
    expect(v.sentence).toBe("Two fixes away from a B.");
    // The three tool findings are recs; the invalid model is not.
    expect(v.perRecommendation).toHaveLength(3);
  });

  it("pointsIfFixed is non-negative and sums no more than the gap to 100", () => {
    const report = makeReport({
      skills: noDescSkills(["alpha", "beta", "gamma"]),
    });
    const base = auditScore(report).overall; // 100 − 30 = 70
    const v = verdictFor(report);

    for (const p of v.perRecommendation) {
      expect(p.pointsIfFixed).toBeGreaterThanOrEqual(0);
    }
    // Each no-desc skill is worth exactly W_NO_DESCRIPTION = 10.
    expect(v.perRecommendation.map((p) => p.pointsIfFixed)).toEqual([
      10, 10, 10,
    ]);
    const sum = v.perRecommendation.reduce((n, p) => n + p.pointsIfFixed, 0);
    expect(sum).toBeLessThanOrEqual(100 - base);
  });

  it("index-aligns perRecommendation to the input recommendations array", () => {
    const report = makeReport({ skills: noDescSkills(["alpha", "beta"]) });
    const recommendations = optimize(report).recommendations;
    const v = computeVerdict({
      report,
      score: auditScore(report),
      recommendations,
    });
    expect(v.perRecommendation.map((p) => p.index)).toEqual(
      recommendations.map((_, i) => i),
    );
  });

  it("leads with the dominant finding when the fix list can't close the gap", () => {
    // A hard lethal-trifecta contract is a −10 graded penalty with NO recommendation
    // (it's not in explainScore). Two units → 100 − 20 = 80 (B); nothing in the fix
    // list can reach A, so fixesToNextGrade is null and the verdict is issue-forward.
    const trifectaFindings = [
      {
        path: "agents/exfil-bot.md",
        kind: "subagent",
        name: "exfil-bot",
        finding: { severity: "hard" },
      },
      {
        path: "agents/exfil-bot-2.md",
        kind: "subagent",
        name: "exfil-bot-2",
        finding: { severity: "hard" },
      },
    ] as unknown as ScanReport["trifectaFindings"];

    const report = makeReport({ trifectaFindings });
    expect(auditScore(report).overall).toBe(80);

    const v = verdictFor(report);
    expect(v.grade).toBe("B");
    expect(v.pointsToNextGrade).toBe(10);
    expect(v.fixesToNextGrade).toBeNull();
    expect(v.perRecommendation).toEqual([]);
    expect(v.sentence).toMatch(/^B — 2 units can read data, reach the web/);
    expect(v.sentence).toMatch(/still lands below an A\.$/);
  });

  it("an empty machine is reported as nothing to grade", () => {
    const report = makeReport({ commands: 0 }); // no surface at all → empty
    const v = verdictFor(report);
    expect(v.sentence).toBe(
      "No loadable harness surface — nothing to grade yet.",
    );
    expect(v.perRecommendation).toEqual([]);
  });
});
