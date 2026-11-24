// @ts-check
/**
 * The shrink-only half of `eslint-suppressions.json`.
 *
 * ESLint keeps the file honest in one direction: a suppression nothing needs any
 * more fails lint until it is pruned. It cannot see the other direction: anyone
 * can run `eslint --suppress-all` and hide a new violation behind a higher count.
 * Only the base branch's copy can say what was grandfathered before, so this
 * compares the two. A growth a PR means (a new rule turned on, a file moved) is
 * declared with a `Suppressions-Grow: <reason>` trailer on one of its commits.
 */

/** @typedef {Record<string, Record<string, { count: number }>>} Suppressions */
/** @typedef {{ file: string, rule: string, before: number, after: number }} Growth */
/** @typedef {{ file: string, before: number, after: number }} Touched */

/** The commit trailer that declares a deliberate growth. */
export const GROW_TRAILER = "Suppressions-Grow";

/**
 * Every file + rule whose count is higher at `head` than at `base`. A key new
 * at `head` counts from zero, so a moved file reads as growth and needs the
 * trailer too.
 *
 * @param {Suppressions} base
 * @param {Suppressions} head
 * @returns {Growth[]}
 */
export function suppressionGrowth(base, head) {
  return Object.entries(head).flatMap(([file, rules]) =>
    Object.entries(rules).flatMap(([rule, { count }]) => {
      const before = base[file]?.[rule]?.count ?? 0;
      return count > before ? [{ file, rule, before, after: count }] : [];
    }),
  );
}

/**
 * @param {Suppressions} s
 * @param {string} file
 */
const fileTotal = (s, file) =>
  Object.values(s[file] ?? {}).reduce((n, r) => n + r.count, 0);

/**
 * For each file a change touched that has suppressions on either side: its
 * total before and after, so a reviewer sees whether the change left the
 * file better than it found it.
 *
 * @param {Suppressions} base
 * @param {Suppressions} head
 * @param {readonly string[]} touched
 * @returns {Touched[]}
 */
export function touchedFiles(base, head, touched) {
  return touched
    .map((file) => ({
      file,
      before: fileTotal(base, file),
      after: fileTotal(head, file),
    }))
    .filter((t) => t.before + t.after > 0);
}

/**
 * The declared reasons: the non-empty values of the trailer, one per line of
 * `git log --format=%(trailers:key=…,valueonly)`.
 *
 * @param {string} trailerLog
 * @returns {string[]}
 */
export const growthReasons = (trailerLog) =>
  trailerLog
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
