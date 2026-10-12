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
import { execFileSync } from "node:child_process";
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

/**
 * What a REAL Node says, not vitest: vitest transforms TypeScript itself, so an
 * in-process import of a `.ts` hook never meets the runtime's limits. The
 * built loader runs in a child `node`, as `vigiles hook-runtime` does.
 */
function loadInNode(file: string): string {
  const loader = resolve(__dirname, "..", "dist", "load-hook.js");
  const script =
    `require(${JSON.stringify(loader)}).loadHook(${JSON.stringify(file)})` +
    `.then(() => console.log("loaded"), (e) => console.log(e.message));`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" });
}

test("loadHook: a .ts hook that fails for another reason names THAT reason, not TypeScript", () => {
  const dir = makeTmpDir();
  try {
    const file = resolve(dir, "guard.hook.ts");
    writeFileSync(
      file,
      `import x from "vigiles-no-such-package";\nconst n: number = 1;\nexport default x ?? n;\n`,
    );
    const out = loadInNode(file);
    if ("typescript" in process.features && process.features.typescript) {
      // This Node strips types: the hook loaded as TypeScript and failed on
      // its import. Blaming TypeScript sent the author to install tsx.
      assert.match(out, /Cannot find package 'vigiles-no-such-package'/);
      assert.doesNotMatch(out, /Run under tsx/);
    } else {
      // No type stripping at all: here TypeScript IS the reason.
      assert.match(out, /Run under tsx/);
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

test("loadHook: TypeScript the runtime cannot strip is blamed on the runtime, with its own words", () => {
  const dir = makeTmpDir();
  try {
    const file = resolve(dir, "guard.hook.ts");
    // An `enum` needs a transform, not stripping: no Node loads it without one.
    writeFileSync(file, `enum E { A }\nexport default { e: E.A };\n`);
    const out = loadInNode(file);
    assert.match(out, /Run under tsx .*or author the hook as a \.mjs file/s);
    // …and quotes the runtime's own reason, so the author sees which limit.
    assert.match(out, /in this Node runtime \(.+\)\./);
  } finally {
    cleanupTmpDir(dir);
  }
});
