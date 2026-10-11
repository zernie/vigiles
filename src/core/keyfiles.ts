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
 * THE REPLACEMENT, decided per entry, in this order:
 * - the file's own header, the docs or the path already say it → delete it;
 * - a fact about that one file, written nowhere else → that file's header
 *   comment, where a reader meets it on opening the file;
 * - a rule an agent must follow while working in one folder → that folder's
 *   nested instruction file (`<folder>/CLAUDE.md` from its own spec), which
 *   loads only when the agent works there;
 * - only when nothing else would lead an agent to the file → a one-line
 *   `file()` pointer where the decision that needs it is written (verified
 *   exactly like a `keyFiles` path, by `validateFileRef`).
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

/**
 * The instruction file a spec compiles to — `pkg/AGENTS.md.spec.ts` →
 * `AGENTS.md` — so the fix names the nested file in the reader's own harness
 * instead of assuming one.
 */
export function instructionFileOfSpec(specPath: string): string {
  const base = specPath.split(/[\\/]/).pop() ?? specPath;
  return base.replace(/\.spec\.ts$/, "");
}

/**
 * The fix, one sentence — shared by the lint message and the audit line. The
 * four places an entry can go, in the order to try them; the full recipe is
 * the migration guide. `targets` are the instruction files the reported specs
 * compile to (`CLAUDE.md`, `AGENTS.md`), so the nested file is named for real.
 */
export function keyFilesFix(targets: readonly string[]): string {
  const nested = [...new Set(targets)]
    .sort()
    .map((t) => `<folder>/${t}`)
    .join(" or ");
  return (
    "For each entry: delete it if the file or the docs already say it · " +
    "move a fact about one file into that file's header comment · " +
    `move a rule for one folder into ${nested} · ` +
    "keep a one-line file() pointer only if nothing else leads there"
  );
}

/** The whole finding: what it costs, then where each entry goes and where it is written up. */
export function keyFilesDeprecationMessage(
  u: KeyFilesUsage,
  target: string,
): string {
  return (
    `\`keyFiles\` is deprecated and goes away in the next major (${keyFilesCost(u)}). ` +
    `${keyFilesFix([target])} (guide: ${KEYFILES_DOCS_URL})`
  );
}
