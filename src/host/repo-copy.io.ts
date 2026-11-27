/**
 * The machine side of a repo workspace (vigiles#416): the sealed template a
 * workspace eval clones per trial, and the per-trial base record its scoring
 * diffs against. Part of the host adapter of core's `WorkspaceHost` port,
 * which `./workspace-host.io.ts` assembles. The pure half is
 * `src/core/workspace.ts`.
 *
 * Facts this file is built on, each measured (design v7.1 and its reviews):
 *
 * - `git archive`, never a worktree: stored blobs only, no untracked or
 *   ignored file of the checkout (a `.env`) reaches the copy.
 * - The base of a trial lives in a git dir the PARENT owns, beside the trial
 *   and never in it. The agent's `commit --amend`, `reset --hard` or
 *   `gc --prune=now` in the trial's own `.git` cannot move it.
 * - That git dir's index is SEEDED from the template tree before `add -A`.
 *   Unseeded, `add -A` applies `.gitignore` to files the template tracks, and
 *   an edit to a committed `dist/` file vanished from the touched set.
 * - Every parent git call runs with the user's global and system config off
 *   (`./git-env.io.ts`), so a `core.excludesFile` cannot hide a new file.
 * - `add -A` exits non-zero on a nested repo the agent left without a commit.
 *   That is the agent's tree, not a fault: the touched set says `unstaged`,
 *   and a scorer must not score it.
 * - `add -A` skips ignored files, so the base record also keeps the ignored
 *   entries present before the agent, and the touched set counts the new ones.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { makeTmpDir } from "../core/tmp-root.js";
import {
  parseRawDiff,
  ShadowUnhealthyError,
  type RepoTemplate,
  type TouchedSet,
  type TrialBase,
  type Unstaged,
} from "../core/workspace.js";
import { exportTree } from "./base-tree.io.js";
import { gitEnv, IDENTITY } from "./git-env.io.js";

function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: gitEnv(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Exit 0 of a git call; its output is not wanted. */
function gitOk(cwd: string, args: readonly string[], input?: string): boolean {
  return (
    spawnSync("git", args, { cwd, env: gitEnv(), input, stdio: "pipe" })
      .status === 0
  );
}

/** Stdout of a git call that exits 0, else undefined. */
function gitOut(cwd: string, args: readonly string[]): string | undefined {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: gitEnv() });
  return r.status === 0 ? r.stdout : undefined;
}

/** Resolve `ref` of the repository at `dir` to a commit SHA, or undefined. */
export function resolveCommit(dir: string, ref: string): string | undefined {
  return gitOut(dir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ])?.trim();
}

/** The text of `path` in commit `sha`, or undefined when it is not a file there. */
export function showFile(
  top: string,
  sha: string,
  path: string,
): string | undefined {
  return gitOut(top, ["show", `${sha}:${path}`]);
}

/** The real path of the top of the work tree at `dir`, or undefined. */
export function workTreeTop(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"])?.trim();
  return top === undefined ? undefined : realpathSync(top);
}

/**
 * Export `ref` of `dir` into a new temp dir, apply `patch`, commit it as
 * `baseline`. Throws when `ref` is not a commit or the patch does not apply;
 * the caller checks `ref` first and turns that into a refusal.
 */
