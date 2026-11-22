/**
 * THE REPOSITORY'S PATH LIST — what exists, as an exact, case-sensitive list,
 * so the reference graph (`./reference-graph.ts`) answers "does this path
 * exist?" by looking it up rather than by asking a filesystem.
 *
 * WHY A LIST AND NOT `existsSync`. On a case-insensitive disk (the macOS
 * default) `existsSync("agents.md")` is true for `AGENTS.md`, so a wrong-case
 * reference resolved on a Mac and broke on Linux CI. And the browser engine
 * knows existence only from the GitHub tree, which is a list: two engines, one
 * question, one way to answer it.
 *
 * Three producers: the disk (`src/host/repo-tree.io.ts`, `git ls-files`), the
 * browser (the GitHub tree the fetcher already has), and a test's file map
 * ({@link repoTreeOf} over its keys). Pure; no adapter fact.
 */

/** Every path of a scanned directory, relative to it, POSIX. */
export interface RepoTree {
  /** Files (and symlinks), exact case. A directory is any proper prefix. */
  readonly paths: ReadonlySet<string>;
  /** Submodule roots: their contents are not in this tree. */
  readonly submodules: ReadonlySet<string>;
}

/** A tree of these paths (and submodule roots). */
export function repoTreeOf(
  paths: Iterable<string>,
  submodules: Iterable<string> = [],
): RepoTree {
  return { paths: new Set(paths), submodules: new Set(submodules) };
}
