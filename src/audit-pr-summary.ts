/**
 * The audit section of the GitHub Action's sticky PR comment and job summary
 * (#474): `vigiles audit --md` on one directory.
 *
 * Rendered from the versioned {@link AuditReport} — the product boundary the
 * HTML report and `--json` also render from — and never from terminal text, so
 * a change to the terminal layout cannot break the comment.
 *
 * The section carries the grade, the four graded rings as coloured badges (the
 * two advisory ones grey, on their own line), the fixes worth the most points (from the verdict
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
  groupLine,
  namesLine,
  type FindingGroup,
} from "./core/finding-groups.js";
import {
  parseAuditSnapshot,
  type AuditSnapshot,
} from "./core/audit-snapshot.js";
import { arrow, ringBadges } from "./audit-pr-badges.js";

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
 * Read `audit --format=json` output of the base. `undefined` is output that
 * never came (the audit of the base copy printed nothing).
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

/** A ring's sign in the comment: a glance tells which ring a finding is about. */
const RING_EMOJI: Readonly<Record<CategoryScore["key"], string>> = {
  Truthfulness: "🔎",
  Triggering: "🎯",
  Structure: "🧱",
  Safety: "🛡️",
  Tested: "🧪",
  Evaluated: "📏",
};

/**
 * A group as three short lines: the problem, the edit, the units it applies
 * to — instead of one sentence that runs all three together (`tidy-output`).
 */
const groupChunk = (g: FindingGroup): string =>
  [
    `⚠️ ${flat(g.problem)}<br>`,
    `👉 ${flat(g.edit)}<br>`,
    `<sub>${namesLine(g.names, " · ")}</sub>`,
  ].join("\n");

/**
 * One ring's findings as markdown chunks: a header carrying the ring's first
 * ungrouped finding, its other ungrouped findings as bullets, then each group.
 */
function ringChunks(c: Readonly<CategoryScore>): readonly string[] {
  const groups = c.groups ?? [];
  const grouped = new Set(groups.map(groupLine));
  const ungrouped = c.findings.filter((f) => !grouped.has(f)).map(flat);
  const title = `${RING_EMOJI[c.key]} **${c.key}**`;
  return [
    [title, ...ungrouped.slice(0, 1)].join(" · "),
    ...ungrouped.slice(1).map((f) => `- ${f}`),
    ...groups.map(groupChunk),
  ];
}

/**
 * The graded rings' own findings, worst ring first — what the section shows
 * when the report has no deterministic fix list (a deduction such as the
 * lethal trifecta carries its fix in its own text, not as a recommendation).
 * Advisory rings never count: they are hardening advice, not what is broken.
 */
function gradedFindings(report: AuditReport): readonly string[] {
  return sortBy(
    report.score.categories.filter(
      (c) => c.advisory !== true && c.score !== null && c.findings.length > 0,
    ),
    (c) => c.score ?? 0,
  ).flatMap(ringChunks);
}

/** How many finding chunks show before the rest fold away. */
const SHOWN_CHUNKS = 6;

/**
 * The chunks, the first few shown and the rest folded, cut to the budget with
 * a last line naming how many did not fit.
 */
function chunked(chunks: readonly string[]): readonly string[] {
  const folded = chunks.slice(SHOWN_CHUNKS);
  return [
    "**Findings**",
    "",
    ...chunks.slice(0, SHOWN_CHUNKS).flatMap((c) => [c, ""]),
    ...(folded.length === 0 ? [] : foldedChunks(folded)),
  ];
}

/**
 * The chunks past the first few, in a collapsed block, as many as fit the
 * budget and then a line naming how many did not.
 */
function foldedChunks(folded: readonly string[]): readonly string[] {
  const budget = AUDIT_SUMMARY_MAX_CHARS - FRAME_CHARS;
  const ends = folded.reduce<readonly number[]>(
    (acc, c) => [...acc, (acc.at(-1) ?? 0) + c.length + 2],
    [],
  );
  const kept = folded.slice(0, ends.filter((end) => end <= budget).length);
  const cut = folded.length - kept.length;
  return [
    `<details><summary>${String(folded.length)} more</summary>`,
    "",
    ...kept.flatMap((c) => [c, ""]),
    ...(cut > 0
      ? [
          `… and ${String(cut)} more — run \`npx vigiles audit\` locally for the full list`,
          "",
        ]
      : []),
    "</details>",
    "",
  ];
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

/**
 * The top items numbered, then as many as fit collapsed. When the top already
 * shows every item, it shows them whole and folds nothing: the same lines twice
 * is noise (`tidy-output`).
 */
function listed(items: readonly string[]): readonly string[] {
  if (items.length <= TOP)
    return [
      "**Fixes**",
      "",
      ...items.map((f, i) => `${String(i + 1)}. ${f}`),
      "",
    ];
  return [
    "**Top fixes**",
    "",
    ...items.slice(0, TOP).map((f, i) => `${String(i + 1)}. ${short(f)}`),
    "",
    `<details><summary>All ${String(items.length)} fixes</summary>`,
    "",
    ...fitted(items, AUDIT_SUMMARY_MAX_CHARS - FRAME_CHARS),
    "",
    "</details>",
    "",
  ];
}

function whatToFix(report: AuditReport): readonly string[] {
  const fixes = rankedFixes(report);
  if (fixes.length > 0) return listed(fixes);
  const findings = gradedFindings(report);
  if (findings.length > 0) return chunked(findings);
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
    ...ringBadges(
      report.score.categories,
      base.kind === "report" ? base.score.categories : undefined,
    ),
    "",
    ...whatToFix(report),
    HEADLESS,
  ];
  return lines.join("\n") + "\n";
}
