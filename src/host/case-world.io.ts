/**
 * The machine side of a regression case's world (vigiles#416): the reads of
 * the user's repository that the world is built from. The host adapter of
 * core's `CaseWorldHost` port; the pure rules are `src/core/case-world.ts`.
 *
 * Nothing here writes into the user's repository, its index or its objects
 * (the P0 of this file; a test hashes the whole checkout around each call):
 *
 * - every git call runs without the user's global and system config
 *   (`./git-env.io.ts`), and diffs run with `--no-ext-diff --no-textconv`,
 *   so a repo's own `diff.external` or a textconv driver never runs;
 * - a working-copy file is hashed with `--no-filters` and without `-w`, so
 *   no clean filter runs and no object is written;
 * - a reverse patch is checked with `apply --check --cached` against a
 *   throwaway index in a temp dir, read from `head`; `--check` writes
 *   nothing;
 * - paths are passed with `--literal-pathspecs`, so a `*` or a `:(glob)` in
 *   a file name is a name;
 * - the repo's own config can still change a diff's text or what `apply`
 *   accepts, so every option it could set is given explicitly (prefixes,
 *   `--no-relative`, `--whitespace=nowarn`).
 *
 * Patches are made with `--binary --full-index --no-renames`: a binary file
 * then reverses like any other, and a rename is a delete plus an add.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  parseFixPaths,
  parseTreeEntries,
  type CaseWorldHost,
  type RevertPatches,
  type TreeEntry,
} from "../core/case-world.js";
import type { FixPath } from "../core/regression-case.js";
import { makeTmpDir } from "../core/tmp-root.js";
import { gitEnv } from "./git-env.io.js";

interface Run {
  readonly ok: boolean;
  readonly out: string;
}

function run(
  cwd: string,
  args: readonly string[],
  extra: Readonly<NodeJS.ProcessEnv> = {},
): Run {
  const r = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...gitEnv(), ...extra },
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout };
}

/** Stdout of a git call that must succeed; throws with its args otherwise. */
function must(cwd: string, args: readonly string[]): string {
  const r = run(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  return r.out;
}

/** The repo's own `diff.noprefix`, `diff.relative` or color would change the patch text. */
const DIFF = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;
const PATCH = [...DIFF, "--binary", "--full-index", "--no-renames"] as const;

function gitDir(top: string): string {
  return must(top, ["rev-parse", "--absolute-git-dir"]).trim();
}

/**
 * git's own test for a promisor remote: the `partialclone` extension, or any
 * remote with `promisor` set (a `--filter` clone of git 2.43 writes only the
 * second). A git without `GIT_NO_LAZY_FETCH` fetches into such a repository
 * on the first missing blob, so the plan refuses it before reading one.
 */
function isPartialClone(top: string): boolean {
  if (run(top, ["config", "--get", "extensions.partialclone"]).ok) return true;
  const promisors = run(top, [
    "config",
    "-z",
    "--type=bool",
    "--get-regexp",
    String.raw`^remote\..*\.promisor$`,
  ]);
  // `-z` prints each entry as `<key>\n<value>\0`; `--type=bool` canonicalises the value.
  return (
    promisors.ok &&
    promisors.out.split("\0").some((entry) => entry.endsWith("\ntrue"))
  );
}

/**
 * The parents the commit object itself names. Not `rev-list --parents`: a
 * shallow clone grafts its boundary commits to look parentless, and a fix
 * read that way would be refused as a merge commit instead of as missing
 * history.
 */
function parents(top: string, commit: string): readonly string[] | undefined {
  const r = run(top, ["cat-file", "commit", commit]);
  if (!r.ok) return undefined;
  const ps = headerParents(r.out);
  // A parent missing from a shallow clone: the fix cannot be diffed.
  return ps.every((p) => run(top, ["cat-file", "-e", `${p}^{commit}`]).ok)
    ? ps
    : undefined;
}

/** The `parent <id>` lines of a commit object's header (git's object format, ended by a blank line). */
function headerParents(object: string): readonly string[] {
  const header = object.split("\n\n", 1).join("");
  return header
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
}

function isAncestor(top: string, ancestor: string, of: string): boolean {
  return run(top, ["merge-base", "--is-ancestor", ancestor, of]).ok;
}

function fixPaths(top: string, commit: string): readonly FixPath[] {
  const z = must(top, [
    "diff",
    ...DIFF,
    "--no-renames",
    "--name-status",
    "-z",
    `${commit}^`,
    commit,
  ]);
  return parseFixPaths(z);
}

function treeEntries(top: string, sha: string): readonly TreeEntry[] {
  return parseTreeEntries(must(top, ["ls-tree", "-r", "-z", sha]));
}

function workingBlob(top: string, path: string): string | undefined {
  const full = join(top, path);
  if (lstatSync(full, { throwIfNoEntry: false })?.isFile() !== true)
    return undefined;
  const r = run(top, ["hash-object", "--no-filters", "--", path]);
  return r.ok ? r.out.trim() : undefined;
}

/**
 * Each path's own reverse (`diff <fix> <fix>^ -- <path>`), checked alone
 * against `head` in a throwaway index; the ones that apply are concatenated.
 */
function revertPatches(
  top: string,
  at: {
    readonly commit: string;
    readonly head: string;
    readonly paths: readonly string[];
  },
): RevertPatches {
  return withHeadIndex(top, at.head, (index) => {
    const patches = at.paths.map((path) => {
      const patch = reverseOf(top, at.commit, path);
      return { path, patch, applies: checks(top, index, patch) };
    });
    return {
      patch: patches
        .filter((p) => p.applies)
        .map((p) => p.patch)
        .join(""),
      failed: patches.filter((p) => !p.applies).map((p) => p.path),
    };
  });
}

/** The fix's own change to `path`, reversed. */
function reverseOf(top: string, commit: string, path: string): string {
  return must(top, ["diff", ...PATCH, commit, `${commit}^`, "--", path]);
}

/** An index of `head` in a temp dir, removed after `fn`; the repo's own index is never read or written. */
function withHeadIndex<T>(
  top: string,
  head: string,
  fn: (index: string) => T,
): T {
  const dir = makeTmpDir("case-index");
  try {
    const index = join(dir, "index");
    const r = run(top, ["read-tree", head], { GIT_INDEX_FILE: index });
    if (!r.ok) throw new Error(`git read-tree ${head} failed in ${top}`);
    return fn(index);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checks(top: string, index: string, patch: string): boolean {
  const r = spawnSync(
    "git",
    ["apply", "--check", "--cached", "--binary", "--whitespace=nowarn", "-"],
    { cwd: top, env: { ...gitEnv(), GIT_INDEX_FILE: index }, input: patch },
  );
  return r.status === 0;
}

/** A diff from `head` to the empty tree over `paths`: their deletion. */
function removalPatch(
  top: string,
  head: string,
  paths: readonly string[],
): string {
  if (paths.length === 0) return "";
  const empty = emptyTree(top);
  return must(top, ["diff", ...PATCH, head, empty, "--", ...paths]);
}

/** The empty tree's id in this repository's hash, computed, never written. */
function emptyTree(top: string): string {
  const r = spawnSync("git", ["hash-object", "-t", "tree", "--stdin"], {
    cwd: top,
    encoding: "utf-8",
    env: gitEnv(),
    input: "",
  });
  return r.stdout.trim();
}

/** The host adapter of core's `CaseWorldHost` port. */
export const caseWorldHost: CaseWorldHost = {
  gitDir,
  isPartialClone,
  parents,
  isAncestor,
  fixPaths,
  treeEntries,
  workingBlob,
  revertPatches,
  removalPatch,
};
