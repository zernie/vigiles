/**
 * The machine side of a regression case's world (vigiles#416): the reads of
 * the user's repository that the world is built from. The host adapter of
 * core's `CaseWorldHost` port; the pure rules are `src/core/case-world.ts`.
 *
 * Nothing here writes into the user's repository, its index or its objects,
 * and nothing it names runs (the P0 of this file; a test hashes the whole
 * checkout around each call, and plants a hook and an fsmonitor):
 *
 * - every object read runs in a throwaway bare repository whose object store
 *   borrows the user's through `objects/info/alternates`. The user's config,
 *   hooks, `core.fsmonitor`, attributes, promisor remotes and replace refs
 *   stay in a repository git is never pointed at, so none of them can run or
 *   change a read; only `gitDir`, the object format and the partial-clone
 *   test read the user's repository itself, and those run nothing;
 * - every git call runs without the user's global and system config
 *   (`./git-env.io.ts`), and diffs run with `--no-ext-diff --no-textconv`;
 * - a working-copy file is read by node and hashed from stdin, so no clean
 *   filter runs and, without `-w`, no object is written;
 * - a reverse patch is checked with `apply --check --cached` against a
 *   throwaway index in a temp dir, read from `head`; `--check` writes
 *   nothing;
 * - paths are passed with `--literal-pathspecs`, so a `*` or a `:(glob)` in
 *   a file name is a name.
 *
 * Patches are made with `--binary --full-index --no-renames`: a binary file
 * then reverses like any other, and a rename is a delete plus an add.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

interface RunOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly input?: string | Buffer;
}

function run(cwd: string, args: readonly string[], opts: RunOptions = {}): Run {
  const r = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...gitEnv(), ...opts.env },
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout };
}

/** Stdout of a git call that must succeed; throws with its args otherwise. */
function must(
  cwd: string,
  args: readonly string[],
  opts: RunOptions = {},
): string {
  const r = run(cwd, args, opts);
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
 * `fn` run in a throwaway bare repository that reads `top`'s objects, removed
 * after. It shares the object format and the shallow list (so a missing
 * parent is still missing, not a traversal error), and nothing else.
 */
function withIsolated<T>(top: string, fn: (iso: string) => T): T {
  const dir = makeTmpDir("case-read");
  try {
    return fn(initIsolated(top, join(dir, "read.git")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A bare repository at `iso` with `top`'s object format, objects and shallow list. */
function initIsolated(top: string, iso: string): string {
  const format = must(top, ["rev-parse", "--show-object-format"]).trim();
  must(dirname(iso), [
    "init",
    "-q",
    "--bare",
    `--object-format=${format}`,
    iso,
  ]);
  const common = must(top, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  writeFileSync(join(iso, "objects/info/alternates"), `${common}/objects\n`);
  const shallow = join(common, "shallow");
  if (existsSync(shallow)) copyFileSync(shallow, join(iso, "shallow"));
  return iso;
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
  return withIsolated(top, (iso) => {
    const r = run(iso, ["cat-file", "commit", commit]);
    if (!r.ok) return undefined;
    const ps = headerParents(r.out);
    // A parent missing from a shallow clone: the fix cannot be diffed.
    return ps.every((p) => run(iso, ["cat-file", "-e", `${p}^{commit}`]).ok)
      ? ps
      : undefined;
  });
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
  return withIsolated(
    top,
    (iso) => run(iso, ["merge-base", "--is-ancestor", ancestor, of]).ok,
  );
}

function fixPaths(top: string, commit: string): readonly FixPath[] {
  const args = [
    "diff",
    ...DIFF,
    "--no-renames",
    "--name-status",
    "-z",
    `${commit}^`,
    commit,
  ];
  return parseFixPaths(withIsolated(top, (iso) => must(iso, args)));
}

function treeEntries(top: string, sha: string): readonly TreeEntry[] {
  const z = withIsolated(top, (iso) => must(iso, ["ls-tree", "-r", "-z", sha]));
  return parseTreeEntries(z);
}

function workingBlob(top: string, path: string): string | undefined {
  const full = join(top, path);
  if (lstatSync(full, { throwIfNoEntry: false })?.isFile() !== true)
    return undefined;
  const input = readFileSync(full);
  const r = withIsolated(top, (iso) =>
    run(iso, ["hash-object", "--no-filters", "--stdin"], { input }),
  );
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
  return withIsolated(top, (iso) =>
    withHeadIndex(iso, at.head, (index) => {
      const patches = at.paths.map((path) => {
        const patch = reverseOf(iso, at.commit, path);
        return { path, patch, applies: checks(iso, index, patch) };
      });
      return {
        patch: patches
          .filter((p) => p.applies)
          .map((p) => p.patch)
          .join(""),
        failed: patches.filter((p) => !p.applies).map((p) => p.path),
      };
    }),
  );
}

/** The fix's own change to `path`, reversed. */
function reverseOf(iso: string, commit: string, path: string): string {
  return must(iso, ["diff", ...PATCH, commit, `${commit}^`, "--", path]);
}

/** An index of `head` in a temp dir, removed after `fn`; the repo's own index is never read or written. */
function withHeadIndex<T>(
  iso: string,
  head: string,
  fn: (index: string) => T,
): T {
  const dir = makeTmpDir("case-index");
  try {
    const index = join(dir, "index");
    must(iso, ["read-tree", head], { env: { GIT_INDEX_FILE: index } });
    return fn(index);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checks(iso: string, index: string, patch: string): boolean {
  return run(
    iso,
    ["apply", "--check", "--cached", "--binary", "--whitespace=nowarn", "-"],
    { env: { GIT_INDEX_FILE: index }, input: patch },
  ).ok;
}

/** A diff from `head` to the empty tree over `paths`: their deletion. */
function removalPatch(
  top: string,
  head: string,
  paths: readonly string[],
): string {
  if (paths.length === 0) return "";
  return withIsolated(top, (iso) => {
    const empty = emptyTree(iso);
    return must(iso, ["diff", ...PATCH, head, empty, "--", ...paths]);
  });
}

/** The empty tree's id in this repository's hash, computed, never written. */
function emptyTree(iso: string): string {
  return must(iso, ["hash-object", "-t", "tree", "--stdin"], {
    input: "",
  }).trim();
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
