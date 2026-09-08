/**
 * `loadHook` — the public compiled-hook loader (vitest).
 *
 * The in-process assertions take the hook OBJECT, but a `.harness.mjs` test only
 * has its PATH. Until this was exported the intended in-process test path was
 * unreachable from the file format `vigiles test` runs, so authors spawned the
 * runtime as a subprocess instead — the plumbing compiled hooks exist to remove.
 *
 * These drive the loader over REAL files on disk (it's an ESM dynamic import;
 * there is nothing to fake) and pin the error messages, which are the whole
 * reason a loader is public rather than a one-line `await import()`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { loadHook } from "./load-hook.js";
import { HookCompileError } from "./core/hook-program.js";
import { assertHookDenies, assertHookAllows } from "./harness-assert.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const HOOK_DIST = pathToFileURL(
  resolve(__dirname, "..", "dist", "hook.js"),
).href;

const GATE = `import { experimental_defineHook, tool, deny, allow } from "${HOOK_DIST}";
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true }) ? deny("no force-push") : allow(),
});`;

test("loadHook: a loaded hook feeds the in-process assertions directly", async () => {
  const dir = makeTmpDir();
  try {
    const file = resolve(dir, "guard.mjs");
    writeFileSync(file, GATE);

    // THE pattern a .harness.mjs test uses: path in, assertions over the object.
    const guard = await loadHook(file);
    assertHookDenies(guard, {
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
    });
    assertHookAllows(guard, {
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
  } finally {
    cleanupTmpDir(dir);
  }
});

test("loadHook: resolves a RELATIVE path against the cwd, not against this module", async () => {
  const dir = makeTmpDir();
  try {
    const abs = resolve(dir, "guard.mjs");
    writeFileSync(abs, GATE);
    // The path a .harness.mjs test would actually pass — relative to where the
    // test process runs, not to the loader's own file.
    const rel = relative(process.cwd(), abs);
    assert.ok(!rel.startsWith("/"), "the fixture path must be relative");
    const guard = await loadHook(rel);
    assertHookAllows(guard, {
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
  } finally {
    cleanupTmpDir(dir);
  }
});

test("loadHook: a module with no default export fails with an actionable error", async () => {
  const dir = makeTmpDir();
  try {
    const file = resolve(dir, "not-a-hook.mjs");
    writeFileSync(file, `export const notDefault = 1;`);
    await assert.rejects(
      () => loadHook(file),
      (e: Error) =>
        e instanceof HookCompileError &&
        /use `export default experimental_defineHook/.test(e.message),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("loadHook: an unimportable file reports WHY, not just that it failed", async () => {
  const dir = makeTmpDir();
  try {
    const file = resolve(dir, "broken.mjs");
    writeFileSync(file, `export default {{{ not javascript`);
    await assert.rejects(
      () => loadHook(file),
      (e: Error) =>
        e instanceof HookCompileError && /^Cannot load hook /.test(e.message),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("loadHook: a TypeScript hook on a non-TS runtime says how to fix it", async () => {
  const dir = makeTmpDir();
  try {
    const file = resolve(dir, "guard.hook.ts");
    // Deliberately unparseable AS JS too, so the failure is the runtime's
    // inability to load TS on any Node that lacks type stripping.
    writeFileSync(file, `const x: number = 1;\nexport default {{{`);
    await assert.rejects(
      () => loadHook(file),
      (e: Error) =>
        e instanceof HookCompileError &&
        /Run under tsx .*Node >= 23\.6, or author the hook as a \.mjs file/s.test(
          e.message,
        ),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
