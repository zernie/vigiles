/**
 * Score → band → Tailwind utility classes. Class names are LITERAL (not built by
 * string concat) so Tailwind's JIT detects and emits them. The band colors are
 * registered as theme colors in theme.css (`--color-good/warn/bad/na` for fills,
 * `--color-*-ink` for text), so these are first-class Tailwind utilities — no
 * inline styles, no arbitrary `[var()]`.
 */
export type Band = "good" | "warn" | "bad" | "na";

export function band(score: number | null): Band {
  if (score === null) return "na";
  if (score >= 90) return "good";
  if (score >= 70) return "warn";
  return "bad";
}

/** Text in a band colour — the INK token, which passes 4.5:1 where the fill
 *  colour (rings, bars) does not. Never use a fill class for text. */
export const TEXT: Record<Band, string> = {
  good: "text-good-ink",
  warn: "text-warn-ink",
  bad: "text-bad-ink",
  na: "text-na-ink",
};
export const BG: Record<Band, string> = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  na: "bg-na",
};
export const STROKE: Record<Band, string> = {
  good: "stroke-good",
  warn: "stroke-warn",
  bad: "stroke-bad",
  na: "stroke-na",
};
/** Full (all-sides) band border — literal class names so the JIT emits them. */
export const BORDER: Record<Band, string> = {
  good: "border-good",
  warn: "border-warn",
  bad: "border-bad",
  na: "border-na",
};
