/**
 * Group identical findings, so a report says one thing once.
 *
 * A detector writes each finding's `message` WITHOUT the unit's name, as the
 * problem and its fix. Units in the same state therefore carry the same message,
 * and that message is the group's key: five skills that pre-approve `Bash` are
 * one line naming five skills, not five copies of one sentence.
 *
 * Every report a person reads (the terminal audit, the Safety ring that feeds
 * the PR comment and the HTML report) groups through this one function, so
 * they cannot disagree about what is "the same finding". `vigiles lint` does
 * NOT group: it is the gate an author fixes file by file, one line per finding
 * like any linter. The `tidy-output` rule is the policy; this is its
 * mechanism. Pure.
 */

import { unique, uniqueBy } from "remeda";

/** A finding about one named unit (a skill, a subagent, a hook), in two parts. */
export interface NamedFinding {
  readonly name: string;
  /** What is wrong, without the unit's name. */
  readonly problem: string;
  /** The one edit that fixes it. */
  readonly edit: string;
}

/** Units that share one problem and one edit, in the order they were first seen. */
export interface FindingGroup {
  readonly problem: string;
  readonly edit: string;
  readonly names: readonly string[];
}

/** How many names a line spells out before it says "+N more". */
export const NAMES_SHOWN = 5;

const keyOf = (f: { readonly problem: string; readonly edit: string }) =>
  JSON.stringify([f.problem, f.edit]);

/**
 * Groups by exact problem AND edit, keeping first-seen order for groups and
 * for the names within each, and never listing a name twice in one group.
 */
export function groupFindings(
  items: readonly NamedFinding[],
): readonly FindingGroup[] {
  return uniqueBy(items, keyOf).map((first) => ({
    problem: first.problem,
    edit: first.edit,
    names: unique(
      items.filter((i) => keyOf(i) === keyOf(first)).map((i) => i.name),
    ),
  }));
}

/** The names, at most `shown` of them, then "+N more". */
export function namesLine(
  names: readonly string[],
  separator = ", ",
  shown = NAMES_SHOWN,
): string {
  const rest = names.length - shown;
  return (
    names.slice(0, shown).join(separator) +
    (rest > 0 ? ` +${String(rest)} more` : "")
  );
}

/**
 * One group as one line: `a, b, c: problem → edit` — for a surface that
 * prints a finding as one string (`CategoryScore.findings`, the JSON report).
 * A surface that can lay the parts out (the terminal, the PR comment) reads
 * the {@link FindingGroup} itself.
 */
export function groupLine(g: FindingGroup): string {
  return `${namesLine(g.names)}: ${g.problem} → ${g.edit}`;
}
