import { fileURLToPath } from "node:url";

/**
 * The site's resolve aliases — shared by `vite.config.ts` (build) and
 * `vitest.config.ts` (browser tests) so the demo engine resolves identically in
 * both. `@engine/*` points at the BUILT `dist/` CJS (the literally-same compiled
 * code the CLI runs), and `node:zlib` swaps to a pako shim — the one node-builtin
 * the engine needs (gzip, for the NCD description-overlap check).
 */
export const aliases: Record<string, string> = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "@engine/scan-files": fileURLToPath(
    new URL("../dist/scan-files.js", import.meta.url),
  ),
  "@engine/audit-report": fileURLToPath(
    new URL("../dist/audit-report.js", import.meta.url),
  ),
  "@engine/spec": fileURLToPath(
    new URL("../dist/core/spec.js", import.meta.url),
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
