/**
 * The AuditReport wire types — a MIRROR of the CLI's `src/audit-report.ts` (+
 * `audit-score.ts` / `optimize.ts`). This sub-package builds independently, so it
 * can't import the CLI's source; the contract is versioned (`meta.schemaVersion`)
 * and additive-only, and the CLI's `report-schema-parity` test asserts these stay
 * in sync. Keep them aligned when the schema changes.
 */
export type CategoryKey =
  | "Truthfulness"
  | "Triggering"
  | "Structure"
  | "Safety"
  /** DETERMINISTIC harness coverage — free, milliseconds, every push. */
  | "Tested"
  /** REAL-MODEL eval coverage — paid, minutes, scheduled. Does a skill FIRE? */
  | "Evaluated";

export interface CategoryScore {
  key: CategoryKey;
  score: number | null;
  weight: number;
  /**
   * Advisory categories (e.g. Tested) are shown but EXCLUDED from the overall
   * grade — an untested surface is a hardening signal, not breakage. The report
   * renders an advisory ring neutrally (a muted "advisory" label), never as a
   * failing/red ring that appears to drag the grade.
   */
  advisory?: boolean;
  /**
   * `score: null` because this run never ASKED the question — distinct from `null`
   * meaning "nothing to assess" (plain n/a) and from a measured `0`. Rendering an
   * unasked question as a zero reports the absence of a check as the result of
   * one. Carries a finding naming the command that would measure it.
   */
  notMeasured?: boolean;
  findings: string[];
}

/**
 * The ring's number as the reader sees it — THREE labels, never two. Mirror of
 * the CLI's `categoryScoreLabel` (src/audit-score.ts); keep them in step.
 */
export function categoryScoreLabel(c: CategoryScore): string {
  if (c.score !== null) return String(c.score);
  return c.notMeasured ? "not measured" : "n/a";
}

export interface AuditScore {
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  categories: CategoryScore[];
  empty: boolean;
  /**
   * The repo has an instruction file but NO skill, agent or command was read —
   * distinct from `empty` (nothing at all) and from a real graded harness. The
   * grade is computed over the instruction file alone, so a renderer that prints
   * the number without this qualifier repeats #240's headline: a confident A for
   * a harness the tool never saw.
   */
  instructionsOnly: boolean;
}

/** One recommendation's overall-points gain if its single fix is applied. */
export interface RecommendationPoints {
  /** Index into the `recommendations` array. */
  index: number;
  /** `overall(report − thisFinding) − overall(report)`, always ≥ 0. */
  pointsIfFixed: number;
}

/**
 * The audit verdict — a header sentence + per-recommendation `pointsIfFixed`,
 * both derived by re-scoring (mirror of the CLI's `src/audit-verdict.ts`).
 */
export interface Verdict {
  /** The header sentence — real numbers from the re-score + grade thresholds. */
  sentence: string;
  /** The current letter grade (echoed from the base score). */
  grade: "A" | "B" | "C" | "D" | "F";
  /** Points to the next-higher grade band, or null when already an A. */
  pointsToNextGrade: number | null;
  /**
   * Minimal number of deterministic fixes whose combined removal crosses the
   * next grade threshold, or null when the fix list can't close the gap / an A.
   */
  fixesToNextGrade: number | null;
  perRecommendation: RecommendationPoints[];
}

export type OptimizeAction = "fix" | "differentiate";

export interface Recommendation {
  surface: string;
  action: OptimizeAction;
  rationale: string;
  fix: string;
  detector: string;
  confidence: "likely" | "possible";
}

export interface AuditInventory {
  skills: number;
  agents: number;
  hooks: number;
  commands: number;
  mcp: boolean;
  untested: number;
  /**
   * The per-tier split behind `untested`, emitted since the Evaluated ring landed: surfaces with no
   * deterministic harness, and surfaces whose firing was never measured. Optional because a report
   * produced before the split carries neither, and the view must still render an older artifact.
   *
   * 🔴 These reached the ENGINE's inventory and not this mirror, so `sample.ts` set two fields the
   * type did not have. It went unnoticed because CI typechecks the root project and `test/types` and
   * never `-p site/tsconfig.json` — the same shape as every other defect in this PR: a check that
   * exists, passes, and does not cover the thing that broke.
   */
  untestedHarness?: number;
  unevaluated?: number;
}

