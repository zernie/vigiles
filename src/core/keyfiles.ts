/**
 * `keyFiles` — DEPRECATED, removed in the major after the one that ships this
 * notice (the one-major alias window in `core/spec.ts`).
 *
 * WHY. The field compiles a flat "## Key Files" path → description list into
 * the instruction file the harness loads on EVERY request. Measured on this
 * repository's own root spec (2026-10-11): 230 entries, 45,467 characters —
 * 29% of a 157,872-character file, paid on every request, to tell an agent where files are
 * when it finds them itself with Glob/Grep. Anthropic's own guidance lists
 * "File-by-file descriptions of the codebase" under what to EXCLUDE from
 * `CLAUDE.md` (https://code.claude.com/docs/en/best-practices).
 *
 * THE REPLACEMENT, by what the pointer is for:
 * - a pointer a decision depends on → inside the rule that needs it, as a
 *   `file()` reference (verified exactly like a `keyFiles` path, by
 *   `validateFileRef`);
 * - a pointer that matters only in one folder → that folder's nested
 *   instruction file, which loads only when the agent works there;
 * - a plain directory map → usually dropped (the agent reads the code); a
 *   `README.md` when humans need one.
 *
 * This module is pure: the renderer `compile` uses, the measurement the
 * `deprecated-key-files` rule reports, and its message — one wording for lint
 * and audit.
 */

/** Where the migration is written up. Printed in every finding. */
export const KEYFILES_DOCS_URL =
  "https://github.com/zernie/vigiles/blob/main/docs/rules/deprecated-key-files.md";

/**
 * The compiled "## Key Files" section — the ONE renderer, so the size a
 * finding reports is the size of what actually loads.
 */
export function renderKeyFiles(
  keyFiles: Readonly<Record<string, string>>,
): string {
  return [
    "## Key Files",
    "",
    ...Object.entries(keyFiles).map(
      ([path, desc]) => `- \`${path}\` — ${desc}`,
    ),
  ].join("\n");
}

/**
 * What a spec's `keyFiles` costs. `measured: false` when the map is not a
 * literal (a variable, a computed key or value, a spread) — then the field is
 * known to be USED and its size is not guessed.
 */
export interface KeyFilesUsage {
  readonly entries: number;
  readonly chars: number;
  readonly measured: boolean;
}

/** Measure a map the way it compiles. */
export function measureKeyFiles(
  keyFiles: Readonly<Record<string, string>>,
): KeyFilesUsage {
  return {
    entries: Object.keys(keyFiles).length,
    chars: renderKeyFiles(keyFiles).length,
    measured: true,
  };
}

const grouped = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The cost half of a finding, e.g. `230 entries, 45,467 characters compiled into …`. */
export function keyFilesCost(u: KeyFilesUsage): string {
  if (!u.measured) return "not a literal map — size not measured";
  const noun = u.entries === 1 ? "entry" : "entries";
  return `${String(u.entries)} ${noun}, ${grouped(u.chars)} characters compiled into the instruction file`;
}

/** The fix, one sentence — shared by the lint message and the audit line. */
export const KEYFILES_FIX =
  "Remove `keyFiles` from your spec: name a file a decision depends on where " +
  "that decision is written, as a file() reference (or in that folder's own " +
  "nested instruction file), and delete the rest — the agent finds files itself";

/** The whole finding: what it costs, then what to do and where it is written up. */
export function keyFilesDeprecationMessage(u: KeyFilesUsage): string {
  return (
    `\`keyFiles\` is deprecated and goes away in the next major (${keyFilesCost(u)}). ` +
    `${KEYFILES_FIX}: ${KEYFILES_DOCS_URL}`
  );
}
