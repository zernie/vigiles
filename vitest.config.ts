import { defineConfig, configDefaults } from "vitest/config";

// Vitest is the primary runner. Test tiers are encoded in the FILENAME so the
// capability level is legible and routed to its own project. Tiers live HERE, not
// in the exports map — the package splits its imports on COST (`vigiles` free /
// `vigiles/eval` paid), never on tier:
//   - `unit`        — `src/**/*.test.ts` MINUS the suffixed tiers: pure, no caps.
//   - `integration` — `src/**/*.integration.test.ts`: needs bwrap, no network.
//   - `e2e`         — `src/**/*.e2e.test.ts`: needs real egress / model / network
//                     (each test gates itself + skips honestly where unavailable).
//   - `runners`     — the cross-runner matcher constraint, loaded from `dist`.
// `vitest run` runs them all (e2e self-skips where it can't route); the per-tier
// `npm run test:unit|test:integration|test:e2e` scripts run one project for the
// per-level CI jobs.
const sourceTier = {
  // `.js` import specifiers resolve to their `.ts` source so NodeNext imports
  // work without a build step; suites can scan 7 catalogs / spawn the CLI.
  resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
  test: { testTimeout: 60000, hookTimeout: 60000 },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...sourceTier,
        test: {
          ...sourceTier.test,
          name: "unit",
          // `scripts/` is in scope on purpose: `check-doc-imports.mjs` is a CI gate, and a gate
          // with no test is the shape this repo has shipped dead three times. Its test lives
          // beside it (colocation), so the glob has to reach outside `src/`.
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            // The repo's own ESLint rules, tested beside the rule they check.
            "eslint-rules/**/*.test.ts",
          ],
          exclude: [
            ...configDefaults.exclude,
            "src/**/*.integration.test.ts",
            "src/**/*.e2e.test.ts",
          ],
        },
      },
      {
        ...sourceTier,
        test: {
          ...sourceTier.test,
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
        },
      },
      {
        ...sourceTier,
        test: {
          ...sourceTier.test,
          name: "e2e",
          include: ["src/**/*.e2e.test.ts"],
        },
      },
      {
        test: {
          name: "runners",
          include: ["test/runners/**/*.vitest.mjs"],
          setupFiles: ["./dist/vitest.mjs"],
        },
      },
    ],
    // 100% gate, scoped to the harness-testing pillar (the deterministic library
    // this suite owns end-to-end). The eval path's real `spawn` boundary is the
    // one thing a unit test can't reach — it carries a `v8 ignore` marker.
    coverage: {
      provider: "v8",
      include: [
        "src/harness-test.ts",
        "src/harness-assert.ts",
        "src/eval.ts",
        "src/eval-baseline.ts",
        "src/eval-cache.ts",
        "src/eval-lock.ts",
        "src/stats.ts",
        "src/run-hook.ts",
        "src/hook-state-store.ts",
        "src/run-script.ts",
        "src/mock-model.ts",
        "src/plugin-loader.ts",
        "src/judge.ts",
        "src/sandbox.ts",
        "src/egress.ts",
        "src/services.ts",
        "src/services-docker.ts",
        "src/core/rule-catalog.ts",
        "src/instruction-sources.ts",
        "src/share-link.ts",
        "src/exclude.ts",
      ],
      // 100% lines/functions/statements. Branches floor at 90: the remainder
      // are defensive fallbacks that can't be hit deterministically — `?? ""` on
      // already-typed CLI output, `n > 0 ? … : 0` on non-empty arrays, a
      // signal-kill exit code (`res.status ?? (res.signal ? 1 : 0)`). Gaming
      // those with ignores would only lower the signal.
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 90,
      },
      reporter: ["text", "lcov"],
    },
  },
});
