/**
 * The disk's {@link RepoTree}: the exact path list of a scanned directory, so
 * the reference graph resolves against names rather than asking a filesystem
 * that may fold case (`src/core/repo-tree.ts` says why).
 *
 * Inside a git work tree: `git ls-files` from the directory — tracked files
 * plus untracked ones that are not ignored, and submodules by their gitlink
 * mode. `core.fsmonitor` is forced off: a foreign repository's `.git/config`
 * can name a program for it, and `audit` runs no code it did not ship.
 * Outside git (or when git refuses, e.g. `safe.directory`): a walk that skips
 * `.git` and `node_modules` and does not follow a symlinked directory.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { repoTreeOf, type RepoTree } from "../core/repo-tree.js";

/** `git ls-files --stage` puts `<mode> <sha> <stage>\t` before a tracked path. */
const STAGED = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]*)$/;

/** The gitlink mode: a submodule's root, whose contents are not listed. */
const GITLINK = "160000";

function gitListing(dir: string): string | undefined {
  try {
    return execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--stage",
      ],
      { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return undefined;
  }
}

/** A directory's entries; none when it cannot be read (absent, a file). */
function entriesOf(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file under `rel`, skipping `.git`, `node_modules` and linked dirs. */
function walk(root: string, rel: string): readonly string[] {
  return entriesOf(join(root, rel)).flatMap((e) => {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (!e.isDirectory()) return [path];
    return e.name === ".git" || e.name === "node_modules"
      ? []
      : walk(root, path);
  });
}

/** The path list of `dir`, relative to it, from git when it can answer. */
export function diskRepoTree(dir: string): RepoTree {
  const listing = gitListing(dir);
  // Empty from git: the directory is ignored by an enclosing repository.
  if (listing === undefined || listing === "") return repoTreeOf(walk(dir, ""));
  const entries = listing
    .split("\0")
    .filter((e) => e !== "")
    .map((entry) => {
      const staged = STAGED.exec(entry);
      return { path: staged?.[2] ?? entry, gitlink: staged?.[1] === GITLINK };
    });
  return repoTreeOf(
    entries.filter((e) => !e.gitlink).map((e) => e.path),
    entries.filter((e) => e.gitlink).map((e) => e.path),
  );
}
