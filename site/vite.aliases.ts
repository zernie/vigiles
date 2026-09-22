import { fileURLToPath } from "node:url";

/**
 * The site's resolve aliases — shared by `vite.config.ts` (build) and
 * `vitest.config.ts` (browser tests) so the demo engine resolves identically in
 * both. `@engine/*` points at the BUILT `dist/` CJS (the literally-same compiled
 * code the CLI runs), and `node:zlib` swaps to a pako shim — the one node-builtin
 * the engine needs (gzip, for the NCD description-overlap check).
 */

/**
 * The engine modules the site imports — THE ONE LIST, and the only edit that
 * adding an `@engine/*` symbol costs.
 *
 * 🔴 IT USED TO COST THREE EDITS IN THREE FILES THAT NOTHING KEPT IN AGREEMENT:
 * this alias map, `vitest.config.ts`'s `optimizeDeps.include`, and
 * `tsconfig.json`'s `paths`. Miss the second and the browser suite dies with
 * "Failed to fetch dynamically imported module" — a message naming neither the
 * symbol nor the file that should have listed it. The previous pass hit exactly
 * that while adding `@engine/adapters/claude-code/dialect`.
 *
 * THE OTHER TWO ARE NOW DERIVED, each by the means its own format allows:
 *
 *   - `vitest.config.ts` imports {@link ENGINE_ALIAS_IDS} and spreads it.
 *   - `tsconfig.json` cannot import anything, so it carries ONE WILDCARD —
 *     `"@engine/*": ["../dist/*.d.ts"]` — which needs no per-symbol entry. That
 *     wildcard is correct only while every id maps to `dist/<the same tail>`,
 *     which is why the path below is BUILT from the module name instead of
 *     written beside it: a mismatched pair is unrepresentable rather than
 *     merely discouraged.
 *
 * ⚠️ WHAT THE WILDCARD OPENS, AND WHAT CLOSES IT. `tsc` will now accept an
 * `@engine/anything` whose `.d.ts` exists under `dist/`, alias or no alias — so
 * a forgotten entry would TYPECHECK and fail only in the browser, with that
 * same opaque message. `scripts/check-engine-aliases.mjs` (run by
 * `pretest:browser`) parses every import under `site/src` and fails, naming the
 * file and the specifier, on an `@engine/…` that is not in this list.
 *
 * ⚠️ `@engine/spec` WAS RENAMED TO `@engine/core/spec` (2026-09-21) to make the
 * mapping mechanical: it was the one id whose tail did not match its path
 * (`dist/core/spec.js`), and one exception is all a wildcard needs to be wrong.
 */
export const ENGINE_MODULES = [
  "scan-files",
  "audit-report",
  // `core/spec` joined on 2026-09-08, when `linters.browser.test.ts` started
  // importing `BUILTIN_LINTERS` to assert the hero's language chip and the
  // Wedge's linter strip are both derived from the engine's real list.
  "core/spec",
  // The layout port + the Claude Code layout: `fetchRepo.ts` DERIVES the set of
  // harness directories it fetches from them, instead of keeping a hand-written
  // copy of the directory names the layout already holds.
  "core/layout",
  "adapters/claude-code/layout",
  // And the DIALECT beside it, for the same "derive, do not re-list" reason:
  // `fetchRepo.ts` takes the root instruction filenames it fetches from
  // `instructionTargets`, which since v2.1.277 names `AGENTS.md` as well as
  // `CLAUDE.md`. A twin that fetched only `layout.instructionFile` would hand
  // the chain a map with no `AGENTS.md` in it and print a weight of zero for a
  // repository that really loads it.
  "adapters/claude-code/dialect",
] as const;

/** The bare specifiers — for `optimizeDeps.include` and for the guard script. */
export const ENGINE_ALIAS_IDS: readonly string[] = ENGINE_MODULES.map(
  (m) => `@engine/${m}`,
);

export const aliases: Record<string, string> = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  ...Object.fromEntries(
    ENGINE_MODULES.map((m) => [
      `@engine/${m}`,
      fileURLToPath(new URL(`../dist/${m}.js`, import.meta.url)),
    ]),
  ),
  // The /comparison snapshot is produced by a ROOT tool (tools/measure-validate-overlap.mjs)
  // and its freshness is asserted by a ROOT test (src/comparison-snapshot.test.ts), so it
  // LIVES at the root and the site consumes it. It used to live under site/, which made a
  // root test read a site file — the exact dependency that let a site-only PR merge green
  // and break main (#219). See src/ci-path-filter.test.ts.
  "@measured/validate-overlap.json": fileURLToPath(
    new URL("../tools/measured/validate-overlap.json", import.meta.url),
  ),
  "node:zlib": fileURLToPath(
    new URL("./src/lib/zlib-shim.ts", import.meta.url),
  ),
};
