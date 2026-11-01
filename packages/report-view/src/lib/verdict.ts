import type { Verdict } from "../schema";

type Grade = Verdict["grade"];

/** The grade one band up — the band `pointsToNextGrade` measures the gap to. */
const NEXT: Record<Grade, Grade | null> = {
  F: "D",
  D: "C",
  C: "B",
  B: "A",
  A: null,
};

/**
 * The verdict sentence as the report's headline. The engine writes some
 * sentences as "C — 1 subagent …" so the sentence stands alone in a terminal;
 * the report already shows the letter in its gauge, so that exact leading
 * "<grade> — " is dropped here. Only the verdict's own grade followed by the
 * em-dash separator is removed — a sentence that merely starts with the letter
 * is left alone.
 */
export function verdictHeadline(verdict: Verdict): string {
  const prefix = `${verdict.grade} — `;
  return verdict.sentence.startsWith(prefix)
    ? verdict.sentence.slice(prefix.length)
    : verdict.sentence;
}

/** "3 points to B", or null at an A or when the engine gave no gap. */
export function pointsToNext(verdict: Verdict): string | null {
  const next = NEXT[verdict.grade];
  const n = verdict.pointsToNextGrade;
  if (next === null || n === null || n <= 0) return null;
  return `${n} point${n === 1 ? "" : "s"} to ${next}`;
}
