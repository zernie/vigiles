/**
 * `loadHook` — load a compiled-hook program from a FILE.
 *
 * The in-process assertions (`assertHookDenies` / `assertHookAllows` /
 * `assertHookNotices` / `assertHookSilent`) take the hook OBJECT, but a
 * `.harness.mjs` test only has the hook's PATH — and the loader that turns one
 * into the other lived privately inside `cli.ts`. So the intended in-process test
 * path was unreachable from the file format `vigiles test` actually runs, and
 * authors fell back to spawning the runtime as a subprocess: exactly the plumbing
 * compiled hooks exist to remove. Measured 2026-08-03.
 *
 * This is now the ONE loader — the CLI runtime calls it too, so a hook that loads
 * in a test loads identically in production (one loader, no drift).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HookCompileError,
  rememberHookSource,
  type AnyHook,
} from "./core/hook-program.js";

/**
 * Load a compiled-hook program's default export from `file`.
 *
 * JS module formats (`.mjs`/`.cjs`/`.js`) load via dynamic import directly; a
 * TypeScript hook (`.ts`/`.mts`/`.cts`) loads only under a TS-capable runtime
 * (tsx, or Node >= 23.6 with type stripping) — otherwise the error says so and
 * points at authoring the hook as `.mjs`.
 *
 * ```js
 * import { loadHook, assertHookDenies } from "vigiles";
 *
 * const guard = await loadHook(".vigiles/hooks/guard.mjs");
 * assertHookDenies(guard, {
 *   tool_name: "Bash",
 *   tool_input: { command: "git push --force" },
 * });
 * ```
 *
 * @throws {HookCompileError} when the file can't be imported, or has no
 * default-exported hook program.
 */
export async function loadHook(
  file: string,
  root: string = process.cwd(),
): Promise<AnyHook> {
  const abs = resolve(root, file);
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  } catch (e) {
    if (/\.(?:m|c)?ts$/.test(file)) {
      throw new HookCompileError(
        `Cannot load TypeScript hook "${file}" in this Node runtime. Run under ` +
          `tsx (npx tsx …) / Node >= 23.6, or author the hook as a .mjs file.`,
      );
    }
    throw new HookCompileError(
      `Cannot load hook "${file}": ${(e as Error).message}`,
    );
  }
  // Unwrap the ESM/CJS double-default that `export default` can produce.
  const program =
    (mod.default as { default?: unknown } | undefined)?.default ?? mod.default;
  if (!program || typeof program !== "object") {
    throw new HookCompileError(
      `${file} has no default-exported hook program ` +
        `(use \`export default experimental_defineHook({…})\`).`,
    );
  }
  // Remember WHERE it came from, so the assertion that later EVALUATES it can
  // attribute execution coverage without parsing anything. Remembering is not
  // recording: a load attributes nothing (see `hookSource` in core/hook-program).
  const hook = program as AnyHook;
  rememberHookSource(hook, file);
  return hook;
}
