/**
 * The `AuditReport` — the versioned JSON contract that IS the audit's product
 * boundary. Everything renders FROM it: the local self-contained HTML report,
 * `audit --json` for CI, and (later) an upload to a hosted dashboard. Because it's
 * the wire format between the CLI and anything downstream, it is VERSIONED
 * (`meta.schemaVersion`) and stable — additive changes only within a version.
 *
 * Pure: `buildAuditReport` assembles the report from the same deterministic pieces
 * the terminal output uses (`auditScore` + `optimize` + the scan inventory) — no
 * re-detection (one-detector-no-drift), no model, no clock (a `generatedAt`
 * timestamp is attached by the CLI at write time, never by this pure builder, so
 * the embedded-in-HTML form stays deterministic).
 */
import {
  auditScore,
  type AuditScore,
  type AuditScoreOptions,
} from "./audit-score.js";
import { optimize, type Recommendation } from "./optimize.js";
import { computeVerdict, type Verdict } from "./audit-verdict.js";
import type { LedgerSummary } from "./observe.js";
import type { AdoptabilityResult } from "./adoptability.js";
import type { ScanReport, MarketplaceInfo } from "./scan.js";
import type { PluginScore } from "./score-core.js";
import type { RuleInventoryItem } from "./rule-inventory.js";
import type { RuleRouting } from "./rule-routing.js";
import type { EvidenceCounts } from "./coverage-evidence.js";

/**
 * The current schema version. Bump only on a BREAKING change to the shape.
 * v2 (2026-07-15): the rule-map `mechanism` enum value for an unrouted rule
 * changed `"compile"` → `"synthesize"` (a non-additive enum change), so a v1
 * consumer that gated on `meta.schemaVersion` would mis-handle it — hence the bump.
 */
export const AUDIT_SCHEMA_VERSION = 2;

export interface AuditReportMeta {
  /** Wire-format version — consumers gate on this. */
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  readonly tool: "vigiles";
  /**
   * Discriminates the three `audit --json` shapes a consumer may receive:
   * `audit` (one plugin → {@link AuditReport}), `leaderboard` (a marketplace /
   * multiple dirs → {@link LeaderboardReport}), `marketplace` (a curated,
   * all-external marketplace → {@link MarketplaceReport}). Always present so the
   * JSON is self-describing.
   */
  readonly kind: "audit";
  /** The vigiles version that produced the report. */
  readonly vigilesVersion: string;
  /** The detected/selected harness (`claude-code`, `codex`, …). */
  readonly harness: string;
  /** The audited directory. */
  readonly dir: string;
  /** ISO-8601 produced-at stamp — set by the CLI at write time (NOT the pure builder). */
  readonly generatedAt?: string;
}

/** What the harness ships — the "inventory" surface counts. */
export interface AuditInventory {
  readonly skills: number;
  readonly agents: number;
  readonly hooks: number;
  readonly commands: number;
  /**
   * Output styles found, or `"not-supported"` when the harness has none.
   * Omitted when there are zero, so a report without styles is unchanged.
   */
  readonly outputStyles?: number | "not-supported";
  readonly mcp: boolean;
  /** Surfaces covered by NEITHER tier — the union count (unchanged). */
  readonly untested: number;
  /**
   * The two tiers, carried SEPARATELY so a consumer can tell "has deterministic
   * coverage, no evals" from "has neither" — a distinction the single `untested`
   * count erased. `untestedHarness` is free-and-every-push work; `unevaluated` is
   * paid real-model work. Additive/optional — schema version unchanged.
   */
  readonly untestedHarness?: number;
  readonly unevaluated?: number;
  /**
   * HOW the covered surfaces were decided to be covered — `declared` (an explicit
   * `vigiles:covers` marker), `colocated` (a test placed at the surface), or
   * `mention` (the surface's path/namespace appears in a test's code). Carried in
   * the product boundary because a coverage count without its derivation is not
   * auditable: a repo whose coverage is entirely `mention` looks, in a bare
   * number, exactly like one with real tests. Additive/optional — schema version
   * unchanged.
   */
  readonly coverageEvidence?: EvidenceCounts;
}

/**
 * A surface (skill / subagent / instruction file) that EXISTS but doesn't yet
 * have a `.spec.ts` — so it can be adopted into a typed spec. The report can't
 * write files (it's a browser app), so it EMITS the exact CLI command instead.
 */
export interface AdoptableSurface {
  /** The repo-relative path of the surface (e.g. `skills/foo/SKILL.md`). */
  readonly path: string;
  /** The exact command that adopts this one surface. */
  readonly command: string;
}

/**
 * The adoptable-surfaces list + the "create all" command — the data the report's
 * "Create spec" / "Create all specs" affordances copy to the clipboard. Present
 * only when there's at least one un-spec'd surface; the CLI computes the surface
 * paths (the layout-aware `discoverAdoptableSurfaces`) and passes them in, so the
 * pure builder stays adapter-agnostic.
 */
export interface Adoptable {
  readonly surfaces: readonly AdoptableSurface[];
  /** The one command that adopts every surface at once. */
  readonly createAllCommand: string;
}

