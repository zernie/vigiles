/**
 * A regression case from your own fix history (vigiles#416), its pure half:
 * the case's shape, the split of the fix's paths, the default `source`, the
 * path refusals, the drift rules for a file that does not revert, and the
 * lock-key view. No git, no build, no process here.
 */
import { minimatch } from "minimatch";
import { keys, sortBy, uniqueBy } from "remeda";
import type { PathRefusal, RevertConflict } from "./regression-case-refusal.js";

/** A regression case as an eval spec declares it. */
export interface RegressionCaseSpec {
  /** Your repository (a git work tree). Not in the lock key: a path differs per machine. */
  readonly repo: string;
  /** The fix: a single-parent commit that is an ancestor of `head`. A full 40-hex SHA. */
  readonly commit: string;
  /** The commit the world is built at, a full 40-hex SHA. Bump it to re-measure. */
  readonly head: string;
  /** Test territory: kept at `head`, never reverted; a trial that edits any of it fails. */
  readonly tests: {
    /** Runnable test files; the fix's added or modified ones are the oracle. */
    readonly run: readonly string[];
    /** Test data the runner reads; never passed as a path. */
    readonly data: readonly string[];
  };
  /** argv; one oracle path is appended as one argument, no shell. */
  readonly testCommand: readonly string[];
  readonly build:
    | { readonly kind: "command"; readonly argv: readonly string[] }
    | { readonly kind: "none"; readonly reason: string };
  readonly deps:
    | {
        readonly kind: "node-modules";
        /** Directories whose lockfile keys the installs under them. Default `["."]`. */
        readonly roots?: readonly string[];
      }
    | { readonly kind: "none" };
  /** What the agent is told: only a file committed at `head`. */
  readonly symptom: { readonly kind: "file"; readonly path: string };
  /** Paths whose edits are carried into scoring. Default: {@link defaultSource}. */
  readonly source?: readonly string[];
  /** Removed from the world besides the symptom file. */
  readonly hide?: readonly string[];
  /** Runs per control; they must agree. Default 2. */
  readonly runs?: number;
  /** Wall-clock limit for each scoring process. */
  readonly scoringTimeoutMs?: number;
}

/** One path of the fix against its parent (`git diff --name-status --no-renames`). */
export interface FixPath {
  readonly status: "A" | "M" | "D" | "T";
  readonly path: string;
}

/** The fix's paths, by what the case does with each. */
export interface FixSplit {
  /** Runnable tests the fix added or modified: each one is scored. */
  readonly oracle: readonly string[];
  /** Every path under `tests.run` ∪ `tests.data`: kept at `head`. */
  readonly testPaths: readonly string[];
  /** Every other path: reverted file by file. */
  readonly reverted: readonly string[];
}

/** Does `path` (repo-relative) match one of `globs`? */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => minimatch(path, g, { dot: true }));
}

/**
 * Split the fix. A test path is decided by minimatch over the repo-relative
 * path, never by git pathspec magic. A test the fix DELETED is test territory
 * but not an oracle: it does not exist at `head` to be run.
 */
export function splitFix(
  fix: readonly FixPath[],
  tests: RegressionCaseSpec["tests"],
): FixSplit {
  const territory = [...tests.run, ...tests.data];
  const isTest = (p: FixPath): boolean => matchesAny(p.path, territory);
  return {
    oracle: fix
      .filter((p) => isOracleStatus(p) && matchesAny(p.path, tests.run))
      .map((p) => p.path),
    testPaths: fix.filter(isTest).map((p) => p.path),
    reverted: fix.filter((p) => !isTest(p)).map((p) => p.path),
  };
}

const isOracleStatus = (p: FixPath): boolean =>
  p.status === "A" || p.status === "M";

export function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * The `source` a case scores with. A declared one is globs; the default is
 * literal paths, so nothing in a path the fix touched can read as a pattern.
 */
export type Source =
  | { readonly kind: "declared"; readonly globs: readonly string[] }
  | { readonly kind: "default"; readonly roots: readonly SourceRoot[] };

