/**
 * The frame of a path — WHICH DIRECTORY it is relative to — named by its TYPE
 * rather than by a comment (#281).
 *
 * 🔴 WHY THIS EXISTS. Every path the CLI handled was a bare `string`, so a path
 * relative to a nested bundle, one relative to the repository and an absolute one
 * were the same type, and nothing stopped a caller from printing the wrong one.
 * `overBundles` handed each check ONE `root: string` that had to be the discovery
 * base, the base of the config's globs AND the frame of every printed path at
 * once. Under `bundles: "all"` that root was the nested bundle, so `include`
 * resolved from the wrong directory and `::warning file=skills/x/SKILL.md` named a
 * file that did not exist from where the command ran — while a root-bundle skill
 * of the same name made the annotation land on the WRONG real file, which looks
 * like success.
 *
 * Three frames, two of them branded:
 *   - {@link RepoPath} — relative to {@link Frame.root}, the directory whose
 *     `.vigilesrc.json` governs the run. Every printed or annotated path.
 *   - {@link BundlePath} — relative to one {@link Bundle}'s own directory. What a
 *     per-bundle scan reports.
 *   - an absolute path — a plain `string`, the only thing the filesystem takes.
 *
 * The brand is `Opaque` from `ts-essentials` (a `unique symbol` key, so no object
 * literal can forge it), imported as a TYPE ONLY: nothing of it survives the
 * build. It must not reach a public `.d.ts` either — this module is internal and
 * the API report (`api-surface/*.api.md`) is the gate that would show a leak.
 *
 * 🔴 THE ONE CONVERSION POINT. A `RepoPath` is minted here and nowhere else:
 * {@link Frame.repo} from an absolute path, {@link Bundle.path} from a
 * `BundlePath`. A cast to `RepoPath` outside this file is refused by ESLint
 * (`no-restricted-syntax` in `eslint.config.mjs`), so "where did this path get its
 * frame" always has the answer "in frame.ts".
 *
 * WHAT IS UNREPRESENTABLE AND WHAT IS ONLY DETECTABLE. The CLI's output boundary
 * (`ghAnnotate`, the per-bundle check context) takes `RepoPath`, so handing it a
 * bundle-relative or absolute string is a tsc error. Upstream of that, scan-core
 * keeps reporting plain bundle-relative strings, because its browser twin
 * (`scan-files.ts`) shares those shapes and has no filesystem to have a frame
 * over. {@link Bundle.scanned} is the seam where such a string gets its frame;
 * a relative string that is secretly repo-relative still passes it, and that
 * residue is caught by tests, not by the compiler.
 *
 * NODE-FREE: path ops come from `../posix-path.js`, and the caller supplies the
 * working directory, so this module has no process state of its own.
 */
import type { Opaque } from "ts-essentials";

import { isAbsolute, join, normalize, relative } from "../posix-path.js";

/** A `/`-separated path relative to {@link Frame.root}. `.` is the root itself. */
export type RepoPath = Opaque<string, "RepoPath">;

/** A `/`-separated path relative to one {@link Bundle}'s own directory. */
export type BundlePath = Opaque<string, "BundlePath">;

/** One scored directory: the lint target itself, or a nested plugin bundle. */
export interface Bundle {
  /** Absolute directory of the bundle. */
  readonly abs: string;
  /** Where the bundle sits, from the frame root (`.` when it IS the root). */
  readonly at: RepoPath;
  /** A path this bundle's scan reported, re-expressed from the frame root. */
  path(p: BundlePath): RepoPath;
  /**
   * The seam for scan-core's plain strings, which are bundle-relative by
   * contract (see the header). An ABSOLUTE string is accepted too and converted
   * directly — `hook-block-ineffective` reports its script that way.
   */
  scanned(p: string): RepoPath;
}

/** The single owner of "relative to which directory", built once per command. */
export interface Frame {
  /** Absolute directory every {@link RepoPath} is relative to. */
  readonly root: string;
  /** The one conversion from an absolute path. Throws on a relative input. */
  repo(abs: string): RepoPath;
  /** Describe the bundle at an absolute directory, in this frame. */
  bundle(abs: string): Bundle;
}

/** `rel` is `abs`'s position below `root` when it does not climb out. */
function isBelow(rel: string): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

/**
 * The frame for a command run from `cwd` against `target` (absolute).
 *
 * The root is `cwd` — where `loadConfig()` read `.vigilesrc.json` (it does not
 * walk up; measured 2026-09-23) — UNLESS the target lies outside it. A foreign
 * target (`vigiles lint ../other`) is somebody else's repository, and its paths
 * mean something from ITS root; relative to `cwd` they would all start with
 * `../`, and a foreign lint must never let the caller's own files satisfy the
 * target's `sharedDirs` references. That exception was `sharedDirsRootFor` in
 * the CLI, applied to `sharedDirs` alone; it is owned here now, so `include`,
 * `exclude`, `sharedDirs` and every printed path agree on one root.
 */
export function frameFor(cwd: string, target: string): Frame {
  return frameAt(isBelow(relative(cwd, target)) ? cwd : target);
}

/** The frame rooted at an absolute directory. */
export function frameAt(root: string): Frame {
  const repo = (abs: string): RepoPath => {
    if (!isAbsolute(abs))
      throw new Error(
        `frame.repo() takes an absolute path, got "${abs}" — a relative string has no frame to convert from`,
      );
    return (relative(root, abs) || ".") as RepoPath;
  };
  const bundle = (abs: string): Bundle => {
    const dir = normalize(abs);
    const path = (p: BundlePath): RepoPath => repo(join(dir, p));
    return {
      abs: dir,
      at: repo(dir),
      path,
      // The ONE place a plain string is taken to be bundle-relative.
      scanned: (p) => (isAbsolute(p) ? repo(p) : path(p as BundlePath)),
    };
  };
  return { root: normalize(root), repo, bundle };
}
