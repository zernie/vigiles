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

import { unique } from "remeda";

/** A finding about one named unit (a skill, a subagent, a hook). */
export interface NamedFinding {
  readonly name: string;
  readonly message: string;
}

/** Units that share one message, in the order they were first seen. */
export interface FindingGroup {
  readonly message: string;
  readonly names: readonly string[];
}

/** How many names a line spells out before it says "+N more". */
export const NAMES_SHOWN = 5;

/**
 * Groups by exact message, keeping first-seen order for groups and for the
 * names within each, and never listing a name twice in one group.
 */
export function groupFindings(
  items: readonly NamedFinding[],
): readonly FindingGroup[] {
  return unique(items.map((i) => i.message)).map((message) => ({
    message,
    names: unique(
      items.filter((i) => i.message === message).map((i) => i.name),
    ),
  }));
}

/** The names, at most {@link NAMES_SHOWN} of them, then "+N more". */
export function namesLine(
  names: readonly string[],
  shown: number = NAMES_SHOWN,
): string {
  const rest = names.length - shown;
  return (
    names.slice(0, shown).join(", ") +
    (rest > 0 ? ` +${String(rest)} more` : "")
  );
}

/** One group as one line: `a, b, c: message`. */
export function groupLine(g: FindingGroup): string {
  return `${namesLine(g.names)}: ${g.message}`;
}
