/**
 * AuditReport contract suite (vitest, no fs/model): buildAuditReport assembles a
 * versioned report from a ScanReport — the upload/CI boundary. Pure (no clock):
 * `generatedAt` is the CLI's job, never the builder's, so the embedded-in-HTML
 * form stays deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  buildAuditReport,
  buildLeaderboardReport,
  buildMarketplaceReport,
  AUDIT_SCHEMA_VERSION,
} from "./audit-report.js";
import type { ScanReport, MarketplaceInfo } from "./scan.js";
import type { PluginScore } from "./score-core.js";

function makeReport(over: Partial<ScanReport> = {}): ScanReport {
  return {
    dir: "/x/demo",
    instructions: null,
    skills: [],
    agents: [],
    hooks: [],
    inlineHooks: 0,
    manualHookCount: 0,
    commands: 1,
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

describe("buildAuditReport", () => {
  it("stamps a versioned, self-describing meta (no clock in the pure builder)", () => {
    const r = buildAuditReport(makeReport(), {
      harness: "claude-code",
      vigilesVersion: "9.9.9",
    });
    expect(r.meta.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
    expect(r.meta.tool).toBe("vigiles");
    expect(r.meta.harness).toBe("claude-code");
    expect(r.meta.vigilesVersion).toBe("9.9.9");
    expect(r.meta.dir).toBe("/x/demo");
    expect(r.meta.generatedAt).toBeUndefined(); // CLI's job, not the builder's
  });

  it("carries the category score + the inventory", () => {
    const r = buildAuditReport(
      makeReport({ untested: 3, commands: 2, mcp: true }),
      { harness: "codex", vigilesVersion: "1.0.0" },
    );
    expect(r.score.categories.length).toBe(6); // + the Evaluated ring
    expect(typeof r.score.overall).toBe("number");
    expect(r.inventory).toEqual({
      skills: 0,
      agents: 0,
      hooks: 0,
      commands: 2,
      mcp: true,
      untested: 3,
    });
  });

  it("the inventory carries BOTH tiers when the scan split them", () => {
    // Same repo, two different gaps at two different costs — a consumer must be
    // able to tell "has harnesses, no evals" from "has neither".
    const r = buildAuditReport(
      makeReport({ untested: 1, untestedHarness: 1, unevaluated: 4 }),
      { harness: "claude-code", vigilesVersion: "1.0.0" },
    );
    expect(r.inventory.untestedHarness).toBe(1);
    expect(r.inventory.unevaluated).toBe(4);
    // A producer predating the split omits them entirely (additive/optional).
    const legacy = buildAuditReport(makeReport({ untested: 1 }), {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
    });
    expect(legacy.inventory.untestedHarness).toBeUndefined();
    expect(legacy.inventory.unevaluated).toBeUndefined();
  });

  it("🔴 the JSON distinguishes `not measured` from a measured 0 on Evaluated", () => {
    const report = makeReport({ evaluable: 4, unevaluated: 4 });
    const opts = { harness: "claude-code", vigilesVersion: "1.0.0" };
    const evalRing = (firingMeasured: boolean) =>
      buildAuditReport(report, {
        ...opts,
        firingMeasured,
      }).score.categories.find((c) => c.key === "Evaluated");

    // Headless read: the firing question was never asked. The wire shape has to
    // SAY that — a 0 here would report the absence of a check as its result.
    expect(evalRing(false)?.score).toBeNull();
    expect(evalRing(false)?.notMeasured).toBe(true);

    // The firing tier ran and found nothing covered: an earned, literal 0.
    expect(evalRing(true)?.score).toBe(0);
    expect(evalRing(true)?.notMeasured).toBeUndefined();

    // And the two serialize differently — the distinction survives the wire.
    expect(JSON.stringify(evalRing(false))).not.toBe(
      JSON.stringify(evalRing(true)),
    );
  });

  it("includes the deterministic recommendations (a typo'd tool → a fix)", () => {
    const report = makeReport({
      agents: [
        {
          name: "rev",
          tools: ["Reed"],
          toolIssues: [{ tool: "Reed", suggestion: "Read" }],
          mcpToolIssues: [],
          disallowedToolIssues: [],
        },
      ] as unknown as ScanReport["agents"],
    });
    const r = buildAuditReport(report, {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
    });
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations[0].surface).toBe("rev");
  });

  it("omits `adoptable` when there are no un-spec'd surfaces", () => {
    const r = buildAuditReport(makeReport(), {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
    });
    expect(r.adoptable).toBeUndefined();
    const r2 = buildAuditReport(makeReport(), {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
      adoptableSurfaces: [],
    });
    expect(r2.adoptable).toBeUndefined();
  });

  it("carries adoptable surfaces + the create-all + per-surface commands", () => {
    const r = buildAuditReport(makeReport(), {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
      adoptableSurfaces: ["skills/foo/SKILL.md", "agents/bar.md"],
    });
    expect(r.adoptable).toBeDefined();
    expect(r.adoptable?.createAllCommand).toBe("npx vigiles init");
    expect(r.adoptable?.surfaces).toEqual([
      {
        path: "skills/foo/SKILL.md",
        command: "npx vigiles init --target=skills/foo/SKILL.md",
      },
      {
        path: "agents/bar.md",
        command: "npx vigiles init --target=agents/bar.md",
      },
    ]);
  });

  it("is JSON-serializable round-trip (it IS the wire format)", () => {
    const r = buildAuditReport(makeReport(), {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
    });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  // Contract pin — the shared report view (packages/report-view/src/schema.ts)
  // mirrors this shape by hand and builds independently, so a field added/removed
  // here without updating the mirror would silently break the report. This pins
  // the wire shape so the change is CAUGHT; when it fails, update the mirror too.
  it("pins the AuditReport wire shape (mirror packages/report-view/src/schema.ts on change)", () => {
    const r = buildAuditReport(
      makeReport({
        agents: [
          {
            name: "a",
            tools: ["X"],
            toolIssues: [{ tool: "X", suggestion: "Y" }],
            mcpToolIssues: [],
            disallowedToolIssues: [],
          },
        ] as unknown as ScanReport["agents"],
      }),
      { harness: "claude-code", vigilesVersion: "1.0.0" },
    );
    expect(Object.keys(r).sort()).toEqual([
      "inventory",
      "meta",
      "recommendations",
      "score",
      "verdict",
    ]);
    expect(Object.keys(r.verdict).sort()).toEqual([
      "fixesToNextGrade",
      "grade",
      "perRecommendation",
      "pointsToNextGrade",
      "sentence",
    ]);
    expect(Object.keys(r.meta).sort()).toEqual([
      "dir",
      "harness",
      "kind",
      "schemaVersion",
      "tool",
      "vigilesVersion",
    ]);
    expect(Object.keys(r.score).sort()).toEqual([
      "categories",
      "empty",
      "grade",
      "instructionsOnly",
      "overall",
    ]);
    expect(Object.keys(r.score.categories[0]).sort()).toEqual([
      "findings",
      "key",
      "score",
      "weight",
    ]);
    expect(Object.keys(r.recommendations[0]).sort()).toEqual([
      "action",
      "confidence",
      "detector",
      "fix",
      "rationale",
      "surface",
    ]);
    expect(Object.keys(r.inventory).sort()).toEqual([
      "agents",
      "commands",
      "hooks",
      "mcp",
      "skills",
      "untested",
    ]);
    // The two-tier fields are ADDITIVE: present only when the scan split them,
    // and pinned here so the mirror is updated with them (never silently).
    const split = buildAuditReport(
      makeReport({ untestedHarness: 2, unevaluated: 5 }),
      { harness: "claude-code", vigilesVersion: "1.0.0" },
    );
    expect(Object.keys(split.inventory).sort()).toEqual([
      "agents",
      "commands",
      "hooks",
      "mcp",
      "skills",
      "unevaluated",
      "untested",
      "untestedHarness",
    ]);
    // …and the ring's third state adds exactly one key to a CategoryScore.
    const notMeasured = buildAuditReport(
      makeReport({ evaluable: 1, unevaluated: 1 }),
      { harness: "claude-code", vigilesVersion: "1.0.0" },
    ).score.categories.find((c) => c.key === "Evaluated");
    expect(Object.keys(notMeasured ?? {}).sort()).toEqual([
      "advisory",
      "findings",
      "key",
      "notMeasured",
      "score",
      "weight",
    ]);
  });

  it("carries the observations summary when provided (additive/optional)", () => {
    const r = buildAuditReport(makeReport({}), {
      harness: "claude-code",
      vigilesVersion: "1.0.0",
      observations: {
        total: 2,
        counts: [{ kind: "hook", count: 2 }],
        denials: 1,
        recentDenials: [{ label: "hook no-force-push", reason: "blocked" }],
      },
    });
    expect(r.observations?.total).toBe(2);
    expect(r.observations?.recentDenials[0].label).toBe("hook no-force-push");
  });
});

describe("buildLeaderboardReport / buildMarketplaceReport", () => {
  const plugin = (name: string, score: number): PluginScore =>
    ({
      dir: `/x/${name}`,
      name,
      score,
      grade: "A",
      issues: [],
      report: makeReport(),
    }) as PluginScore;

  it("wraps leaderboard scores in a versioned, self-describing envelope (not a bare array)", () => {
    const r = buildLeaderboardReport([plugin("a", 100), plugin("b", 95)], {
      vigilesVersion: "9.9.9",
      dir: "/x/market",
    });
    // The fix: a multi-plugin `audit --json` is a versioned OBJECT, never a raw array.
    expect(Array.isArray(r)).toBe(false);
    expect(r.meta.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
    expect(r.meta.tool).toBe("vigiles");
    expect(r.meta.kind).toBe("leaderboard");
    expect(r.meta.vigilesVersion).toBe("9.9.9");
    expect(r.meta.dir).toBe("/x/market");
    expect(r.meta.generatedAt).toBeUndefined(); // pure builder, no clock
    expect(r.plugins.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("wraps a curated marketplace inventory in a versioned envelope", () => {
    const mp: MarketplaceInfo = {
      name: "curated",
      onDisk: [],
      external: 2,
      total: 2,
    };
    const r = buildMarketplaceReport(mp, {
      vigilesVersion: "9.9.9",
      dir: "/x/curated",
    });
    expect(r.meta.kind).toBe("marketplace");
    expect(r.meta.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
    expect(r.marketplace.total).toBe(2);
    expect(r.marketplace.onDisk).toEqual([]);
  });
});