/** One default root: a top-level directory, or a file at the repo root. */
export type SourceRoot =
  | { readonly kind: "dir"; readonly dir: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * The default `source`: the top-level directories of the fix's non-test,
 * non-Markdown paths (`src/core/a.ts` gives the dir `src`; a root-level file
 * gives that file only). Derived from the fix, so it cannot refuse the fix,
 * and a root runner config outside it stays at `head`.
 */
export function defaultSource(reverted: readonly string[]): Source {
  const roots: readonly SourceRoot[] = uniqueBy(
    reverted.filter((p) => !isMarkdown(p)).map(rootOf),
    rootKey,
  );
  return { kind: "default", roots: sortBy(roots, rootKey) };
}

function rootOf(path: string): SourceRoot {
  const slash = path.indexOf("/");
  return slash < 0
    ? { kind: "file", path }
    : { kind: "dir", dir: path.slice(0, slash) };
}

const rootKey = (r: SourceRoot): string =>
  r.kind === "dir" ? `${r.dir}/` : r.path;

/** Is `path` (repo-relative) inside `source`? */
export function inSource(path: string, source: Source): boolean {
  switch (source.kind) {
    case "declared":
      return matchesAny(path, source.globs);
    case "default":
      return source.roots.some((r) => inRoot(path, r));
  }
}

function inRoot(path: string, root: SourceRoot): boolean {
  switch (root.kind) {
    case "dir":
      return path.startsWith(`${root.dir}/`);
    case "file":
      return path === root.path;
  }
}

/**
 * Could `entry` hold a path inside `source`? A file is judged as itself; a
 * directory (it ends in `/`, as `git ls-files --directory` prints it) when a
 * default root contains it or a declared glob can match beneath it.
 */
export function mayHoldSource(entry: string, source: Source): boolean {
  if (!entry.endsWith("/")) return inSource(entry, source);
  return source.kind === "default"
    ? inSource(entry, source)
    : mayMatchBeneath(entry, source.globs);
}

/** Could a glob of `globs` match a path beneath the directory `entry`? */
function mayMatchBeneath(entry: string, globs: readonly string[]): boolean {
  const dir = entry.slice(0, -1);
  return globs.some((g) => minimatch(dir, g, { dot: true, partial: true }));
}

/** The `source` a case scores with: the declared one, else the default. */
export function resolvedSource(
  declared: readonly string[] | undefined,
  split: FixSplit,
): Source {
  return declared === undefined
    ? defaultSource(split.reverted)
    : { kind: "declared", globs: declared };
}

/** Lockfiles whose content decides a Node install. */
export const LOCKFILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const MANIFESTS: ReadonlySet<string> = new Set(["package.json", ...LOCKFILES]);

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** What the path refusals read besides the split. */
export interface PathFacts {
  /** `source` as the spec declared it; undefined when defaulted. */
  readonly declaredSource: readonly string[] | undefined;
  /** Is `path` a file in `head`'s tree? */
  readonly atHead: (path: string) => boolean;
}

type PathCheck = (split: FixSplit, facts: PathFacts) => PathRefusal | undefined;

/** Refuse with `kind` when `paths` is not empty. */
const listed = (
  kind:
    | "oracle-missing-in-world"
    | "fix-outside-source"
    | "revert-touches-manifest",
  paths: readonly string[],
): PathRefusal | undefined =>
  paths.length === 0 ? undefined : { kind, paths };

/** In the order a user fixes them: no oracle first, then what blocks the world. */
const PATH_CHECKS: readonly PathCheck[] = [
  (s) => (s.oracle.length === 0 ? { kind: "no-test-in-fix" } : undefined),
  (s) =>
    s.reverted.length === 0 ? { kind: "fix-touches-only-tests" } : undefined,
  (s, f) =>
    listed(
      "oracle-missing-in-world",
      s.oracle.filter((p) => !f.atHead(p)),
    ),
  (s, f) =>
    f.declaredSource === undefined
      ? undefined
      : listed(
          "fix-outside-source",
          outsideSource(s.reverted, f.declaredSource),
        ),
  (s) =>
    listed(
      "revert-touches-manifest",
      s.reverted.filter((p) => MANIFESTS.has(baseName(p))),
    ),
];

function outsideSource(
  reverted: readonly string[],
  source: readonly string[],
): readonly string[] {
  return reverted.filter((p) => !isMarkdown(p) && !matchesAny(p, source));
}

/** The first refusal decidable from the fix's paths and `head`'s tree; undefined when none. */
export function pathRefusal(
  split: FixSplit,
  facts: PathFacts,
): PathRefusal | undefined {
  return PATH_CHECKS.reduce<PathRefusal | undefined>(
    (found, check) => found ?? check(split, facts),
    undefined,
  );
}

/** What the world does with the files that did not revert. */
export type DriftVerdict =
  | {
      readonly kind: "kept";
      /** Markdown left as it is at `head`, listed in the report. */
      readonly markdownKeptAtHead: readonly string[];
    }
  | { readonly kind: "outdated"; readonly files: readonly RevertConflict[] };

/**
 * The verdict over the reverted files whose own hunk did not reverse-apply at
 * `head`: Markdown is kept at `head`; any other file changed after the fix, so
 * the case is outdated. No file is read for whether it changed only in
 * comments: a comment can be any tool's directive, and no list names them all.
 */
export function driftVerdict(failed: readonly string[]): DriftVerdict {
  const files = failed.filter((p) => !isMarkdown(p)).map((path) => ({ path }));
  return files.length > 0
    ? { kind: "outdated", files }
    : { kind: "kept", markdownKeptAtHead: failed.filter(isMarkdown) };
}

/**
 * Which fields of the case go into the eval lock key. A table over every key
 * of the spec, so a new field fails tsc until someone decides.
 */
export const CASE_KEY_FIELDS = {
  repo: { excluded: "a path differs per machine" },
  commit: "keyed",
  head: "keyed",
  tests: "keyed",
  testCommand: "keyed",
  build: "keyed",
  deps: "keyed",
  symptom: "keyed",
  source: "keyed",
  hide: "keyed",
  runs: "keyed",
  scoringTimeoutMs: "keyed",
} as const satisfies Readonly<
  Record<keyof RegressionCaseSpec, "keyed" | { readonly excluded: string }>
>;

const KEYED: readonly (keyof RegressionCaseSpec)[] = keys(
  CASE_KEY_FIELDS,
).filter((k) => CASE_KEY_FIELDS[k] === "keyed");

/**
 * The case as the lock key holds it: every keyed field as written, an unset
 * optional field left out. Needs no git and runs nothing.
 */
export function caseKeyView(
  spec: RegressionCaseSpec,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    KEYED.flatMap((k) => (spec[k] === undefined ? [] : [[k, spec[k]]])),
  );
}
