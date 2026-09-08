import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { aliases } from "./vite.aliases";
import { ENGINE_VERSION } from "./vite.engine-version";
import { engineStamp, sweepStaleEngineCaches } from "./vite.engine-stamp";

// Key the dependency-prebundle cache on the BUILT engine's fingerprint. Vite
// otherwise keeps a prebundle of the PREVIOUS `dist/` across `npm run build` (it
// invalidates on config/lockfile changes, not on the mtimes of an aliased path
// outside node_modules), so the browser side computes against a stale engine and
// `browser-parity.browser.test.ts` fails with a field-level diff that looks
// exactly like a genuine pako-vs-node:zlib divergence. A different `dist/` is now
// a different cache directory, so that state is unreachable rather than merely
// detected. Full incident + why a key beats a check: ./vite.engine-stamp.ts.
const engineCacheDir = `.vite-engine-${engineStamp(
  fileURLToPath(new URL("../dist", import.meta.url)),
)}`;
sweepStaleEngineCaches(
  fileURLToPath(new URL("./node_modules", import.meta.url)),
  engineCacheDir,
);

// Browser-mode tests for the live demo (real Chromium + real pako, so the
// pako-vs-node-zlib parity is closed for real, not mocked). Runs
// `src/**/*.browser.test.{ts,tsx}` — the browser-parity check + the DemoAudit
// interaction tests. Kept separate from the root vitest projects (which own the
// engine's own suites); this config never touches those.
export default defineConfig({
  plugins: [react()],
  cacheDir: `node_modules/${engineCacheDir}`,
  resolve: { alias: aliases },
  // The engine dist is CJS living OUTSIDE node_modules. Have Vite's optimizer
  // (esbuild) pre-bundle it via the aliases — esbuild's CJS→ESM interop exposes
  // the named exports (`scanFiles`, `buildAuditReport`) the browser test imports,
  // and folds in the transitive require-graph (+ the `node:zlib`→pako shim).
  optimizeDeps: {
    // `@engine/spec` joined the list on 2026-09-08, when `linters.browser.test.ts`
    // started importing `BUILTIN_LINTERS` to assert the hero's language chip and
    // the Wedge's linter strip are both derived from the engine's real list.
    // Without the pre-bundle the CJS dist has no named exports through Vite's
    // ESM path and the suite fails to import at all — the same reason the three
    // entries beside it are here.
    include: [
      "@engine/scan-files",
      "@engine/audit-report",
      "@engine/spec",
      "pako",
    ],
    // @iarna/toml (a CJS engine dep) references bare `global`; the production
    // rollup build maps it, so give esbuild's pre-bundle the same define.
    esbuildOptions: { define: { global: "globalThis" } },
  },
  // Mirror the define for any non-optimized transform path too.
  define: {
    global: "globalThis",
    __ENGINE_V__: JSON.stringify(ENGINE_VERSION),
  },
  server: {
    fs: {
      // Allow importing the repo-root `dist/` (one level above the site root).
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
