/**
 * vigiles — runner-agnostic helpers for harness tests / evals.
 *
 * `runHarnessTest` and `runEval` are plain async functions that return data, so
 * they already work inside any runner (node:test, vitest, jest, mocha). These
 * helpers remove the last bit of boilerplate without coupling to a runner:
 *
 *   - `skip` — end a `*.harness.*` / `*.eval.*` script as a loud SKIPPED.
 *   Every assertion about a run is a check (src/check.ts):
 *   `assertChecks(r, [check.tool("Bash"), check.delivered()])`. The flat
 *   `assertToolUsed`-style forms, the boolean predicates and the last throwing
 *   assertions (`assertDelivered`, `assertEgressOnly`, `assertNoWrite`,
 *   `assertWroteOnly`) became `check.*` members in v50.
 *   - `vigilesMatchers` — register with `expect.extend(vigilesMatchers)` for
 *     `expect(...).toHaveCreated(...)` sugar. The signature is identical for
 *     vitest and jest, so the same object supports both.
 */
import type { HarnessTestResult } from "./harness-test.js";
import type { EvalReport } from "./core/eval-report.js";
import type { HookRunResult } from "./run-hook.js";
import { evalChecks, type Check } from "./check.js";

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Mark the current `*.harness.*` / `*.eval.*` SCRIPT as SKIPPED and exit, so
 * `vigiles test` / `vigiles eval` report a loud `⊘ SKIPPED` instead of a silent
 * `✓` — e.g. the deterministic tier when the `claude` CLI isn't installed. A skip
 * never fails the run. Exit 77 is the runner's `SKIP_EXIT_CODE` (run-scripts.ts).
 *
 * For standalone CLI-fallback scripts only — inside a runner (vitest / jest /
 * node:test) use that runner's own skip, not a process exit.
 */
/* v8 ignore start -- process.exit can't be exercised in-process (tested via a child in cli.test.ts / run-scripts.test.ts) */
export function skip(reason?: string): never {
  console.log(`SKIPPED${reason ? `: ${reason}` : ""}`);
  process.exit(77);
}
/* v8 ignore stop */

// --- jest / vitest matchers (expect.extend) --------------------------------

interface MatcherOutput {
  pass: boolean;
  message: () => string;
}

/**
 * Custom matchers compatible with both vitest and jest. Register once:
 *
 *   import { expect } from "vitest"; // or "@jest/globals"
 *   import { vigilesMatchers } from "vigiles";
 *   expect.extend(vigilesMatchers);
 *
 *   expect(result).toHaveCreated("RESULT");
 *   expect(report).toBeatBaseline("vanilla", "gated", "caught");
 */
export const vigilesMatchers = {
  toHaveCreated(received: HarnessTestResult, path: string): MatcherOutput {
    const pass = received.file(path) !== null;
    return {
      pass,
      message: () => `expected the run ${pass ? "not " : ""}to create ${path}`,
    };
  },
  toBlock(received: HookRunResult): MatcherOutput {
    const pass = received.blocked;
    return {
      pass,
      message: () =>
        `expected the hook ${pass ? "not " : ""}to block (exit ${String(received.exitCode)}, decision ${String(received.decision)})`,
    };
  },
  // eslint-disable-next-line max-params -- jest/vitest matchers take positional args
  toBeatBaseline(
    received: EvalReport,
    baseline: string,
    arm: string,
    metric: string,
    by = 0,
  ): MatcherOutput {
    const a = received.arms[arm]?.metrics[metric];
    const b = received.arms[baseline]?.metrics[metric];
    if (a === undefined || b === undefined) {
      fail(`no data to compare ${arm} vs ${baseline} on ${metric}`);
    }
    const delta = a - b;
    const pass = delta > by;
    return {
      pass,
      message: () =>
        `expected ${arm} ${pass ? "not " : ""}to beat ${baseline} on ${metric} by > ${String(by)} (got ${delta.toFixed(3)})`,
    };
  },
  // The check-vocabulary veneer (Phase 1): ONE matcher works for EVERY check,
  // carrying the check's own failure message. `expect(r).toPass(tool("Bash"))`.
  toPass<T>(received: T, check: Check<T>): MatcherOutput {
    const r = check.eval(received);
    return { pass: r.pass, message: () => r.message };
  },
  toPassAll<T>(received: T, checks: readonly Check<T>[]): MatcherOutput {
    const failed = evalChecks(received, checks).filter((x) => !x.pass);
    return {
      pass: failed.length === 0,
      message: () =>
        failed.length === 0
          ? "all checks passed"
          : failed.map((f) => `  ✗ ${f.message}`).join("\n"),
    };
  },
};
