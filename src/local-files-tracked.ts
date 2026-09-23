/**
 * The half `.gitignore` cannot do: tell the owner when a per-checkout file under
 * `.vigiles/` is ALREADY tracked.
 *
 * `ensureLocalFilesIgnored` (`local-files.ts`) keeps new copies out of git, but
 * an ignore rule does not untrack a file git already follows — a repo that
 * committed `.vigiles/coverage.json` before this existed keeps committing every
 * rewrite of it. Only the owner can fix that (`git rm --cached`), and changing
 * the index is theirs to decide, so this reports and never acts.
 *
 * CLI-only, by construction: it spawns `git`, and a hook decision must never pay
 * for a child process. That is why it is a separate module from the ignore half,
 * which hook runtimes import.
 */
import { spawnSync } from "node:child_process";
import { posix } from "node:path";

import {
  LOCAL_FILES,
  LOCAL_GITIGNORE_FILE,
  VIGILES_DIR,
  entriesNotInEffect,
} from "./local-files.js";

/** `.vigiles/.gitignore`, repo-relative. */
const IGNORE_FILE = posix.join(VIGILES_DIR, LOCAL_GITIGNORE_FILE);

/**
 * The per-checkout files under `<root>/.vigiles/` that git tracks, as
 * repo-relative paths from `root`. Empty when nothing is tracked, when `root` is
 * not in a git work tree, or when `git` is missing — silence is the answer to
 * every "cannot tell".
 */
export function trackedLocalFiles(root: string): string[] {
  const specs = LOCAL_FILES.map((f) => posix.join(VIGILES_DIR, f.name));
  try {
    const r = spawnSync("git", ["ls-files", "-z", "--", ...specs], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return [];
    return r.stdout.split("\0").filter((p) => p !== "");
  } catch {
    return [];
  }
}

/**
 * Does the COMMITTED `.vigiles/.gitignore` (the one at `HEAD`) lack entries
 * vigiles needs — i.e. will vigiles' additions show up as a change to a tracked
 * file until someone commits them.
 *
 * The question is asked of `HEAD`, not of the worktree's dirtiness, and that
 * is the point (Codex review on #275, third pass). "The file is modified" was
 * the earlier predicate; it could not tell vigiles' additions from the owner's
 * own unrelated edit, and then advised committing work in progress. Reading the
 * committed copy answers only for vigiles' entries, staged or not, and says
 * nothing once they are committed, whatever else the owner is editing.
 * Silent on every "cannot tell": not in a repo, no `HEAD`, file not committed.
 */
export function committedIgnoreFileLacksEntries(root: string): boolean {
  try {
    const r = spawnSync("git", ["show", `HEAD:${IGNORE_FILE}`], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return false;
    return entriesNotInEffect(r.stdout).length > 0;
  } catch {
    return false;
  }
}

/**
 * The one-line warning for {@link trackedLocalFiles}, or `null` when there is
 * nothing to say. Files inside a tracked local DIRECTORY (`state/`,
 * `eval-cache/`) are named by that directory, so one line stays one line and the
 * command it prints untracks all of them.
 */
export function formatTrackedLocalFiles(
  tracked: readonly string[],
  committedLacksEntries = false,
): string | null {
  const lines: string[] = [];
  if (tracked.length > 0) {
    // `.vigiles/state/.claude/hooks/x.json` → `.vigiles/state`: the list entry.
    const entries = [
      ...new Set(tracked.map((p) => p.split("/").slice(0, 2).join("/"))),
    ];
    const one = entries.length === 1;
    lines.push(
      `⚠ ${entries.join(", ")} ${one ? "is" : "are"} tracked by git, but ` +
        `${VIGILES_DIR}/ local files describe one checkout and would credit a ` +
        `machine where nothing ran. .gitignore does not untrack a tracked file; ` +
        `untrack ${one ? "it" : "them"} once: git rm -r --cached ${entries.join(" ")}`,
    );
  }
  // Not "untrack it": the repo may keep its own rules there, and untracking
  // would take them away from everyone else.
  if (committedLacksEntries)
    lines.push(
      `⚠ ${IGNORE_FILE} is tracked by git and its committed version lacks ` +
        `vigiles' local-file entries, which vigiles adds to your copy. Commit ` +
        `those lines once; entries are appended only when missing.`,
    );
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Print the warning for `root` to stderr when there is one. CLI-only. */
export function warnTrackedLocalFiles(root: string): void {
  const line = formatTrackedLocalFiles(
    trackedLocalFiles(root),
    committedIgnoreFileLacksEntries(root),
  );
  if (line) process.stderr.write(line + "\n");
}
