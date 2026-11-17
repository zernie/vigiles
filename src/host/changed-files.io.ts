/**
 * The machine side of `vigiles test --changed=<ref>`: what git says changed,
 * and the file reads the import closure needs. The decision is pure and lives
 * in `src/core/test-selection.ts`.
 */
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChangedResult } from "../core/test-selection.js";
import { posixRelative, type SourceHost } from "../core/test-reach.js";

/** Reads for the import closure, from disk. */
export const nodeSourceHost: SourceHost = {
  read: (path) => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  },
  isFile: (path) =>
    statSync(path, { throwIfNoEntry: false })?.isFile() === true,
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  // tsc's own walk, so a tsconfig's `include`/`exclude` mean what tsc means.
  readDirectory: (...args: Readonly<Parameters<typeof ts.sys.readDirectory>>) =>
    ts.sys.readDirectory(...args),
};

function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

/** `ref` as a commit, its merge-base with HEAD when the clone has one. */
function baseOf(
  cwd: string,
  ref: string,
): { readonly base: string; readonly via: "merge-base" | "ref" } | undefined {
  const commit = git(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ])?.trim();
  if (commit === undefined) return undefined;
  const mergeBase = git(cwd, ["merge-base", commit, "HEAD"])?.trim();
  return mergeBase === undefined
    ? { base: commit, via: "ref" }
    : { base: mergeBase, via: "merge-base" };
}

/** Root-relative paths: the diff to the working tree, plus untracked files. */
function changedPaths(
  root: string,
  base: string,
): readonly string[] | undefined {
  const diff = git(root, ["diff", "--name-only", "--no-renames", "-z", base]);
  if (diff === undefined) return undefined;
  const untracked =
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
  return [...new Set([...diff.split("\0"), ...untracked.split("\0")])].filter(
    (p) => p !== "",
  );
}

/**
 * Files changed between `ref`'s merge-base with HEAD and the WORKING TREE:
 * committed, staged, unstaged, and untracked (not ignored). Renames count as
 * both paths. With no merge-base (a shallow clone, such as a CI checkout of a
 * pull request's merge commit), the ref itself is the base — for a merge commit
 * that is exactly the pull request's change, and elsewhere it can only add
 * files, never drop one. Paths come back relative to the REAL cwd.
 */
export function changedSince(cwd: string, ref: string): ChangedResult {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (root === undefined) {
    return {
      kind: "error",
      message: `--changed=${ref}: ${cwd} is not inside a git repository`,
    };
  }
  const found = baseOf(cwd, ref);
  if (found === undefined) {
    const hint = `In a shallow clone, fetch it first (git fetch origin ${ref}).`;
    return { kind: "error", message: `--changed=${ref}: unknown ref. ${hint}` };
  }
  const paths = changedPaths(root, found.base);
  if (paths === undefined) {
    return {
      kind: "error",
      message: `--changed=${ref}: git diff against ${found.base} failed`,
    };
  }
  const real = realpathSync(cwd);
  const rel = (p: string): string => posixRelative(real, join(root, p));
  return {
    kind: "ok",
    ...found,
    files: paths.map(rel).sort(),
    workflowsGlob: `${rel(".github/workflows")}/**`,
  };
}
