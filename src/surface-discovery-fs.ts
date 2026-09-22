/**
 * The DISK half of BOUNDED DISCOVERY: enumerate the repo-relative paths inside
 * the bounded root set, so the pure classifiers in `src/core/surface-discovery.ts`
 * and `src/core/instruction-chain.ts` can say what each of them is.
 *
 * Two enumerations, one bound. {@link boundedSurfacePaths} answers "is there a
 * surface here that nobody reads" and returns PATHS ONLY — that is a question
 * about NAMES, and reading a file nobody claims would be doing the very work the
 * finding says is not being done. {@link boundedInstructionFiles} answers "what
 * does this harness load without being asked" and must return CONTENTS, because
 * the answer depends on them: a rule's own frontmatter decides whether it loads
 * at launch, and the repository's settings decide which files are candidates at
 * all. The header of `core/instruction-chain.ts` holds the reason that is a port
 * method rather than a glob.
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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  instructionCandidatePaths,
  resolveImports,
} from "./core/instruction-chain.js";
import type { PluginLayout } from "./core/layout.js";
import { rulesHome } from "./core/layout.js";
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

/** Read one repo-relative file, or `undefined` for anything that is not one. */
function readIfFile(root: string, rel: string): string | undefined {
  const abs = join(root, rel);
  if (entryOf(abs).kind !== "file") return undefined;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return undefined; // unreadable: the same silence the walk gives elsewhere
  }
}

/** Repo-relative paths of the files directly inside one discovery root. */
function filesDirectlyIn(root: string, base: string): readonly string[] {
  const baseAbs = base === "" ? root : join(root, base);
  return namesIn(baseAbs).map((n) => (base === "" ? n : `${base}/${n}`));
}

/**
 * Every instruction CANDIDATE on disk, with its contents — the input a harness's
 * `instructionChain` is allowed to classify.
 *
 * 🔴 BOUNDED BY THE SAME CONSTRUCTION AS THE SURFACE WALK, and for the same
 * reason. One `readdir` of the repo root, one per dot-directory found there, and
 * a recursive descent ONLY into a `rules` directory inside one of those. `src/`,
 * `packages/` and `node_modules/` are never entered — which is exactly what the
 * thing this replaced did do: `scan.ts:readAlwaysLoaded` expanded an ADAPTER's
 * `"**\/AGENTS.md"` by recursing through the whole tree, so registering an
 * adapter widened what vigiles read in everyone's repository.
 *
 * The one read outside that bound is the IMPORT PASS below, and the difference
 * is who chose the path.
 */
/**
 * The `rules` tree under one dot-directory, read RECURSIVELY.
 *
 * Recursive because the vendor documents it that way — and because the scan
 * classifier now says the same through `RULE_FILE_LEAF_RE`; a rule the loader
 * reads and the classifier ignores is a file that is never checked, counted or
 * weighed. The entry point goes through the same symlink and exclude policy as
 * a surface dir, `filesUnder` applies `exclude` per entry below it.
 */
function addRulesTree(
  root: string,
  rulesRel: string | null,
  excluded: (abs: string) => boolean,
  out: string[],
): void {
  if (rulesRel === null) return;
  const rel = rulesRel;
  const abs = join(root, rel);
  if (excluded(abs) || entryOf(abs).kind !== "dir") return;
  if (!walkableRoot(abs, root)) return;
  filesUnder(root, rel, excluded, out);
}

export function boundedInstructionFiles(
  root: string,
  layout: PluginLayout,
  excludes?: ExcludeSet,
): Record<string, string> {
  const excluded = excludedBy(excludes);
  const roots = ["", ...namesIn(root).filter((n) => isDiscoveryRoot(n))].filter(
    (b) => b === "" || !excluded(join(root, b)),
  );
  // Every file directly inside a discovery root is a candidate PATH; the pure
  // filter keeps the instruction-shaped ones plus the layout's own named files
  // (`.codex/config.toml` is neither markdown nor an instruction — it is the
  // settings source that decides WHICH files load, and is never weighed).
  const candidates: string[] = [];
  for (const base of roots) {
    candidates.push(...filesDirectlyIn(root, base));
  }
  // 🔴 THE RULES TREE HAS ONE HOME, AND THE LAYOUT NAMES IT (#271).
  //
  // This used to run INSIDE the loop above, joining `<base>/<rulesDir>` for
  // every discovery root and guarding the repository root out with
  // `if (base !== "")`. Two wrong answers fell out of that, measured on layouts
  // built from the type: a layout declaring `rulesDir` with no
  // `userSurfaceRoot` had its tree skipped entirely, while `.github/rules` was
  // walked for every layout, declared or not. `rulesHome` is the same answer
  // `ruleFileRe` gives the classifier, so the walk and the filter can no longer
  // disagree about which tree belongs to this harness.
  addRulesTree(root, rulesHome(layout), excluded, candidates);
  const candidateFiles: Record<string, string> = {};
  for (const rel of instructionCandidatePaths(candidates, layout)) {
    if (excluded(join(root, rel))) continue;
    const text = readIfFile(root, rel);
    if (text !== undefined) candidateFiles[rel] = text;
  }
  // The import pass is the ONE read outside the bound, and the pure half of it
  // lives in the core so the browser twin runs the identical loop over its file
  // map. It is ONE concrete path per token, one level deep — the corpus
  // measurement behind that is in `resolveImports`. `exclude` is deliberately
  // NOT applied to it: the path was written by the repository owner in their own
  // instruction file, and the harness really does load it, so hiding its size
  // would under-report the one number this report exists to give.
  return resolveImports(layout, candidateFiles, (rel) => readIfFile(root, rel));
}
