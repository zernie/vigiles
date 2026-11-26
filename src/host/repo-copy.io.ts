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
 *   That is the agent's tree, not a fault: what could be staged is scored and
 *   the touched set says `unstaged`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../core/tmp-root.js";
import {
  parseRawDiff,
  type RepoTemplate,
  type TouchedSet,
  type TrialBase,
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
 * to it). Returns the tree id.
 */
export function recordTrialBase(
  template: RepoTemplate,
  at: {
    readonly gitDir: string;
    readonly cwd: string;
    readonly armPaths: readonly string[];
  },
): string {
  initShadow(at.gitDir, template);
  const shadow = [`--git-dir=${at.gitDir}`, `--work-tree=${at.cwd}`];
  git(at.cwd, [...shadow, "read-tree", template.tree]);
  git(at.cwd, [...shadow, "add", "-A"]);
  if (at.armPaths.length > 0)
    git(at.cwd, [...shadow, "add", "-f", "--", ...at.armPaths]);
  return git(at.cwd, [...shadow, "write-tree"]).trim();
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
  const unstaged = add.status !== 0;
  if (unstaged) assertShadowHealthy(base, cwd, add.stderr);
  const raw = git(cwd, [
    ...shadow,
    "diff-index",
    "--cached",
    "--no-renames",
    "--raw",
    "-z",
    base.baseTree,
  ]);
  return { rows: parseRawDiff(raw), unstaged };
}

/** The shadow can still read its base and write an object; else throw. */
function assertShadowHealthy(
  base: TrialBase,
  cwd: string,
  stderr: string,
): void {
  const dir = `--git-dir=${base.gitDir}`;
  const readable = gitOk(cwd, [dir, "cat-file", "-e", base.baseTree]);
  const writable = gitOk(cwd, [dir, "hash-object", "-w", "--stdin"], "probe\n");
  if (!readable || !writable) {
    throw new Error(
      `the trial's base record is broken (${base.gitDir}): ${stderr.trim()}`,
    );
  }
}
