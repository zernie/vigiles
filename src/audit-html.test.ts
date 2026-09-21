/**
 * HTML-report suite (vitest, no browser). injectReportData is the pure, testable
 * core: it embeds the versioned AuditReport into the React template's placeholder
 * and escapes untrusted text so it can't break out of the <script>. renderAuditHtml
 * (which reads the built template from disk) is exercised e2e in scan-cli.test.ts.
 */
import { describe, it, expect } from "vitest";
import { injectReportData } from "./audit-html.js";
import type { AuditReport } from "./audit-report.js";

const TEMPLATE = `<!doctype html><html><body><div id="root"></div>
<script>window.__VIGILES_DATA__ = "__VIGILES_DATA_PLACEHOLDER__";</script>
</body></html>`;

const report: AuditReport = {
  meta: {
    schemaVersion: 2,
    tool: "vigiles",
    kind: "audit",
    vigilesVersion: "1.0.0",
    harness: "claude-code",
    dir: "/x/demo",
  },
  score: {
    overall: 81,
    grade: "B",
    empty: false,
    instructionsOnly: false,
    categories: [
      { key: "Truthfulness", score: 100, weight: 1, findings: [] },
      { key: "Triggering", score: 100, weight: 1, findings: [] },
      { key: "Structure", score: 92, weight: 1, findings: ["1 dead tool"] },
      { key: "Tested", score: null, weight: 1, findings: ["n/a"] },
    ],
  },
  verdict: {
    sentence: "One one-line fix away from an A.",
    grade: "B",
    pointsToNextGrade: 9,
    fixesToNextGrade: 1,
    perRecommendation: [{ index: 0, pointsIfFixed: 9 }],
  },
  recommendations: [
    {
      surface: "rev",
      action: "fix",
      rationale: "the subagent loses a declared tool",
      fix: 'change "Reed" to "Read"',
      detector: "subagent-tool-contract",
      confidence: "likely",
    },
  ],
  inventory: {
    skills: 2,
    agents: 1,
    hooks: 0,
    commands: 0,
    mcp: false,
    untested: 1,
  },
};

describe("injectReportData", () => {
  it("replaces the placeholder with the report JSON (data lands in the file)", () => {
    const html = injectReportData(TEMPLATE, report);
    expect(html).not.toContain("__VIGILES_DATA_PLACEHOLDER__");
    expect(html).toContain('"schemaVersion":2');
    expect(html).toContain('"grade":"B"');
    expect(html).toContain("subagent-tool-contract");
    // Still a single self-contained document.
    expect(html).toMatch(/^<!doctype html>/);
  });

  it("🔴 carries `not measured` into the HTML, distinguishably from a measured 0", () => {
    // The rendered artifact — the thing a human actually opens — must not flatten
    // "nobody asked whether your skills fire" into "we asked and the answer is 0".
    const withRing = (c: AuditReport["score"]["categories"][number]) =>
      injectReportData(TEMPLATE, {
        ...report,
        score: { ...report.score, categories: [...report.score.categories, c] },
      });
    const unasked = withRing({
      key: "Evaluated",
      score: null,
      weight: 1,
      advisory: true,
      notMeasured: true,
      findings: [
        "3 surfaces whose firing was never measured",
        "not measured —",
      ],
    });
    const measuredZero = withRing({
      key: "Evaluated",
      score: 0,
      weight: 1,
      advisory: true,
      findings: ["3 surfaces whose firing was never measured"],
    });
    expect(unasked).toContain('"notMeasured":true');
    expect(unasked).toContain('"key":"Evaluated","score":null');
    expect(measuredZero).toContain('"key":"Evaluated","score":0');
    expect(measuredZero).not.toContain("notMeasured");
    expect(unasked).not.toBe(measuredZero);
  });

  it("escapes <, >, & so report text can't break out of the <script>", () => {
    const evil: AuditReport = {
      ...report,
      recommendations: [
        { ...report.recommendations[0], fix: "use </script><script>alert(1)" },
      ],
    };
    const html = injectReportData(TEMPLATE, evil);
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c"); // < was escaped
  });

  it("throws when the template lacks the placeholder (malformed build)", () => {
    expect(() =>
      injectReportData("<html>no placeholder</html>", report),
    ).toThrow(/placeholder/);
  });

  it("injects the serve token only in --serve mode (absent for a static report)", () => {
    const staticHtml = injectReportData(TEMPLATE, report);
    expect(staticHtml).not.toContain("__VIGILES_SERVE__");

    const liveHtml = injectReportData(TEMPLATE, report, { token: "deadbeef" });
    expect(liveHtml).toContain("window.__VIGILES_SERVE__");
    expect(liveHtml).toContain("deadbeef");
    // the data global is still set (serve is prepended onto the same statement)
    expect(liveHtml).toContain("window.__VIGILES_DATA__");
  });
});