export function buildTemplate(opts: {
  readonly dir: string;
  readonly ref: string;
  readonly patch?: string;
}): RepoTemplate {
  const sha = resolveCommit(opts.dir, opts.ref);
  if (sha === undefined) {
    throw new Error(`${opts.ref} is not a commit in ${opts.dir}`);
  }
  const root = makeTmpDir("workspace");
  try {
    exportTree(opts.dir, sha, root);
    return { root, sha, tree: commitBaseline(root, opts.patch) };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/** `git init`, apply the patch, one commit; returns its tree id. */
function commitBaseline(root: string, patch: string | undefined): string {
  git(root, ["init", "-q"]);
  if (patch !== undefined && patch !== "") {
    git(root, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
  }
  git(root, ["add", "-A", "-f"]);
  git(root, ["commit", "-q", "--no-verify", "-m", "baseline"]);
  return git(root, ["rev-parse", "HEAD^{tree}"]).trim();
}

/**
 * Clone the template into `dest` (an empty dir). Objects are copied, never
 * hardlinked, so nothing the agent does to its `.git` reaches the template;
 * the clone has no remote.
 */
export function cloneTemplate(template: RepoTemplate, dest: string): void {
  git(dest, ["clone", "-q", "--no-hardlinks", template.root, "."]);
  git(dest, ["remote", "remove", "origin"]);
  git(dest, ["config", "user.name", IDENTITY.GIT_AUTHOR_NAME]);
  git(dest, ["config", "user.email", IDENTITY.GIT_AUTHOR_EMAIL]);
}

/**
 * Record the trial's tree before the agent starts, into `gitDir` (an empty
 * dir beside the trial): a bare git dir whose objects are borrowed from the
 * template, its index seeded from the template tree, then everything in the
 * trial dir staged on top, and the arm's own files forced in past
 * `.gitignore` (an ignored file outside the base would hide every later edit
 * to it). Returns the tree id and the arm-owned paths: each as staged and
 * where writing it lands, since git reports a later edit at either.
 */
export function recordTrialBase(
  template: RepoTemplate,
  at: {
    readonly gitDir: string;
    readonly cwd: string;
    readonly armPaths: readonly string[];
  },
): { readonly baseTree: string; readonly armPaths: readonly string[] } {
  initShadow(at.gitDir, template);
  const shadow = [`--git-dir=${at.gitDir}`, `--work-tree=${at.cwd}`];
  git(at.cwd, [...shadow, "read-tree", template.tree]);
  git(at.cwd, [...shadow, "add", "-A"]);
  const armPaths = stageArmPaths(shadow, at.cwd, at.armPaths);
  const baseTree = git(at.cwd, [...shadow, "write-tree"]).trim();
  recordIgnored(at.gitDir, shadow, at.cwd);
  return { baseTree, armPaths };
}

/** Keep the ignored entries present before the agent, beside the base. */
function recordIgnored(
  gitDir: string,
  shadow: readonly string[],
  cwd: string,
): void {
  writeFileSync(
    join(gitDir, IGNORED_AT_BASE),
    ignoredEntries(shadow, cwd).join("\0"),
  );
}

/** Where the base record keeps its ignored entries (inside the parent's git dir). */
const IGNORED_AT_BASE = "vigiles-ignored-at-base";

/** Ignored untracked entries, a wholly ignored directory as one `dir/` entry. */
function ignoredEntries(
  shadow: readonly string[],
  cwd: string,
): readonly string[] {
  const listed = git(cwd, [
    ...shadow,
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  return listed.split("\0").filter((p) => p !== "");
}

/** Ignored entries now that were not there at the base (a base without the record counts all). */
function ignoredNew(
  base: TrialBase,
  shadow: readonly string[],
  cwd: string,
): number {
  const file = join(base.gitDir, IGNORED_AT_BASE);
  const before = new Set(
    existsSync(file) ? readFileSync(file, "utf-8").split("\0") : [],
  );
  return ignoredEntries(shadow, cwd).filter((p) => !before.has(p)).length;
}

/**
 * Where `path` really sits under `cwd`: git refuses a pathspec beyond a link,
 * and an arm may write through a directory link the world tracks (the link
 * check has already kept every such link inside the trial).
 */
function physicalPath(cwd: string, path: string): string {
  const dir = join(cwd, dirname(path));
  if (!existsSync(dir)) return path;
  const parent = realpathSync(dir);
  return relative(realpathSync(cwd), join(parent, basename(path)));
}

/**
 * Where writing `path` lands: every link on the way resolved, the last one
 * included (writing an arm file follows it). `path` itself when nothing is
 * there.
 */
function canonicalPath(cwd: string, path: string): string {
  const full = join(cwd, path);
  if (!existsSync(full)) return path;
  return relative(realpathSync(cwd), realpathSync(full));
}

/**
 * Stage the arm-owned paths even where `.gitignore` hides them, and return
 * each as staged and where writing it lands. A path the arm deleted is
 * already staged as deleted by `add -A`, so only what still exists is added.
 */
function stageArmPaths(
  shadow: readonly string[],
  cwd: string,
  paths: readonly string[],
): readonly string[] {
  const staged = paths.map((p) => physicalPath(cwd, p));
  const present = staged.filter((p) => entryAt(join(cwd, p)));
  if (present.length > 0) git(cwd, [...shadow, "add", "-f", "--", ...present]);
  return [...new Set([...staged, ...staged.map((p) => canonicalPath(cwd, p))])];
}

/** Something sits at `path`, a dangling link included. */
function entryAt(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** A bare git dir that reads the template's objects through `alternates`. */
function initShadow(gitDir: string, template: RepoTemplate): void {
  git(gitDir, ["init", "-q", "--bare", "."]);
  mkdirSync(join(gitDir, "objects", "info"), { recursive: true });
  writeFileSync(
    join(gitDir, "objects", "info", "alternates"),
    `${join(template.root, ".git", "objects")}\n`,
  );
}

/**
 * What changed in `cwd` against its base. Rejects only when the shadow git
 * dir itself is broken (a fault of vigiles or the machine, not the agent).
 */
export function touchedPaths(base: TrialBase, cwd: string): TouchedSet {
  const shadow = [`--git-dir=${base.gitDir}`, `--work-tree=${cwd}`];
  const add = spawnSync("git", [...shadow, "add", "-A", "--ignore-errors"], {
    cwd,
    encoding: "utf-8",
    env: gitEnv(),
  });
  if (add.status !== 0) assertShadowHealthy(base, cwd, add.stderr);
  const unstaged: Unstaged =
    add.status === 0 ? { kind: "none" } : leftUnstaged(shadow, cwd, add.stderr);
  const raw = git(cwd, [
    ...shadow,
    "diff-index",
    "--cached",
    "--no-renames",
    "--raw",
    "-z",
    base.baseTree,
  ]);
  return {
    rows: parseRawDiff(raw),
    unstaged,
    ignoredNewFiles: ignoredNew(base, shadow, cwd),
  };
}

/**
 * What a failed `add -A --ignore-errors` left out: the entries still
 * untracked or modified in the shadow (ignored files are not staged on
 * purpose, so not listed). An untracked directory is one entry ending in
 * `/`. Judging them is core's (`carryVerdict`), with the same minimatch as
 * the carry, never git pathspec magic.
 */
function leftUnstaged(
  shadow: readonly string[],
  cwd: string,
  stderr: string,
): Unstaged {
  const listed = git(cwd, [
    ...shadow,
    "ls-files",
    "-z",
    "--others",
    "--modified",
    "--exclude-standard",
    "--directory",
  ]);
  const paths = [...new Set(listed.split("\0").filter((p) => p !== ""))];
  return paths.length > 0
    ? { kind: "paths", paths }
    : { kind: "unknown", detail: stderr.trim() };
}

/**
 * The shadow can still read its base, write an object and lock its index;
 * else throw. The index probe forces a write: a plain refresh with nothing
 * to write exits 0 past a held lock.
 */
function assertShadowHealthy(
  base: TrialBase,
  cwd: string,
  stderr: string,
): void {
  const dir = `--git-dir=${base.gitDir}`;
  const readable = gitOk(cwd, [dir, "cat-file", "-e", base.baseTree]);
  const writable = gitOk(cwd, [dir, "hash-object", "-w", "--stdin"], "probe\n");
  const lockable = gitOk(cwd, [
    dir,
    `--work-tree=${cwd}`,
    "update-index",
    "-q",
    "--refresh",
    "--force-write-index",
  ]);
  if (!readable || !writable || !lockable) {
    throw new ShadowUnhealthyError(
      `the trial's base record is broken (${base.gitDir}): ${stderr.trim()}`,
    );
  }
}
