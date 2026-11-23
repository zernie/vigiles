/**
 * The audit section of the GitHub Action's sticky PR comment and job summary
 * (#474): `vigiles audit --md` on one directory.
 *
 * Rendered from the versioned {@link AuditReport} — the product boundary the
 * HTML report and `--json` also render from — and never from terminal text, so
 * a change to the terminal layout cannot break the comment.
 *
 * The section carries the grade, the four graded rings (the two advisory ones
 * marked as advisory), the fixes worth the most points (from the verdict
 * engine's real re-score) or, when the report has no fix list, the graded
 * rings' own findings, everything in a collapsed list, and — on a pull request
 * — each ring's change against an `audit --json` report of the PR base. It ends
 * by saying what it is: the headless read, in which the consent-gated checks
 * did not run.
 *
 * It starts with {@link AUDIT_SUMMARY_MARKER}. The Action includes the output
 * only when the marker is there, so an older vigiles (whose single-directory
 * `--md` printed the terminal report) degrades to a one-line note instead of
 * pasting a terminal dump into the comment.
 */
import { sortBy } from "remeda";
import { AUDIT_SCHEMA_VERSION, type AuditReport } from "./audit-report.js";
import type { CategoryScore } from "./audit-score.js";
import {
  parseAuditSnapshot,
  type AuditSnapshot,
} from "./core/audit-snapshot.js";

/** The first line of every rendered section. */
export const AUDIT_SUMMARY_MARKER = "<!-- vigiles-audit-summary -->";

/** How many items the section names before the collapsed list. */
const TOP = 3;

/** How long a top-list line may get before it is cut. */
const LINE_MAX = 240;

/**
 * The most characters the section may take. It shares the Action's sticky
 * comment with the command's log, and GitHub refuses a comment over 65,536
 * characters, so a repo with thousands of findings would otherwise lose the
 * whole comment (and keep showing a stale result).
 */
export const AUDIT_SUMMARY_MAX_CHARS = 20_000;

/** Room kept for everything but the collapsed list: headline, table, top items. */
const FRAME_CHARS = 4_000;

/** The part of a base report the comparison reads. */
export type BaseScore = Pick<
  AuditSnapshot["score"],
  "overall" | "grade" | "categories"
>;

/**
 * What there is to compare against. `none`: nobody asked (not a pull request).
 * `unavailable`: a comparison was asked for and cannot be made — said in the
 * section, because a missing delta must not read as "nothing changed".
 */
export type BaseAudit =
  | { readonly kind: "none" }
  | { readonly kind: "report"; readonly score: BaseScore }
  | { readonly kind: "unavailable"; readonly why: string };

const unavailable = (why: string): BaseAudit => ({ kind: "unavailable", why });

/**
 * Read `audit --json` output of the PR base. `undefined` is a file that was
 * never written (the base could not be materialized or audited).
 */
export function parseBaseAudit(text: string | undefined): BaseAudit {
  if (text === undefined)
    return unavailable("the PR base could not be audited");
  const parsed = parseAuditSnapshot(text);
  if (parsed.kind === "not-json")
    return unavailable("the PR base audit produced no report");
  if (
    parsed.kind === "wrong-shape" ||
    parsed.snapshot.meta.kind !== "audit" ||
    parsed.snapshot.meta.schemaVersion !== AUDIT_SCHEMA_VERSION
  )
    return unavailable(
      "the PR base report is not an audit report of this version",
    );
  if (parsed.snapshot.score.empty)
    return unavailable("the PR base has no harness to audit");
  const { overall, grade, categories } = parsed.snapshot.score;
  return { kind: "report", score: { overall, grade, categories } };
}

/** ` ▲`, ` ▼`, or nothing when the two are equal or one is missing. */
function arrow(before: number | null, after: number | null): string {
  if (before === null || after === null || before === after) return "";
  return after > before ? " ▲" : " ▼";
}

/** `90 → 82 ▼`, `60 → 70 ▲`, or the plain value when nothing moved. */
function change(
  before: number | null,
  after: number | null,
  shown: string,
): string {
  if (before === after) return shown;
  const from = before === null ? "n/a" : String(before);
  return `${from} → ${shown}${arrow(before, after)}`;
}

function scoreText(c: Readonly<CategoryScore>): string {
  if (c.score !== null) return String(c.score);
  return c.notMeasured === true ? "not measured" : "n/a";
}

function ringRow(
  c: Readonly<CategoryScore>,
  base: Readonly<BaseAudit>,
): string {
  const name = c.advisory === true ? `${c.key} _(advisory)_` : c.key;
  const now = scoreText(c);
  const cell =
    base.kind === "report"
      ? change(
          base.score.categories.find((b) => b.key === c.key)?.score ?? null,
          c.score,
          now,
        )
      : now;
  return `| ${name} | ${cell} |`;
}

