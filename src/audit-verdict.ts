/**
 * The audit VERDICT engine — a header sentence + per-recommendation `pointsIfFixed`,
 * both derived by RE-SCORING, never by a hardcoded template with a fake number.
 *
 * The audit scorer ({@link auditScore}) is pure and deterministic: `overall` is
 * `100 − Σ(graded penalties)` (clamped to [0,100]) and the letter grade comes from
 * fixed thresholds (A ≥90 … F <60). Because it's pure, we can answer two "what if"
 * questions by RUNNING it again with a single recommendation's finding(s) removed
 * and diffing the `overall`:
 *
 *   1. `pointsIfFixed` per recommendation — the exact number of overall points the
 *      grade gains if THAT one fix is applied (so a fix card can show `+N pts` and
 *      sort by it). Computed as `overall(report − thisFinding) − overall(report)`.
 *   2. A verdict `sentence` for the report header — e.g. "Two fixes away
 *      from an A." — where the COUNT is the minimal number of fixes whose COMBINED
 *      removal actually crosses the next grade threshold (a real cumulative
 *      re-score), and `pointsToNextGrade` is the real threshold gap.
 *
 * Every recommendation maps 1:1 to exactly one graded finding (see `optimize` /
 * `explainScore`): each is a single deduction of a known weight, so removing it
 * lowers the penalty by that weight (modulo the [0,100] clamp). We remove the
 * finding by its detector + content (matched against the given recommendation),
 * NOT by reproducing `explainScore`'s ordering — so this stays aligned with the
 * `recommendations` array the caller passes, by index.
 *
 * Pure over its inputs (the same pieces `buildAuditReport` already has): no fs, no
 * clock, no model, no mutation of the caller's report.
 *
 * LIMITATION (documented, not fabricated): some graded penalties have NO
 * corresponding recommendation (a hard lethal-trifecta contract, an MCP server
 * that can't start, a `disallowedTools` typo, an invalid model/color, unresolved
 * skill resources, an invisible skill, a misplaced plugin dir, an ineffective /
 * never-firing hook). Those cannot be "fixed" through a recommendation here, so
 * they never contribute to `pointsIfFixed` and can make `fixesToNextGrade` null
 * (the gap can't be closed by the deterministic fix list alone) — in which case
 * the verdict leads with the dominant blocking finding instead. The
 * fixes-to-next-grade count uses a greedy largest-delta-first ordering; that is
 * provably minimal when penalties are additive (the common case, away from the
 * score-0 clamp) and a close upper bound otherwise.
 */

import { auditScore, type AuditScore } from "./audit-score.js";
import type { Recommendation } from "./optimize.js";
import { gradeFor, reportDeductions, type PluginScore } from "./score-core.js";
import type { ScanReport, ScanAgent, ScanSkill, ScanHook } from "./scan.js";
import type { GradedView } from "./core/apply-rules.js";

/**
 * The inputs the verdict needs — exactly the pieces {@link buildAuditReport}
 * already holds. `score` is the authoritative base (`overall` + `grade`) the
 * report displays; `report` is re-scored with a finding removed to diff against
 * it; `recommendations` is the array whose indices `perRecommendation` aligns to.
 */
export interface VerdictInput {
  /** The graded view: an ungraded group's findings never reach the verdict. */
  readonly report: GradedView<ScanReport>;
  readonly score: AuditScore;
  readonly recommendations: readonly Recommendation[];
}

/** One recommendation's overall-points gain if its single fix is applied. */
export interface RecommendationPoints {
  /** Index into the input `recommendations` array. */
  readonly index: number;
  /**
   * `overall(report − thisFinding) − overall(report)` — always ≥ 0 (removing a
   * penalty can only raise or hold the score). Can be 0 when the score is clamped
   * at 0 (removing one weight still leaves the penalty ≥ 100).
   */
  readonly pointsIfFixed: number;
}

export interface Verdict {
  /** The header sentence — real numbers from the re-score + grade thresholds. */
  readonly sentence: string;
  /** The current letter grade (echoed from the base score). */
  readonly grade: PluginScore["grade"];
  /** Points to the next-higher grade band, or null when already an A. */
  readonly pointsToNextGrade: number | null;
  /**
   * The minimal number of deterministic fixes whose COMBINED removal crosses the
   * next grade threshold (real cumulative re-score, greedy largest-delta-first),
   * or null when the deterministic fix list can't close the gap (non-recommendation
   * penalties dominate) or the grade is already an A.
   */
  readonly fixesToNextGrade: number | null;
  readonly perRecommendation: readonly RecommendationPoints[];
}

// The grade-band FLOORS (A ≥90 … D ≥60; below 60 is F), mirroring gradeFor.
const GRADE_FLOORS = [60, 70, 80, 90] as const;

