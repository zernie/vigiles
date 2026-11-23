/**
 * The PR-comment audit section (#474), rendered from the versioned AuditReport
 * and never from terminal text. Pure: a hand-built report in, markdown out.
 *
 * What is held here is the CONTRACT the Action relies on: the marker it looks
 * for, the four graded rings, the advisory rings marked as such, the top fixes
 * ranked by the points the verdict engine computed, the per-ring change against
 * the PR base, and the line saying what this headless read did not run.
 */
import { describe, it, expect } from "vitest";
import {
  AUDIT_SUMMARY_MARKER,
  parseBaseAudit,
  renderAuditPrSummary,
  type BaseAudit,
} from "./audit-pr-summary.js";
import {
  AUDIT_SCHEMA_VERSION,
  buildAuditReport,
  type AuditReport,
} from "./audit-report.js";
import type { CategoryScore } from "./audit-score.js";
import type { Recommendation } from "./optimize.js";
import { scanPlugin } from "./scan.js";
import { defaultAdapter } from "./adapter-registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRules } from "./core/apply-rules.js";
import { defaultSeverities } from "./core/rule.js";
import { ruleResolver } from "./overrides.js";
import { RULES, RULE_GROUPS } from "./rules/index.js";

/** A real report off a real scan of an empty directory; tests set what they read. */
function cleanReport(): AuditReport {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-pr-summary-"));
  try {
    const { layout, dialect } = defaultAdapter;
    return buildAuditReport(
      applyRules(
        RULES,
        RULE_GROUPS,
        ruleResolver(defaultSeverities(RULES)),
        scanPlugin(dir, layout, dialect),
      ),
      { harness: layout.name, vigilesVersion: "0.0.0-test" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ring = (
  key: CategoryScore["key"],
  score: number | null,
  extra: Partial<CategoryScore> = {},
): CategoryScore => ({ key, score, weight: 1, findings: [], ...extra });

const rec = (surface: string, fix: string): Recommendation => ({
  surface,
  action: "fix",
  rationale: `${surface} is broken`,
  fix,
  detector: "broken-ref",
  confidence: "likely",
});

/** Head: C · 74, Safety 82, four fixes worth 2 / 9 / 5 / 1 points. */
function headReport(): AuditReport {
  const base = cleanReport();
  return {
    ...base,
    score: {
      ...base.score,
      overall: 74,
      grade: "C",
      categories: [
        ring("Truthfulness", 100),
        ring("Triggering", 90),
        ring("Structure", 70),
        ring("Safety", 82),
        ring("Tested", 40, { advisory: true }),
        ring("Evaluated", null, { advisory: true, notMeasured: true }),
      ],
    },
    recommendations: [
      rec("skills/alpha", "fix alpha"),
      rec("skills/bravo", "fix bravo"),
      rec("agents/charlie", "fix charlie"),
      rec("hooks/delta", "fix delta"),
    ],
    verdict: {
      ...base.verdict,
      grade: "C",
      perRecommendation: [
        { index: 0, pointsIfFixed: 2 },
        { index: 1, pointsIfFixed: 9 },
        { index: 2, pointsIfFixed: 5 },
        { index: 3, pointsIfFixed: 1 },
      ],
    },
  };
}

/** The PR base: B · 85, Safety 90, Structure 60 (so Structure improved). */
const BASE: BaseAudit = {
  kind: "report",
  score: {
    overall: 85,
    grade: "B",
    categories: [
      { key: "Truthfulness", score: 100 },
      { key: "Triggering", score: 90 },
      { key: "Structure", score: 60 },
      { key: "Safety", score: 90 },
      { key: "Tested", score: 40 },
      { key: "Evaluated", score: null },
    ],
  },
};

/** The table row (or line) that names a ring. */
const lineFor = (md: string, key: string): string =>
  md.split("\n").find((l) => l.includes(key)) ?? "";

describe("renderAuditPrSummary", () => {
  it("starts with the marker the Action looks for", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    expect(md.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
  });

  it("states the grade and the overall score", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    expect(md).toContain("**C**");
    expect(md).toContain("74");
  });

  it("lists the four graded rings, and marks the two advisory ones", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    for (const key of ["Truthfulness", "Triggering", "Structure", "Safety"]) {
      expect(lineFor(md, key)).not.toBe("");
      expect(lineFor(md, key)).not.toContain("advisory");
    }
    expect(lineFor(md, "Tested")).toContain("advisory");
    expect(lineFor(md, "Evaluated")).toContain("advisory");
    // A ring this run never measured is not printed as a number.
    expect(lineFor(md, "Evaluated")).toContain("not measured");
  });

  it("shows the three fixes worth the most points, best first", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    const top = md.slice(0, md.indexOf("<details>"));
    const order = ["skills/bravo", "agents/charlie", "skills/alpha"].map((s) =>
      top.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(top).not.toContain("hooks/delta");
    expect(top).toContain("fix bravo");
    expect(top).toContain("+9");
  });

  it("keeps every fix in a collapsed list, so nothing is dropped", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    const details = md.slice(md.indexOf("<details>"));
    for (const s of ["alpha", "bravo", "charlie", "delta"])
      expect(details).toContain(`fix ${s}`);
  });

  it("says this was the headless read and names what did not run", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    expect(md).toContain("npx vigiles audit");
    expect(md).toMatch(/MCP/);
    expect(md).toMatch(/trigger rate/i);
    expect(md).toMatch(/ESLint/);
  });
});