/**
 * The full audit, as the dashboard / CI / HTML all consume it. Self-describing
 * and versioned; additive-only within a `schemaVersion`.
 */
export interface AuditReport {
  readonly meta: AuditReportMeta;
  /** The six category rings + the weighted overall + grade. */
  readonly score: AuditScore;
  /**
   * The one-line verdict + per-recommendation `pointsIfFixed`, both derived by
   * RE-SCORING (never a hardcoded number). Drives the report's verdict-led header
   * ("Two fixes away from a B.") and the `+N pts` badges on fix cards.
   * Pure/deterministic — always present.
   */
  readonly verdict: Verdict;
  /** The deterministic, ranked fixes (the inline recommendations). */
  readonly recommendations: readonly Recommendation[];
  readonly inventory: AuditInventory;
  /**
   * The CONCRETE intra-plugin references that don't resolve on disk — the actual
   * paths behind the Truthfulness category's "N broken intra-plugin reference(s)"
   * count, so the report can show WHAT is broken (a file path), not just how many.
   * Present only when at least one dangling ref exists. Additive/optional — schema
   * version unchanged.
   */
  readonly brokenReferences?: readonly string[];
  /**
   * The adoption preview — "what would vigiles catch in your repo?" Present only
   * when the model-gated tier ran (behind consent); a deterministic read omits it.
   * Additive/optional, so the schema version is unchanged.
   */
  readonly adoptability?: AdoptabilityResult;
  /**
   * The surfaces that exist but aren't spec-managed yet, each with the command
   * that adopts it, plus a "create all" command. Drives the report's "Create
   * spec" / "Create all specs" command-emit buttons. Present only when there's
   * at least one adoptable surface. Additive/optional — schema version unchanged.
   */
  readonly adoptable?: Adoptable;
  /**
   * The flight-recorder summary — what the harness actually DID in real sessions
   * (hook/agent decisions, counts, recent denials), read off `.vigiles/runs.jsonl`.
   * Present only when the local ledger has records. Additive/optional — schema
   * version unchanged. The CLI reads + summarizes the ledger and passes it in, so
   * the pure builder stays fs-free.
   */
  readonly observations?: LedgerSummary;
  /**
   * The deterministic rule-inventory teaser — prose rules in the harness that
   * map to an off-the-shelf lint rule + whether that rule is already in the
   * config (the one-line-config-fix nudge). No model, no config execution. The
   * CLI computes it (reads the instruction + config text, calls
   * `buildRuleInventory`) and passes it in, so the pure builder stays fs-free.
   * Present only when at least one intent resolves. Additive/optional — schema
   * version unchanged. See `research/audit-rule-compile-tier.md`.
   */
  readonly rulesInventory?: readonly RuleInventoryItem[];
  /**
   * The deterministic State-B routing PREVIEW — the instruction file segmented
   * into atomic rules, each routed (reuse / hook / meta / semantic / unrouted) to how
   * it would be enforced, with per-category counts. No model, fs-only. Grounds
   * the report's "rule map" (strengthen / hook / prose / synthesize) in real
   * numbers instead of generic copy.
   * Present only when at least one atomic rule was segmented. Additive/optional.
   */
  readonly ruleRouting?: RuleRouting;
}

export interface BuildAuditReportOptions extends AuditScoreOptions {
  readonly harness: string;
  readonly vigilesVersion: string;
  /** The flight-recorder summary from the local ledger (omit when empty). */
  readonly observations?: LedgerSummary;
  /**
   * The repo-relative paths of surfaces that exist but have no `.spec.ts` yet,
   * computed by the CLI's layout-aware `discoverAdoptableSurfaces` (so the pure
   * builder stays adapter-agnostic — it only formats the commands). Omit/empty
   * when there's nothing to adopt.
   */
  readonly adoptableSurfaces?: readonly string[];
  /**
   * The rule-inventory items the CLI computed via `buildRuleInventory` (reading
   * the instruction + config text). Omit/empty when nothing resolved.
   */
  readonly rulesInventory?: readonly RuleInventoryItem[];
  /**
   * The State-B routing preview the CLI computed via `routeRules`. Omit when
   * nothing segmented.
   */
  readonly ruleRouting?: RuleRouting;
}

/** The one command that adopts every un-spec'd surface (bare `init`). */
const CREATE_ALL_COMMAND = "npx vigiles init";

/** The command that adopts ONE surface at a given repo-relative path. */
function adoptCommand(path: string): string {
  return `npx vigiles init --target=${path}`;
}

/**
 * Build the {@link Adoptable} payload from the layout-aware surface paths — pure,
 * just formats the per-surface + create-all commands. Returns `undefined` when
 * there's nothing to adopt (so the field stays absent).
 */
function buildAdoptable(
  surfaces: readonly string[] | undefined,
): Adoptable | undefined {
  if (!surfaces || surfaces.length === 0) return undefined;
  return {
    surfaces: surfaces.map((path) => ({ path, command: adoptCommand(path) })),
    createAllCommand: CREATE_ALL_COMMAND,
  };
}

