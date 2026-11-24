/**
 * A harness resolves its bare `vigiles` import from the CLI's own install (#184).
 *
 * The report: a harness does `import { runHook } from "vigiles"`, so the package
 * must sit in a `node_modules` Node can reach. In a repo that already has a
 * `package.json`, the obvious way to put it there installs the WHOLE dependency
 * tree — measured at 840 packages in 2 minutes where vigiles alone is 42, with
 * one run sitting 11 minutes in that step before being cancelled. The reporter's
 * workaround was installing to a directory outside the workspace and symlinking
 * the tree back in.
 *
 * ⚠️ `NODE_PATH` is NOT the fix, and that was measured rather than assumed: Node
 * ignores it for ESM resolution and a harness is ESM. A resolver hook is the only
 * mechanism left short of a real `node_modules` entry.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
let dir: string;

beforeEach(() => {
  dir = makeTmpDir();
});
afterEach(() => {
  cleanupTmpDir(dir);
});

function runTest(): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CLI, "test"], {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        // Same reason as lint-contract.test.ts: annotation mode duplicates
        // message text and makes occurrence counts environment-dependent.
        env: { ...process.env, GITHUB_ACTIONS: undefined } as NodeJS.ProcessEnv,
      }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

test("a harness importing `vigiles` runs with NO project install (#184)", () => {
  // The load-bearing case: no package.json, no node_modules, nothing installed.
  writeFileSync(
    join(dir, "probe.harness.mjs"),
    `import { runHook } from "vigiles";\n` +
      `const r = runHook("exit 2", { hook_event_name: "PreToolUse", tool_name: "Bash" });\n` +
      `if (!r.blocked) { console.error("guard did not block"); process.exit(1); }\n` +
      `console.log("resolved and ran");\n`,
  );
  assert.equal(
    existsSync(join(dir, "node_modules")),
    false,
    "nothing installed",
  );

  const r = runTest();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /resolved and ran/);
  assert.match(r.out, /1 passed/);
});

test("a subpath import resolves through the package's own exports map", () => {
  // Not a guessed file path: `vigiles/spec` must obey the same `exports`
  // contract it would from a normal install, or the rescue would work for the
  // root specifier and quietly fail for every subpath.
  writeFileSync(
    join(dir, "sub.harness.mjs"),
    `import { instructionFile } from "vigiles/spec";\n` +
      `if (typeof instructionFile !== "function") process.exit(1);\n` +
      `console.log("subpath ok");\n`,
  );
  const r = runTest();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /subpath ok/);
});

test("an unrelated missing package is NOT rescued and NOT passed", () => {
  // The other half. The hook rescues ONLY the vigiles specifier; if it swallowed
  // or mis-resolved anything else, a harness with a real missing dependency would
  // fail somewhere confusing instead of at its own import.
  //
  // ⚠️ The expectation here is a LOUD SKIP, not exit 1, and that is the runner's
  // pre-existing documented contract rather than something this change relaxed:
  // a module that cannot LOAD executed no assertion, so it is "did not run" (like
  // a missing `claude`), and treating it as `fail` would retract yesterday's
  // coverage because the machine broke. It still prints `⊘ SKIPPED`, never `✓`,
  // and `--no-skip` — which this repo's own CI passes — turns it into a failure.
  writeFileSync(
    join(dir, "other.harness.mjs"),
    `import "definitely-not-a-real-package-xyz";\nconsole.log("should not reach");\n`,
  );
  const r = runTest();
  assert.match(
    r.out,
    /definitely-not-a-real-package-xyz/,
    "the real error is shown",
  );
  assert.equal(r.out.includes("should not reach"), false, "the body never ran");
  assert.match(r.out, /SKIPPED/, "loud, never folded into a pass");
  assert.doesNotMatch(r.out, /1 passed/);
});
