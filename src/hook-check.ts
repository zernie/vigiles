/**
 * A check that runs when a session starts and says "run npm install" if files
 * that the repo's hooks need are missing.
 *
 * Why it exists (#312). A compiled hook lives in two places: the wiring in
 * `.claude/settings.json` (stored in git) and the files that wiring runs (in
 * `node_modules`, stored by npm). A fresh container, a merge that brings new
 * wiring, or a dependency update can change one without the other. Today the
 * first sign is a hook refusing the first command. This check notices one step
 * earlier and names the fix.
 *
 * What it does not do: fix anything. If a hook that can block commands has
 * missing files, it still refuses every shell command, including the install.
 * The check only says so before the first command is tried, so a person can run
 * the install from a terminal outside the session. Removing the cause would need
 * hook files stored in git next to their wiring; that is a separate decision
 * (#312).
 *
 * Three rules shape the code:
 *
 * - It must work when nothing is installed. So the script is plain POSIX `sh`
 *   using only built-in commands (no node, no vigiles, no grep), and it is
 *   committed, so it arrives together with the wiring.
 * - It only prints and always exits 0. We have not verified what exit code 2
 *   does at session start, and a check that could fail would be one more way to
 *   break the session it is meant to help. It is wired `|| exit 0`, like any
 *   reminder.
 * - It lists only what a compiled hook needs: the hook files named by
 *   `hook-runtime run-program` commands in the settings, plus the local runtime
 *   when it is started by path. Reporting any other script (say
 *   `scripts/build.sh`) as missing in a fresh clone would be a false alarm,
 *   because `npm install` does not create it.
 *
 * The list is read from the settings after `compile` has merged into them. So it
 * also covers hooks that another tool wrote there, and it does not shrink when
 * `compile` is run on just one hook. A hook added after the last `compile` is
 * not covered until the next one.
 *
 * Limits: it checks that a file exists, not that it loads. A package that is
 * present but no longer exports what a hook imports passes this check and still
 * breaks. A path is recognised by the same pattern the coverage code uses, which
 * has no room for spaces or quotes, so a hook under such a path is not covered,
 * and the check cannot say so.
 */
import { runProgramFiles } from "./coverage-probe.js";

/** Where the generated script is written. It is committed, next to the hook sources. */
export const HOOK_CHECK_REF = ".vigiles/hook-check.sh";

/**
 * Every `command` string in a parsed hooks block. It looks for the key `command`
 * instead of following one layout, because the layout depends on the harness
 * (Claude Code nests commands under a matcher block, Codex's TOML is flat).
 */
export function commandsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(commandsIn);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "command" && typeof value === "string"
      ? [value]
      : commandsIn(value),
  );
}

/** How a command may spell the project root. It is removed to leave a relative path. */
const PROJECT_ROOT_PREFIX =
  /^\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR)\//;

/** The characters a path may contain. It is written into a shell string and a JSON string. */
const SAFE_PATH = /^[A-Za-z0-9._@+/-]+$/;

export interface CheckPaths {
  /** Paths relative to the project, sorted, no duplicates: what the script tests. */
  readonly paths: readonly string[];
  /**
   * Paths the check found but cannot safely write into the script. `compile`
   * warns about each one, because a path left out is a hook the check does not
   * cover.
   */
  readonly unsafe: readonly string[];
}

/**
 * The files that the compiled-hook commands in `commands` need, as paths relative
 * to the project. Two kinds of path are left out on purpose: absolute paths
 * (another machine's checkout will not have them) and paths that use any variable
 * except the project root, such as `$HOME` or a plugin root (we cannot resolve
 * them here).
 */
export function checkPaths(commands: readonly string[]): CheckPaths {
  const relative = commands
    .flatMap(runProgramFiles)
    .map((file) => file.replace(PROJECT_ROOT_PREFIX, ""))
    .filter((file) => !file.startsWith("/") && !file.includes("$"));
  const unique = [...new Set(relative)].sort();
  return {
    paths: unique.filter((p) => SAFE_PATH.test(p)),
    unsafe: unique.filter((p) => !SAFE_PATH.test(p)),
  };
}

/**
 * The text of the script. The same paths always give the same text, so a
 * recompile that finds the same hooks writes the same bytes.
 *
 * The script prints JSON with an `additionalContext` field instead of plain text.
 * That form is confirmed for the start of a session on both Claude Code and
 * Codex; plain text is only confirmed on Claude Code.
 */
export function renderHookCheck(paths: readonly string[]): string {
  const list = paths.map((p) => `  '${p}'`).join(" \\\n");
  return `#!/bin/sh
# Generated by \`vigiles compile\`. Do not edit; the next compile rewrites it.
#
# Start-of-session notice (vigiles #312). If a file that a compiled hook runs is
# not installed, it says so in the first turn. It uses only plain sh and shell
# built-ins (no node, no node_modules, no vigiles), because "not installed" is
# exactly the situation it reports. It only prints and always exits 0.
#
# It does not fix anything. A hook that can block commands, with its files
# missing, refuses every shell command including the install, so the install has
# to be run from a terminal outside the session.
root="\${CLAUDE_PROJECT_DIR:-.}"
missing=""
for p in \\
${list}
do
  [ -e "$root/$p" ] || missing="$missing $p"
done
if [ -n "$missing" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\\n' \\
    "vigiles: hook files that this repo runs are not installed:$missing. Run npm ci (or npm install) from a terminal outside this session before anything else. A blocking hook whose files are missing refuses every shell command in a session, the install included; a reminder-only hook that cannot load is skipped. See docs/compiled-hooks.md, When a hook cannot load."
fi
exit 0
`;
}
