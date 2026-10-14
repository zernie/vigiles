/**
 * The `experimental` rule group's findings, as `audit` SHOWS them — the one
 * projection the terminal report, the `AuditReport` JSON and the HTML report all
 * read, so the three cannot drift on what an experimental finding says.
 *
 * WHY A SEPARATE BLOCK AND NOT THE RINGS. A rule is in the group
 * (`EXPERIMENTAL_RULES`, `core/rule-meta.ts`) because its measured precision is
 * below the bar a graded check must clear: a finding from it is as likely to be
 * a false alarm as a defect. Grading on it would let a coin flip move a repo's
 * headline. So the scan keeps the group's findings under
 * `ScanReport.experimental`, no grader reads that key, and when a repo turns a
 * rule on (`--preset=experimental`, `"extends": "vigiles:experimental"`, or the
 * rule in `rules`) `audit` lists its findings here — labelled "not graded" —
 * and nowhere that is summed.
 *
 * Node-free (type-only scan import), so the browser twin can build the same
 * report; the browser has no flag and no config, so it never enables a rule.
 */
import type { ExperimentalScanFindings, ScanReport } from "./scan.js";
import {
  EXPERIMENTAL_RULES,
  type ExperimentalRuleName,
} from "./core/rule-meta.js";
import { repoRootOnlyAdvice } from "./core/skill-resources.js";

/** One experimental finding, flat, with the sentence every surface prints. */
export interface ExperimentalFinding {
  /**
   * `finding` — what the rule reports (`✗`); `note` — informational, never
   * counted even by `lint` (`ℹ`).
   */
  readonly kind: "finding" | "note";
  /** The file the finding is in, relative to the audited directory. */
  readonly path: string;
  /** 1-based line in that file, when the rule knows it. */
  readonly line?: number;
  /** The surface the finding is about (a skill's name). */
  readonly subject: string;
  /** What is wrong and, for a note, how to cure it — one sentence. */
  readonly message: string;
}

/** One enabled experimental rule and everything it found (possibly nothing). */
export interface ExperimentalRuleResult {
  /** The rule id — a member of `EXPERIMENTAL_RULES`. */
  readonly rule: ExperimentalRuleName;
  readonly findings: readonly ExperimentalFinding[];
}

/** How each experimental rule's scan findings read as flat findings. */
const PROJECT: {
  readonly [K in ExperimentalRuleName]: (
    found: ExperimentalScanFindings[K],
  ) => readonly ExperimentalFinding[];
} = {
  "skill-resource-resolves": ({ issues, notes }) => [
    ...issues.map((s) => ({
      kind: "finding" as const,
      path: s.path,
      line: s.finding.line,
      subject: s.name,
      message: `${s.finding.ref} (line ${String(s.finding.line)}) — bundled resource not found`,
    })),
    ...notes.map((s) => ({
      kind: "note" as const,
      path: s.path,
      line: s.finding.line,
      subject: s.name,
      message: `${s.finding.ref} (line ${String(s.finding.line)}) ${repoRootOnlyAdvice(s.finding)}`,
    })),
  ],
};

/** Project one rule; a generic helper keeps the key and its shape paired. */
function project<K extends ExperimentalRuleName>(
  rule: K,
  found: Pick<ExperimentalScanFindings, K>,
): ExperimentalRuleResult {
  return { rule, findings: PROJECT[rule](found[rule]) };
}

/**
 * The findings of every ENABLED experimental rule, in the group's order — one
 * entry per enabled rule even when it found nothing, so a reader who turned the
 * group on sees that it ran. Empty when none is enabled.
 */
export function experimentalResults(
  report: Pick<ScanReport, "experimental">,
  enabled: ReadonlySet<ExperimentalRuleName>,
): readonly ExperimentalRuleResult[] {
  return EXPERIMENTAL_RULES.filter((r) => enabled.has(r)).map((r) =>
    project(r, report.experimental),
  );
}

/** The heading every surface uses for the block. */
export const EXPERIMENTAL_HEADING = "Experimental — not graded";

/** The one-line explanation under the heading, shared by text and HTML. */
export const EXPERIMENTAL_BLURB =
  "Checks vigiles ships but has not measured as reliable enough to grade you on. They never move the score.";
