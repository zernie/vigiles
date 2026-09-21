/**
 * The DISK half of surface discovery: enumerate the repo-relative paths inside
 * the bounded root set, so the pure classifier in `src/core/surface-discovery.ts`
 * can say which of them are surfaces.
 *
 * Paths only — never contents. Discovery answers "is there a surface here that
 * nobody reads", which is a question about NAMES; reading a file nobody claims
 * would be doing the very work the finding says is not being done.
 *
 * 🔴 THE WALK IS BOUNDED BY CONSTRUCTION, NOT BY A DEPTH COUNTER. One `readdir`
 * of the repo root, one per DOT-DIRECTORY found there, and then descent ONLY
 * into a directory named by `SURFACE_SHAPES` (`skills`/`agents`/`commands`).
 * `src/`, `packages/`, `node_modules/` are never entered — there is no traversal
 * that could reach them, so there is no budget to tune and no flag to get wrong.
 * The module header of `core/surface-discovery.ts` holds the reason the bound is
 * this shape and why an adapter may not widen it.
 *
 * `exclude` is applied PER ENTRY, not only at the entry point, for the reason
 * b751471 measured: a vendored tree is normally excluded at its own root
 * (`skills/vendored`), which is a DESCENDANT of a surface dir, so an
 * entry-point-only check lets every one of its files through. Without this, a
 * discovery pass that walks dot-directories would grade copied-in corpora as the
 * repo's own work and the repo's only stated remedy would not reach it.
 *
 * Symlinks go through the ONE policy (`src/fs-walk.ts`): `walkableRoot` at each
 * surface dir the layout-blind walk opens, `entryOf` for every entry below it.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  SURFACE_SHAPES,
  discoverSurfaces,
  isDiscoveryRoot,
  type DiscoveredSurface,
} from "./core/surface-discovery.js";
import { excludedBy, type ExcludeSet } from "./exclude.js";
import { entryOf, walkableRoot } from "./fs-walk.js";

/** The shape directory names, as a set — the only dirs the walk descends into. */
const SHAPE_DIRS = new Set(SURFACE_SHAPES.map((s) => s.dir));

/** Directory entry names under `dir`, or `[]` when it cannot be read. */
function namesIn(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // unreadable: the same silence `entryOf` gives, never a throw
  }
}

/** Every file path (repo-relative, POSIX) under an opened surface directory. */
function filesUnder(
  root: string,
  rel: string,
  excluded: (abs: string) => boolean,
  out: string[],
): void {
  const abs = join(root, rel);
  for (const name of namesIn(abs)) {
    const childRel = `${rel}/${name}`;
    const childAbs = join(root, childRel);
    if (excluded(childAbs)) continue;
    const entry = entryOf(childAbs);
    if (entry.kind === "dir") filesUnder(root, childRel, excluded, out);
    // `childRel` is built with `/` from `readdir` names (which never contain a
    // separator), so it is already the POSIX form the classifier matches on.
    else if (entry.kind === "file") out.push(childRel);
  }
}

/**
 * Repo-relative paths of every file inside the bounded root set's surface dirs.
 *
 * Exported for the test that proves the bound holds — a caller that wants
 * surfaces wants {@link discoverSurfacesOnDisk}.
 */
export function boundedSurfacePaths(
  root: string,
  excludes?: ExcludeSet,
): readonly string[] {
  const excluded = excludedBy(excludes);
  const out: string[] = [];
  // The repo root is a discovery root, and so is each of its dot-directories.
  const roots = ["", ...namesIn(root).filter((n) => isDiscoveryRoot(n))];
  for (const base of roots.filter(
    (b) => b === "" || !excluded(join(root, b)),
  )) {
    for (const rel of surfaceDirsIn(root, base)) {
      if (openableSurfaceDir(root, rel, excluded))
        filesUnder(root, rel, excluded, out);
    }
  }
  return out;
}

/** Repo-relative surface dirs directly under one discovery root. */
function surfaceDirsIn(root: string, base: string): readonly string[] {
  const baseAbs = base === "" ? root : join(root, base);
  return namesIn(baseAbs)
    .filter((n) => SHAPE_DIRS.has(n))
    .map((n) => (base === "" ? n : `${base}/${n}`));
}

/** May the walk open `<root>/<rel>` as a surface directory? */
function openableSurfaceDir(
  root: string,
  rel: string,
  excluded: (abs: string) => boolean,
): boolean {
  const abs = join(root, rel);
  if (excluded(abs)) return false;
  // A FILE named `skills` is not a surface dir. A SYMLINKED one is (`entryOf`
  // says "skip" for it, deliberately — that rule is for entries the walk finds
  // INSIDE), so the entry point gets `walkableRoot`, which follows it unless
  // the target contains the scanned root. See src/fs-walk.ts.
  if (entryOf(abs).kind === "file") return false;
  return walkableRoot(abs, root);
}

/** Every surface the bounded walk finds on disk under `root`, by shape. */
export function discoverSurfacesOnDisk(
  root: string,
  excludes?: ExcludeSet,
): readonly DiscoveredSurface[] {
  return discoverSurfaces(boundedSurfacePaths(root, excludes));
}