/** The smallest band floor strictly above `overall`, or null when already an A. */
function nextGradeFloor(overall: number): number | null {
  for (const floor of GRADE_FLOORS) {
    if (overall < floor) return floor;
  }
  return null;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

/** Small counts read as words ("two"); larger ones fall back to digits. */
function numberWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Resolve the scorer's terse "thing(s)" plural placeholder against a count —
 * mirrors audit-score's `pluralizeLabel` so the verdict sentence reads "1 unit"
 * / "3 units", never "1 unit(s)". */
function pluralizeLabel(n: number, label: string): string {
  return label.replace(/\(s\)/g, n === 1 ? "" : "s");
}

function fixNoun(n: number): string {
  return n === 1 ? "fix" : "fixes";
}

function article(grade: string): string {
  return grade === "A" ? "an" : "a";
}

/** Remove the FIRST array element matching `pred`; returns a new array (or the
 * same reference when nothing matches, so unrelated re-scores are byte-identical). */
function removeFirst<T>(
  arr: readonly T[],
  pred: (t: T) => boolean,
): readonly T[] {
  const i = arr.findIndex(pred);
  if (i < 0) return arr;
  return [...arr.slice(0, i), ...arr.slice(i + 1)];
}

/**
 * Remove the first agent-issue the `pick` callback rewrites (it returns the
 * rewritten agent, or null when this agent has no matching issue). Stops after the
 * first hit so exactly one graded unit is dropped per call.
 */
function removeAgentIssue(
  report: ScanReport,
  agentName: string,
  pick: (a: ScanAgent) => ScanAgent | null,
): ScanReport {
  let done = false;
  const agents = report.agents.map((a): ScanAgent => {
    if (done || a.name !== agentName) return a;
    const next = pick(a);
    if (next !== null) {
      done = true;
      return next;
    }
    return a;
  });
  return done ? { ...report, agents } : report;
}

/**
 * Return a copy of `report` with the SINGLE finding behind `rec` neutralized —
 * matched by the recommendation's detector + its content (surface / rationale),
 * so it stays aligned with the caller's recommendation, not with `explainScore`'s
 * internal ordering. Each removal reduces exactly one graded penalty unit; an
 * unrecognized detector is a no-op (returns the report unchanged), so its
 * `pointsIfFixed` is an honest 0 rather than a fabricated number.
 */
function withFindingRemoved(
  report: ScanReport,
  rec: Recommendation,
): ScanReport {
  switch (rec.detector) {
    case "description-overlap": {
      // surface is the "a ↔ b" pair; drop that overlap (feeds the W_OVERLAP count).
      const descriptionOverlaps = removeFirst(
        report.descriptionOverlaps,
        (o) => `${o.a} ↔ ${o.b}` === rec.surface,
      );
      return { ...report, descriptionOverlaps };
    }
    case "skill-frontmatter": {
      // Flip the matched skill's hasDescription — the only field the noDesc penalty
      // reads — without dropping the skill (keeps Safety's assessable count intact).
      let flipped = false;
      const skills = report.skills.map((s): ScanSkill => {
        if (!flipped && s.name === rec.surface && !s.hasDescription) {
          flipped = true;
          return { ...s, hasDescription: true };
        }
        return s;
      });
      return flipped ? { ...report, skills } : report;
    }
    case "subagent-tool-contract":
      return removeAgentIssue(report, rec.surface, (a) => {
        const toolIssues = removeFirst(
          a.toolIssues,
          (t) => t.message === rec.rationale,
        );
        return toolIssues !== a.toolIssues ? { ...a, toolIssues } : null;
      });
    case "mcp-tool-resolves":
      return removeAgentIssue(report, rec.surface, (a) => {
        const mcpToolIssues = removeFirst(
          a.mcpToolIssues,
          (m) => m.message === rec.rationale,
        );
        return mcpToolIssues !== a.mcpToolIssues
          ? { ...a, mcpToolIssues }
          : null;
      });
    case "hook-events": {
      const hookEventIssues = removeFirst(
        report.hookEventIssues,
        (h) => h.message === rec.rationale,
      );
      return hookEventIssues !== report.hookEventIssues
        ? { ...report, hookEventIssues }
        : report;
    }
    case "hook-script-exists": {
      // Flip the matched missing hook to "ok" (the missingHooks penalty reads status).
      let flipped = false;
      const hooks = report.hooks.map((h): ScanHook => {
        if (!flipped && h.script === rec.surface && h.status === "missing") {
          flipped = true;
          return { ...h, status: "ok" };
        }
        return h;
      });
      return flipped ? { ...report, hooks } : report;
    }
    case "subagent-frontmatter": {
      const frontmatterIssues = removeFirst(
        report.frontmatterIssues,
        (f) => f.kind === "agent" && f.path === rec.surface,
      );
      return frontmatterIssues !== report.frontmatterIssues
        ? { ...report, frontmatterIssues }
        : report;
    }
    default:
      // Unknown detector — can't map it to a graded finding; no-op (honest 0 delta).
      return report;
  }
}

/** Re-score `report` with EVERY listed recommendation's finding removed at once. */
function overallWithout(
  report: ScanReport,
  recs: readonly Recommendation[],
): number {
  let cur = report;
  for (const rec of recs) cur = withFindingRemoved(cur, rec);
  return auditScore(cur).overall;
}

/**
 * The single largest blocking deduction (max `n × weight`, `n > 0`), for the
 * issue-forward verdict when the fix list can't close the grade gap. Tie-break by
 * heavier per-item weight, then the report's own deduction order.
 */
function dominantDeduction(
  report: ScanReport,
): { n: number; label: string } | null {
  let best: { n: number; label: string; cost: number; weight: number } | null =
    null;
  for (const d of reportDeductions(report)) {
    if (d.n <= 0) continue;
    const cost = d.n * d.weight;
    if (
      best === null ||
      cost > best.cost ||
      (cost === best.cost && d.weight > best.weight)
    ) {
      best = { n: d.n, label: d.label, cost, weight: d.weight };
    }
  }
  return best ? { n: best.n, label: best.label } : null;
}

/**
 * Minimal number of fixes whose COMBINED removal reaches `targetOverall`, applying
 * recommendations largest-`pointsIfFixed`-first (index-asc tie-break) and
 * re-scoring the growing set each step. Provably minimal when penalties are
 * additive (away from the score-0 clamp); a tight upper bound otherwise. Null when
 * removing every recommendation still doesn't reach the target.
 */
function fixesToReach(
  report: ScanReport,
  recommendations: readonly Recommendation[],
  perRec: readonly RecommendationPoints[],
  targetOverall: number,
): number | null {
  const order = [...perRec].sort(
    (a, b) => b.pointsIfFixed - a.pointsIfFixed || a.index - b.index,
  );
  const chosen: Recommendation[] = [];
  for (const p of order) {
    chosen.push(recommendations[p.index]);
    if (overallWithout(report, chosen) >= targetOverall) return chosen.length;
  }
  return null;
}

function buildSentence(
  input: VerdictInput,
  pointsToNextGrade: number | null,
  fixesToNextGrade: number | null,
): string {
  const { score, recommendations, report } = input;
  if (score.empty) {
    return "No loadable harness surface — nothing to grade yet.";
  }
  // Already an A: nothing is BLOCKING the grade — but "A" is not "flawless". Only
  // claim "clean" at a real 100 (zero graded deductions); when graded findings
  // pulled the score below 100, name them so the verdict never contradicts a
  // finding the report shows (the superpowers "92 but structurally clean" bug).
  if (pointsToNextGrade === null) {
    if (score.overall === 100) {
      return "A — clean. Nothing blocking, nothing flagged.";
    }
    if (recommendations.length > 0) {
      const n = recommendations.length;
      return `A — nothing blocks the grade; ${numberWord(n)} deterministic ${fixNoun(
        n,
      )} would harden it further.`;
    }
    // Graded findings, but no auto-fix maps to them — name the dominant one so an
    // A never reads as flawless while the report shows a real finding.
    const dom = dominantDeduction(report);
    if (dom !== null) {
      return `A — nothing blocks the grade, but ${String(dom.n)} ${pluralizeLabel(
        dom.n,
        dom.label,
      )} ${dom.n === 1 ? "is" : "are"} flagged — worth fixing.`;
    }
    return "A — nothing blocks the grade.";
  }
  // The next band's grade is gradeFor(its FLOOR); the floor is base + the gap.
  const nextGrade = gradeFor(score.overall + pointsToNextGrade);
  // Reachable by the deterministic fix list: fix-count-forward (the actionable framing).
  if (fixesToNextGrade !== null) {
    return `${capitalize(numberWord(fixesToNextGrade))} ${fixNoun(
      fixesToNextGrade,
    )} away from ${article(nextGrade)} ${nextGrade}.`;
  }
  // Not reachable by recommendations alone — lead with the dominant blocking finding.
  const dom = dominantDeduction(report);
  if (dom === null) {
    return `${score.grade} — ${String(
      pointsToNextGrade,
    )} points below ${article(nextGrade)} ${nextGrade}.`;
  }
  return `${score.grade} — ${String(dom.n)} ${pluralizeLabel(
    dom.n,
    dom.label,
  )}; fixing every deterministic finding still lands below ${article(
    nextGrade,
  )} ${nextGrade}.`;
}

/**
 * Compute the audit verdict + per-recommendation `pointsIfFixed` by re-scoring.
 * Pure and deterministic over its inputs. `perRecommendation` is index-aligned to
 * the input `recommendations`.
 */
export function computeVerdict(input: VerdictInput): Verdict {
  const { report, score, recommendations } = input;
  const base = score.overall;

  const perRecommendation: RecommendationPoints[] = recommendations.map(
    (rec, index) => {
      const after = auditScore(withFindingRemoved(report, rec)).overall;
      // Removing a penalty can only raise or hold the score; clamp negatives to 0
      // to defend against any future non-monotonic scorer change.
      return { index, pointsIfFixed: Math.max(0, after - base) };
    },
  );

  const nextFloor = nextGradeFloor(base);
  const pointsToNextGrade = nextFloor === null ? null : nextFloor - base;
  const fixesToNextGrade =
    nextFloor === null
      ? null
      : fixesToReach(report, recommendations, perRecommendation, nextFloor);

  const sentence = buildSentence(input, pointsToNextGrade, fixesToNextGrade);

  return {
    sentence,
    grade: score.grade,
    pointsToNextGrade,
    fixesToNextGrade,
    perRecommendation,
  };
}
