/**
 * THE RUNTIME'S ROOT IS THE PROJECT'S, NOT THE PROCESS'S — and nothing asserted
 * it until now.
 *
 * `runHookProgramCommand` computes the right answer on its first line
 * (`projectRootOf(event, process.env)`, hook-runtime.ts) and then never hands it
 * to the helpers underneath: `hookStampPath`, `loadHook`, the state store and the
 * observation ledger each reach for `process.cwd()` instead. Every existing E2E
 * spawns with a `cwd` that EQUALS the project root, so the two roots are the same
 * directory and no test can tell them apart.
 *
 * The sharpest consequence is not a misplaced file. `verifyStampOrRefuse` returns
 * SILENTLY when the sidecar is absent — so under a mismatched cwd the tamper check
 * does not point at the wrong file, it does not run at all. A hook edited after it
 * was compiled sails straight through.
 *
 * Both directions, because a test that only fires proves nothing about the probe.
 */
import { describe, test, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const HOOK_DIST = pathToFileURL(resolve(REPO_ROOT, "dist", "hook.js")).href;

const GATE = `import { experimental_defineHook, allow } from "${HOOK_DIST}";
export default experimental_defineHook({ on: "PreToolUse", decide: () => allow() });`;

/** A hook on disk, plus a stamp sidecar that deliberately does NOT match it. */
function plantTamperedHook(root: string): string {
  const file = resolve(root, "gate.mjs");
  writeFileSync(file, GATE);
  mkdirSync(resolve(root, ".vigiles", "hooks"), { recursive: true });
  writeFileSync(
    resolve(root, ".vigiles", "hooks", "gate.mjs.json"),
    JSON.stringify({ file, stamp: "0000000000000000" }) + "\n",
  );
  return file;
}

const fire = (file: string, opts: Parameters<typeof runHook>[2]) =>
  runHook(
    `node ${CLI} hook-runtime run-program ${file}`,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    },
    opts,
  );

describe("the tamper stamp is anchored on the project root", () => {
  test("REFUSES a hook whose stamp does not match, when cwd IS the root", () => {
    const dir = makeTmpDir();
    try {
      const file = plantTamperedHook(dir);
      const r = fire(file, { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
      expect(r.stderr).toMatch(/does not match its compiled stamp/);
      expect(r.exitCode).toBe(2);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("REFUSES IT JUST THE SAME when the process stands somewhere else", () => {
    const dir = makeTmpDir();
    const elsewhere = makeTmpDir();
    try {
      const file = plantTamperedHook(dir);
      const r = fire(file, {
        cwd: elsewhere,
        env: { CLAUDE_PROJECT_DIR: dir },
      });
      expect(r.stderr).toMatch(/does not match its compiled stamp/);
      expect(r.exitCode).toBe(2);
    } finally {
      cleanupTmpDir(elsewhere);
      cleanupTmpDir(dir);
    }
  });
});
