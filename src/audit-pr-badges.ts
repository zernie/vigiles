/**
 * The rings of the audit PR comment as shields.io badges, and the change
 * against the PR base each one shows. Pure: ring scores in, markdown out.
 * Split from `./audit-pr-summary.ts`, which lays out the rest of the section.
 */
import type { CategoryScore } from "./audit-score.js";
import { gradeFor } from "./score-core.js";

/**
 * The PR base's ring scores, as its parsed `audit --json` holds them (a key is
 * any string there); `undefined` when there is no base report.
 */
export type BaseRings = readonly {
  readonly key: string;
  readonly score: number | null;
}[];

/** ` ▲`, ` ▼`, or nothing when the two are equal or one is missing. */
export function arrow(before: number | null, after: number | null): string {
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

/** shields.io colours by grade band: the same A–F bands the headline uses. */
const BAND_COLOUR = {
  A: "brightgreen",
  B: "green",
  C: "yellow",
  D: "orange",
  F: "red",
} as const;

/**
 * Text for a shields.io static-badge path segment: `-` and `_` doubled, then
 * URL-encoded, parentheses too, so the markdown image link stays one token.
 */
const shieldsText = (s: string): string =>
  encodeURIComponent(s.replaceAll("-", "--").replaceAll("_", "__"))
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");

/**
 * One ring as a coloured badge. The alt text carries the plain value, so a
 * reader without images (an email notification, a screen reader) reads the
 * same `Safety: 90 → 82 ▼` the badge shows. Advisory and unscored rings are
 * grey: they are not graded, so they get no band colour.
 */
function ringBadge(
  c: Readonly<CategoryScore>,
  base: BaseRings | undefined,
): string {
  const name = c.advisory === true ? `${c.key} (advisory)` : c.key;
  const now = scoreText(c);
  const value =
    base === undefined
      ? now
      : change(base.find((b) => b.key === c.key)?.score ?? null, c.score, now);
  const colour =
    c.score === null || c.advisory === true
      ? "lightgrey"
      : BAND_COLOUR[gradeFor(c.score)];
  return `![${name}: ${value}](https://img.shields.io/badge/${shieldsText(name)}-${shieldsText(value)}-${colour})`;
}

/** The graded rings on one line, the advisory ones on the next. */
export function ringBadges(
  categories: readonly CategoryScore[],
  base: BaseRings | undefined,
): readonly string[] {
  const row = (advisory: boolean): string =>
    categories
      .filter((c) => (c.advisory === true) === advisory)
      .map((c) => ringBadge(c, base))
      .join(" ");
  return [row(false), "", row(true)];
}