/** What the scanned harness ships, as the report's `inventory`. */
function inventoryOf(report: ScanReport): AuditInventory {
  return {
    skills: report.skills.length,
    agents: report.agents.length,
    // All hooks, file-backed + inline — matches formatScanReport and the
    // emptiness/scoring count, so a JSON/HTML "What it ships" never reports 0
    // hooks for an inline-hook-only harness.
    hooks: report.hooks.length + report.inlineHooks,
    commands: report.commands,
    ...outputStylesField(report.outputStyles),
    mcp: report.mcp,
    untested: report.untested,
    ...(report.untestedHarness !== undefined
      ? { untestedHarness: report.untestedHarness }
      : {}),
    ...(report.unevaluated !== undefined
      ? { unevaluated: report.unevaluated }
      : {}),
    ...(report.coverageEvidence
      ? { coverageEvidence: report.coverageEvidence }
      : {}),
  };
}

/** The inventory's `outputStyles` entry: present unless there are none to report. */
function outputStylesField(n: number | "not-supported" | undefined): {
  readonly outputStyles?: number | "not-supported";
} {
  return n === undefined || n === 0 ? {} : { outputStyles: n };
}

/**
 * Assemble the versioned {@link AuditReport} from a scan report — pure, no clock.
 * The CLI attaches `meta.generatedAt` when it writes the JSON artifact; the
 * HTML-embedded form omits it so the rendered file stays deterministic.
 */
export function buildAuditReport(
  report: ScanReport,
  opts: BuildAuditReportOptions,
): AuditReport {
  const adoptable = buildAdoptable(opts.adoptableSurfaces);
  const score = auditScore(report, { firingMeasured: opts.firingMeasured });
  const recommendations = optimize(report).recommendations;
  const verdict = computeVerdict({ report, score, recommendations });
  return {
    meta: {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      tool: "vigiles",
      kind: "audit",
      vigilesVersion: opts.vigilesVersion,
      harness: opts.harness,
      dir: report.dir,
    },
    score,
    verdict,
    recommendations,
    inventory: inventoryOf(report),
    ...(report.danglingRefs.length
      ? { brokenReferences: report.danglingRefs }
      : {}),
    ...(adoptable ? { adoptable } : {}),
    ...(opts.observations ? { observations: opts.observations } : {}),
    ...(opts.rulesInventory && opts.rulesInventory.length
      ? { rulesInventory: opts.rulesInventory }
      : {}),
    ...(opts.ruleRouting &&
    (opts.ruleRouting.segmented > 0 ||
      opts.ruleRouting.possible.length > 0 ||
      opts.ruleRouting.skipped.length > 0)
      ? { ruleRouting: opts.ruleRouting }
      : {}),
  };
}

/**
 * The versioned envelope for a `audit --json` run over MULTIPLE plugins (a
 * marketplace expanded into its members, or several dirs) — the leaderboard.
 * Shares the same `meta.schemaVersion`/`tool`/`kind` self-description as
 * {@link AuditReport} so every `audit --json` shape is a versioned object, never
 * a bare array. `kind:"leaderboard"` is the discriminant; `plugins` carries the
 * ranked per-plugin scores.
 */
export interface LeaderboardReport {
  readonly meta: {
    readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
    readonly tool: "vigiles";
    readonly kind: "leaderboard";
    readonly vigilesVersion: string;
    /** The marketplace / parent dir that was expanded and ranked. */
    readonly dir: string;
    readonly generatedAt?: string;
  };
  readonly plugins: readonly PluginScore[];
}

/** Assemble the versioned {@link LeaderboardReport} — pure, no clock. */
export function buildLeaderboardReport(
  plugins: readonly PluginScore[],
  opts: { vigilesVersion: string; dir: string },
): LeaderboardReport {
  return {
    meta: {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      tool: "vigiles",
      kind: "leaderboard",
      vigilesVersion: opts.vigilesVersion,
      dir: opts.dir,
    },
    plugins,
  };
}

/**
 * The versioned envelope for a `audit --json` run on a CURATED marketplace whose
 * members are all external (git/url, nothing on disk to scan). Wraps the
 * {@link MarketplaceInfo} inventory so this path, too, emits a versioned object
 * rather than a raw, unversioned struct. `kind:"marketplace"` is the discriminant.
 */
export interface MarketplaceReport {
  readonly meta: {
    readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
    readonly tool: "vigiles";
    readonly kind: "marketplace";
    readonly vigilesVersion: string;
    readonly dir: string;
    readonly generatedAt?: string;
  };
  readonly marketplace: MarketplaceInfo;
}

/** Assemble the versioned {@link MarketplaceReport} — pure, no clock. */
export function buildMarketplaceReport(
  marketplace: MarketplaceInfo,
  opts: { vigilesVersion: string; dir: string },
): MarketplaceReport {
  return {
    meta: {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      tool: "vigiles",
      kind: "marketplace",
      vigilesVersion: opts.vigilesVersion,
      dir: opts.dir,
    },
    marketplace,
  };
}
