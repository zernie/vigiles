/**
 * The machine side of `audit --format=md --compare` (#474): copy a git ref out
 * of the checkout and audit the copy. The choice of base is pure and lives in
 * `src/core/changed-base.ts`; this is the copying and the child process.
 *
 * Three facts, each a measured bug when the GitHub Action did this in bash:
 *
 * - `git archive`, not a worktree or a checkout: it exports stored blobs with no
 *   smudge/checkout filters, so a filter the runner lacks (git-crypt) cannot
 *   break it, and the harness files land as plain text.
 * - The checkout's git-IGNORED entries (installed dependencies, build output)
 *   are linked into the copy. They are the environment, not the change; without
 *   them a hook that runs `dist/cli.js` was "missing" in the base only, and the
 *   comment on vigiles' own PR read "D → B" for a PR that touched no hook.
 * - The copy is audited FROM INSIDE, by this same CLI, so the base's own
 *   `.vigilesrc.json` applies and its `exclude` is rooted at the copy. Audited
 *   from the checkout, the checkout's excludes never matched the copy's paths
 *   and an excluded skill counted in the base only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { cleanupTmpDir, makeTmpDir } from "../core/tmp-root.js";

/** A copy of the base on disk, or why there is none. */
export type BaseCopy =
  | { readonly kind: "copied"; readonly root: string; readonly sha: string }
  | { readonly kind: "failed"; readonly why: string };

function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Link each git-ignored entry of `top` into `copy`, where the copy has nothing. */
function linkIgnored(top: string, copy: string): void {
  const listed =
    git(top, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ]) ?? "";
  const entries = listed
    .split("\0")
    .map((e) => (e.endsWith("/") ? e.slice(0, -1) : e))
    .filter((e) => e !== "");
  // One at a time: an entry inside a directory linked a moment ago exists by then.
  entries.forEach((e) => {
    const at = join(copy, e);
    if (lstatSync(at, { throwIfNoEntry: false }) !== undefined) return;
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(join(top, e), at);
  });
}

/** Export `ref` of the repository at `cwd` into a new temporary directory. */
export function copyBaseTree(cwd: string, ref: string): BaseCopy {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (top === undefined)
    return { kind: "failed", why: `${cwd} is not inside a git repository` };
  const sha = git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (sha === undefined)
    return { kind: "failed", why: `${ref} is not a commit in this clone` };
  const root = makeTmpDir("base");
  try {
    exportTree(top, sha.trim(), root);
    linkIgnored(top, root);
    return { kind: "copied", root, sha: sha.trim() };
  } catch (e) {
    cleanupTmpDir(root);
    const first = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return {
      kind: "failed",
      why: `could not copy ${ref} out of git (${first})`,
    };
  }
}

/** `git archive` of `sha` into `root`, through a tar file beside it (no shell, no buffer). */
function exportTree(top: string, sha: string, root: string): void {
  const tar = `${root}.tar`;
  try {
    execFileSync("git", ["archive", "--format=tar", `--output=${tar}`, sha], {
      cwd: top,
      stdio: "ignore",
    });
    execFileSync("tar", ["-xf", tar, "-C", root], { stdio: "ignore" });
  } finally {
    rmSync(tar, { force: true });
  }
}

/** Where `dir` sits inside its repository, so the copy is audited at the same place. */
export function placeInRepo(dir: string): string {
  const top = git(dir, ["rev-parse", "--show-toplevel"])?.trim();
  return top === undefined
    ? ""
    : relative(realpathSync(top), realpathSync(dir));
}

/**
 * Run `<node> <cli> audit . --format=json` inside the copy. Headless by its
 * format, so it loads no linter, asks nothing and stamps nothing. `undefined`
 * when it printed nothing.
 */
export function auditCopy(
  copy: string,
  place: string,
  cli: string,
): string | undefined {
  const r = spawnSync(process.execPath, [cli, "audit", ".", "--format=json"], {
    cwd: join(copy, place),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.stdout === "" ? undefined : r.stdout;
}
