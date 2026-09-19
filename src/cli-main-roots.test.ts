/**
 * THE HOOK-RUNTIME RAILS RESOLVE THEIR ROOT FROM THE PROCESS, NOT THE PROJECT.
 *
 * `.claude/settings.json` wires a second, non-compiled execution path —
 * `npx vigiles hook-runtime <kind>` — and every handler behind it reaches for
 * `process.cwd()` to find the project. The hook process has no stable cwd: under
 * a git worktree, or after the session `cd`s into a subdirectory, the process
 * stands somewhere the project's files are not.
 *
 * The `action` rail makes that observable from outside the process, because its
 * whole job is to read `.vigiles/action-gates.json` FROM THE ROOT and then run
 * the gates THERE:
 *
 *   - wrong root → the gates file is not found → `loadActionGates` returns `[]`
 *     → every action is allowed. The gate does not misfire; it does not run at
 *     all, and an allow is indistinguishable from a project with no gates.
 *   - right file, wrong exec cwd → a repo-relative `file:` gate cannot see its
 *     own file and blocks on a project that is in fact fine.
 *
 * The ladder below separates those two: gate 1 passes ONLY when the gates run in
 * the root, gate 2 always fails. So the single message `\`exit 3\` did not pass`
 * proves both — the file was loaded from the root AND the gates ran there.
 * A message about `root-marker.txt` means the file was found but executed
 * elsewhere; exit 0 means it was never found.
 *
 * Three halves, because a test that only fires proves nothing about the probe:
 * cwd == root (the probe is real), cwd elsewhere with `$CLAUDE_PROJECT_DIR`, and
 * cwd elsewhere with no env at all — the root carried by the event's own `cwd`,
 * which these handlers parse out of stdin and throw away.
 */
import { describe, test, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");

/**
 * A project whose action gates are legible only from its own root: a `file:`
 * gate on a marker that exists nowhere else, then a gate that always fails.
 */
function plantActionGates(root: string): void {
  mkdirSync(resolve(root, ".vigiles"), { recursive: true });
  writeFileSync(resolve(root, "root-marker.txt"), "marker\n");
  writeFileSync(
    resolve(root, ".vigiles", "action-gates.json"),
    JSON.stringify({
      gates: [
        { on: "Write", gate: { kind: "file", path: "root-marker.txt" } },
        { on: "Write", gate: { kind: "cmd", command: "exit 3", retry: 1 } },
      ],
    }) + "\n",
  );
}

const fire = (
  root: string,
  opts: Parameters<typeof runHook>[2] & { readonly cwd: string },
) =>
  runHook(
    `node ${CLI} hook-runtime action`,
    {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: resolve(root, "note.md") },
      cwd: root,
    },
    opts,
  );

describe("the action rail is anchored on the project root", () => {
  test("BLOCKS on a failing gate when cwd IS the root", () => {
    const dir = makeTmpDir();
    try {
      plantActionGates(dir);
      const r = fire(dir, { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
      expect(r.stderr).toMatch(/`exit 3` did not pass/);
      expect(r.exitCode).toBe(2);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("BLOCKS IT JUST THE SAME when the process stands somewhere else", () => {
    const dir = makeTmpDir();
    const elsewhere = makeTmpDir();
    try {
      plantActionGates(dir);
      const r = fire(dir, { cwd: elsewhere, env: { CLAUDE_PROJECT_DIR: dir } });
      expect(r.stderr).toMatch(/`exit 3` did not pass/);
      expect(r.exitCode).toBe(2);
    } finally {
      cleanupTmpDir(elsewhere);
      cleanupTmpDir(dir);
    }
  });

  test("BLOCKS on the root the EVENT carries, with no env to help", () => {
    const dir = makeTmpDir();
    const elsewhere = makeTmpDir();
    try {
      plantActionGates(dir);
      // Empty, not absent: the ambient session may well export this, and a test
      // that silently inherits the right answer is not testing the payload path.
      const r = fire(dir, { cwd: elsewhere, env: { CLAUDE_PROJECT_DIR: "" } });
      expect(r.stderr).toMatch(/`exit 3` did not pass/);
      expect(r.exitCode).toBe(2);
    } finally {
      cleanupTmpDir(elsewhere);
      cleanupTmpDir(dir);
    }
  });
});
