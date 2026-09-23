/**
 * One `ignore` for `globSync` out of a detector's own string floor plus the
 * repository's exclude — glob takes EITHER a pattern list OR one `IgnoreLike`,
 * never both, so a detector that has both needs this union.
 *
 * 🔴 WHY THE REPO EXCLUDE ARRIVES AS AN `IgnoreLike` AND NOT AS STRINGS (#281).
 * `ExcludeSet` used to hand detectors a string list whose patterns were relative
 * to the repository root, with the precondition "only correct for a glob rooted
 * AT that root" written in a comment. Two callers globbed from a nested bundle
 * and broke it silently: a root-relative `skills/lonely` dropped
 * `plugins/p/skills/lonely`, and the real exclusion never reached the bundle.
 * `ExcludeSet.globIgnore` computes each candidate's position from the repo root
 * itself, so it is correct from ANY glob `cwd`; the string face was retired.
 *
 * A plain string list is still accepted — for a direct library caller whose
 * patterns are, by that caller's own contract, relative to the `cwd` it globs
 * from. That is the one frame a string can safely carry.
 */
import { Ignore, type IgnoreLike } from "glob";

/** What a detector takes for "also skip these". */
export type GlobIgnore = readonly string[] | IgnoreLike;

function isPatternList(x: GlobIgnore): x is readonly string[] {
  return Array.isArray(x);
}

/**
 * `floor` (patterns relative to the glob's `cwd`) plus `extra`, in the form
 * `globSync`'s `ignore` option accepts. Stays a plain list when both halves are
 * lists, so a string-only caller sees exactly the glob behaviour it always had.
 */
export function withIgnored(
  floor: readonly string[],
  extra: GlobIgnore | undefined,
): string[] | IgnoreLike {
  if (extra === undefined) return [...floor];
  if (isPatternList(extra)) return [...floor, ...extra];
  const own = new Ignore([...floor], {});
  return {
    ignored: (p) => own.ignored(p) || extra.ignored?.(p) === true,
    childrenIgnored: (p) =>
      own.childrenIgnored(p) || extra.childrenIgnored?.(p) === true,
  };
}