export interface BrokenRef {
  kind: "enforce" | "file" | "cmd" | "dir";
  ref: string;
  issue: string;
}

export interface AdoptabilityResult {
  total: number;
  broken: number;
  brokenRefs: BrokenRef[];
}

export interface AdoptableSurface {
  path: string;
  command: string;
}

export interface Adoptable {
  surfaces: AdoptableSurface[];
  createAllCommand: string;
}

export interface LedgerDenial {
  label: string;
  reason: string;
}

export interface LedgerCount {
  kind: string;
  count: number;
}

/** The flight-recorder summary — what the harness actually did in real sessions. */
export interface LedgerSummary {
  total: number;
  counts: LedgerCount[];
  denials: number;
  recentDenials: LedgerDenial[];
}

export interface RuleInventoryItem {
  intent: string;
  linter: string;
  matched: string;
  rule: string;
  configState: "in-config" | "not-in-config" | "preset-maybe" | "contradiction";
  configFix: string;
}

export type RuleCategory = "reuse" | "hook" | "meta" | "semantic" | "unrouted";
export type RuleMechanism = "config-line" | "hook" | "prose" | "synthesize";

/** One segmented, deterministically-routed rule (mirror of the CLI's RoutedRule). */
export interface RoutedRule {
  text: string;
  quote: string;
  file?: string;
  lineStart: number;
  lineEnd: number;
  confidence: "high" | "medium";
  category: RuleCategory;
  mechanism: RuleMechanism;
  rule?: string;
  linter?: string;
  /** reuse via the dynamic catalog: whether the rule is currently ENABLED in the
   * repo's config. `false` = "documented but OFF" (the sharp finding). */
  enabled?: boolean;
  /** "marker" = an explicit `**Enforced by:**`/`**Guard:**`/`**Guidance only**`
   * marker (definitive); "heuristic" = the Tier-A segmenter. */
  source?: "marker" | "heuristic";
}

/** A bullet the segmenter did NOT treat as a rule, with the reason. */
export interface SkippedBullet {
  text: string;
  file?: string;
  lineStart: number;
  lineEnd: number;
  reason: "index" | "description" | "leadin" | "no-signal" | "section";
}

/** The deterministic State-B routing preview (mirror of the CLI's RuleRouting). */
export interface RuleRouting {
  segmented: number;
  counts: Record<RuleCategory, number>;
  rules: RoutedRule[];
  /** Rule-ish bullets below the confidence bar — surfaced for review. */
  possible?: RoutedRule[];
  /** Bullets confidently not treated as rules, each with a reason. */
  skipped?: SkippedBullet[];
}

export interface AuditReport {
  meta: {
    schemaVersion: number;
    tool: string;
    kind: "audit";
    vigilesVersion: string;
    harness: string;
    dir: string;
    generatedAt?: string;
  };
  score: AuditScore;
  /** The verdict-led header data + per-recommendation `pointsIfFixed`. */
  verdict: Verdict;
  recommendations: Recommendation[];
  inventory: AuditInventory;
  /** The concrete intra-plugin references that don't resolve — the actual paths
   *  behind the Truthfulness "N broken reference(s)" count. Present only when ≥1. */
  brokenReferences?: string[];
  /** The adoption preview — present only when the model-gated tier ran. */
  adoptability?: AdoptabilityResult;
  /**
   * Surfaces that exist but aren't spec-managed yet, each with its adopt command,
   * plus a "create all" command. Drives the "Create spec" / "Create all specs"
   * command-emit affordances. Present only when there's something to adopt.
   */
  adoptable?: Adoptable;
  /**
   * The flight-recorder summary from the local ledger (`.vigiles/runs.jsonl`) —
   * counts + recent denials of what the harness actually did. Present only when
   * something is recorded.
   */
  observations?: LedgerSummary;
  /**
   * Prose rules in the harness that map to an off-the-shelf lint rule, and
   * whether that rule is already in the config (the one-line-config-fix nudge).
   * Deterministic, no model. Present only when at least one intent resolved.
   */
  rulesInventory?: RuleInventoryItem[];
  /** The deterministic State-B routing preview — segmented rules + category counts. */
  ruleRouting?: RuleRouting;
}