function headline(report: AuditReport, base: Readonly<BaseAudit>): string {
  const { grade, overall } = report.score;
  const now = `**${grade}** · ${String(overall)}/100`;
  if (base.kind !== "report") return `### vigiles audit: ${now}`;
  const b = base.score;
  if (b.overall === overall && b.grade === grade)
    return `### vigiles audit: ${now} (unchanged from the PR base)`;
  const moved = `${String(b.overall)} → ${String(overall)}${arrow(b.overall, overall)}`;
  return `### vigiles audit: ${now} (base ${b.grade} → ${grade}, ${moved})`;
}

/** Inline code that survives a backtick inside the value. */
const code = (s: string): string =>
  s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``;

/** Whitespace folded to single spaces: one finding, one list line. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Cut for the top list; a cut inside inline code closes the code span. */
function short(s: string): string {
  if (s.length <= LINE_MAX) return s;
  const cut = s.slice(0, LINE_MAX - 1);
  const unclosed = (cut.split("`").length - 1) % 2 === 1;
  return `${cut}${unclosed ? "`" : ""}…`;
}

/** The recommendations, best first, with the points each is worth. */
function rankedFixes(report: AuditReport): readonly string[] {
  const points = new Map(
    report.verdict.perRecommendation.map((p) => [p.index, p.pointsIfFixed]),
  );
  return sortBy(
    report.recommendations.map((r, i) => ({ r, p: points.get(i) ?? 0 })),
    [({ p }) => p, "desc"],
  ).map(({ r, p }) => {
    const gain = p > 0 ? ` (+${String(p)} pts)` : "";
    return `${code(r.surface)} — ${flat(r.fix)}${gain}`;
  });
}

/**
 * The graded rings' own findings, worst ring first — what the section lists
 * when the report has no deterministic fix list (a deduction such as the
 * lethal trifecta carries its fix in its own text, not as a recommendation).
 * Advisory rings never count: they are hardening advice, not what is broken.
 */
function gradedFindings(report: AuditReport): readonly string[] {
  return sortBy(
    report.score.categories.filter(
      (c) => c.advisory !== true && c.score !== null,
    ),
    (c) => c.score ?? 0,
  ).flatMap((c) => c.findings.map((f) => `**${c.key}:** ${flat(f)}`));
}

/**
 * The collapsed lines that fit in `budget` characters, best first, and a last
 * line naming how many did not.
 */
function fitted(items: readonly string[], budget: number): readonly string[] {
  const lines = items.map((f) => `- ${f}`);
  const ends = lines.reduce<readonly number[]>(
    (acc, l) => [...acc, (acc.at(-1) ?? 0) + l.length + 1],
    [],
  );
  const kept = ends.filter((end) => end <= budget).length;
  return kept === lines.length
    ? lines
    : [
        ...lines.slice(0, kept),
        `- … and ${String(lines.length - kept)} more — run \`npx vigiles audit\` locally for the full list`,
      ];
}

/** The top items numbered, then as many as fit collapsed. */
function listed(
  noun: "fixes" | "findings",
  items: readonly string[],
): readonly string[] {
  return [
    `**Top ${noun}**`,
    "",
    ...items.slice(0, TOP).map((f, i) => `${String(i + 1)}. ${short(f)}`),
    "",
    `<details><summary>All ${String(items.length)} ${noun}</summary>`,
    "",
    ...fitted(items, AUDIT_SUMMARY_MAX_CHARS - FRAME_CHARS),
    "",
    "</details>",
    "",
  ];
}

function whatToFix(report: AuditReport): readonly string[] {
  const fixes = rankedFixes(report);
  if (fixes.length > 0) return listed("fixes", fixes);
  const findings = gradedFindings(report);
  if (findings.length > 0) return listed("findings", findings);
  return ["Nothing to fix in the graded rings.", ""];
}

const HEADLESS =
  "_This is the headless audit: the checks that need your consent — starting " +
  "live MCP servers, measuring skill trigger rate, loading your ESLint config — " +
  "did not run here. `npx vigiles audit` locally can show more._";

/** The markdown section; first line {@link AUDIT_SUMMARY_MARKER}. */
export function renderAuditPrSummary(
  report: AuditReport,
  base: Readonly<BaseAudit>,
): string {
  const lines = [
    AUDIT_SUMMARY_MARKER,
    headline(report, base),
    "",
    ...(base.kind === "unavailable"
      ? [`_No comparison with the PR base: ${base.why}._`, ""]
      : []),
    base.kind === "report" ? "| Ring | Base → now |" : "| Ring | Score |",
    "| :-- | --: |",
    ...report.score.categories.map((c) => ringRow(c, base)),
    "",
    ...whatToFix(report),
    HEADLESS,
  ];
  return lines.join("\n") + "\n";
}
