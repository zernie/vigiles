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

import { LOCAL_FILES, VIGILES_DIR } from "./local-files.js";

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
 * The one-line warning for {@link trackedLocalFiles}, or `null` when there is
 * nothing to say. Files inside a tracked local DIRECTORY (`state/`,
 * `eval-cache/`) are named by that directory, so one line stays one line and the
 * command it prints untracks all of them.
 */
export function formatTrackedLocalFiles(
  tracked: readonly string[],
): string | null {
  if (tracked.length === 0) return null;
  // `.vigiles/state/.claude/hooks/x.json` → `.vigiles/state`: the list entry.
  const entries = [
    ...new Set(tracked.map((p) => p.split("/").slice(0, 2).join("/"))),
  ];
  const one = entries.length === 1;
  return (
    `⚠ ${entries.join(", ")} ${one ? "is" : "are"} tracked by git, but ` +
    `${VIGILES_DIR}/ local files describe one checkout and would credit a ` +
    `machine where nothing ran. .gitignore does not untrack a tracked file; ` +
    `untrack ${one ? "it" : "them"} once: git rm -r --cached ${entries.join(" ")}`
  );
}

/** Print the warning for `root` to stderr when there is one. CLI-only. */
export function warnTrackedLocalFiles(root: string): void {
  const line = formatTrackedLocalFiles(trackedLocalFiles(root));
  if (line) process.stderr.write(line + "\n");
}