describe("renderAuditPrSummary — the PR base", () => {
  it("with no base, says nothing about one", () => {
    const md = renderAuditPrSummary(headReport(), { kind: "none" });
    expect(md).not.toMatch(/\bbase\b/i);
    expect(md).not.toMatch(/[▲▼]/);
  });

  it("with a base, shows each ring's change and the overall change", () => {
    const md = renderAuditPrSummary(headReport(), BASE);
    expect(lineFor(md, "Safety")).toContain("90 → 82 ▼");
    expect(lineFor(md, "Structure")).toContain("60 → 70 ▲");
    expect(lineFor(md, "Truthfulness")).not.toMatch(/[▲▼]/);
    expect(md).toContain("85 → 74 ▼");
    expect(md).toContain("B → C");
  });

  it("with a base that could not be audited, shows the current grade and why", () => {
    const md = renderAuditPrSummary(headReport(), {
      kind: "unavailable",
      why: "the PR base has no harness to audit",
    });
    expect(md).toContain("**C**");
    expect(md).toContain("the PR base has no harness to audit");
    expect(md).not.toMatch(/[▲▼]/);
  });
});

describe("renderAuditPrSummary — what to fix", () => {
  it("with no fix list, lists the graded rings' own findings, worst ring first", () => {
    const head = headReport();
    const md = renderAuditPrSummary(
      {
        ...head,
        recommendations: [],
        verdict: { ...head.verdict, perRecommendation: [] },
        score: {
          ...head.score,
          categories: [
            ring("Structure", 90, { findings: ["structure finding"] }),
            ring("Safety", 60, { findings: ["safety finding"] }),
            ring("Tested", 10, {
              advisory: true,
              findings: ["advisory finding"],
            }),
          ],
        },
      },
      { kind: "none" },
    );
    const top = md.slice(0, md.indexOf("<details>"));
    expect(top.indexOf("safety finding")).toBeGreaterThan(-1);
    expect(top.indexOf("safety finding")).toBeLessThan(
      top.indexOf("structure finding"),
    );
    expect(md).not.toContain("advisory finding");
  });

  it("a clean report says there is nothing to fix", () => {
    const clean = cleanReport();
    const md = renderAuditPrSummary(clean, { kind: "none" });
    expect(md.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
    expect(md).not.toContain("<details>");
  });
});

describe("parseBaseAudit", () => {
  const report = cleanReport();
  const graded = { ...report, score: { ...report.score, empty: false } };

  it("reads a real audit --json report as the base", () => {
    expect(parseBaseAudit(JSON.stringify(graded)).kind).toBe("report");
  });

  it("a missing file is a base that could not be audited, not an error", () => {
    expect(parseBaseAudit(undefined).kind).toBe("unavailable");
  });

  it("text that is not JSON is unavailable, with a reason", () => {
    const base = parseBaseAudit("Detected harness: x\n");
    expect(base).toMatchObject({ kind: "unavailable" });
  });

  it("a report from another schema version is not compared", () => {
    const other = {
      ...graded,
      meta: { ...graded.meta, schemaVersion: AUDIT_SCHEMA_VERSION + 1 },
    };
    expect(parseBaseAudit(JSON.stringify(other)).kind).toBe("unavailable");
  });

  it("a base with nothing to audit is unavailable, and says so", () => {
    const empty = { ...graded, score: { ...graded.score, empty: true } };
    const base = parseBaseAudit(JSON.stringify(empty));
    expect(base.kind).toBe("unavailable");
    expect(base.kind === "unavailable" ? base.why : "").toMatch(/harness/);
  });
});
