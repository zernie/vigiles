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
 * Is `.vigiles/.gitignore` tracked AND carrying uncommitted edits.
 *
 * A repo may track that file for its own rules. vigiles then appends its entries
 * to a TRACKED file, which the self-entry `/.gitignore` cannot hide — git ignores
 * only untracked files (Codex review on #274). Tracked alone is not worth a word:
 * once the additions are committed the file stays clean, because entries are
 * appended only when missing, and a warning that repeats on every run gets
 * switched off. So the question is "tracked and changed", and `git diff`
 * answers exactly that (it lists only tracked paths). Silent on every "cannot
 * tell", like {@link trackedLocalFiles}.
 */
export function ignoreFileEditedWhileTracked(root: string): boolean {
  try {
    const r = spawnSync("git", ["diff", "--name-only", "--", IGNORE_FILE], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      r.status === 0 && typeof r.stdout === "string" && r.stdout.trim() !== ""
    );
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
  ignoreFileEdited = false,
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
  if (ignoreFileEdited)
    lines.push(
      `⚠ ${IGNORE_FILE} is tracked by git and vigiles added its local-file ` +
        `entries to it. Commit that change once; entries are appended only when missing.`,
    );
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Print the warning for `root` to stderr when there is one. CLI-only. */
export function warnTrackedLocalFiles(root: string): void {
  const line = formatTrackedLocalFiles(
    trackedLocalFiles(root),
    ignoreFileEditedWhileTracked(root),
  );
  if (line) process.stderr.write(line + "\n");
}
