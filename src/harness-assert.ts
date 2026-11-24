/**
 * vigiles — runner-agnostic helpers for harness tests / evals.
 *
 * `runHarnessTest` and `runEval` are plain async functions that return data, so
 * they already work inside any runner (node:test, vitest, jest, mocha). These
 * helpers remove the last bit of boilerplate without coupling to a runner:
 *
 *   - the throwing assertions NO `check.*` member covers — delivery of a nudge,
 *     egress and file-write allowlists — usable in every runner, including
 *     node:test which has no `expect.extend`. Everything else about a run is a
 *     check: `assertChecks(r, [check.tool("Bash"), check.wrote("out.txt")])`
 *     (src/check.ts). The flat `assertToolUsed`-style forms and the boolean
 *     predicates (`usedTool`, `skillResolved`, …) left in v49.
 *   - `vigilesMatchers` — register with `expect.extend(vigilesMatchers)` for
 *     `expect(...).toHaveCreated(...)` sugar. The signature is identical for
 *     vitest and jest, so the same object supports both.
 */
import type { HarnessTestResult } from "./harness-test.js";
import type { EvalReport } from "./core/eval-report.js";
import type { HookRunResult, EgressAttempt } from "./run-hook.js";
import { evalChecks, type Check } from "./check.js";

// --- Plain throwing assertions (any runner) --------------------------------

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

/**
 * Assert a `runHook` result's text REACHED THE MODEL — the assertion a nudge
 * test needs, because "the hook printed it" is not "the model received it".
 *
 * Reads {@link HookRunResult.delivery}: passes only on `delivered`. Each other
 * verdict fails with its own cause — the five are different facts and a red
 * test must name the right one:
 * - `undelivered` — text went to a stream this event does not deliver (the
 *   measured case: stderr at exit 0 on `PostToolUse`). Names the stream, the
 *   bytes, and the cure.
 * - `silent` — nothing addressed to the model, or the hook never ran (its
 *   condition did not match).
 * - `blocked` — a veto, which is not a nudge; check it with `check.blocked()`.
 * - `unknown` — the event has no row in the harness's capability table, so
 *   delivery cannot be judged. FAILS rather than passes (`no-silent-skips`):
 *   pass `capabilities` to `runHook`, or add the row.
 */
export function assertDelivered(r: HookRunResult): void {
  const d = r.delivery;
  switch (d.kind) {
    case "delivered":
      return;
    case "undelivered":
      return fail(
        `expected the hook's output to reach the model, but none did (exit ${String(r.exitCode)}):\n` +
          d.stranded
            .map((s) => `  - ${String(s.bytes)} bytes on ${s.stream}: ${s.why}`)
            .join("\n"),
      );
    case "silent":
      return fail(
        r.ran
          ? `expected the hook's output to reach the model, but it printed nothing addressed to the model (exit ${String(r.exitCode)})`
          : `expected the hook's output to reach the model, but the hook never ran: ${r.conditionReason}`,
      );
    case "blocked":
      return fail(
        `expected a delivered nudge, but the hook BLOCKED the action (exit ${String(r.exitCode)}) — a block is not a nudge; assert it with check.blocked()`,
      );
    case "unknown":
      return fail(
        `delivery cannot be judged: ${d.why}. Pass the adapter's capability table as runHook's \`capabilities\` option.`,
      );
  }
}

// --- egress (network) — recordEgress runs ----------------------------------
//
// A `runHook(..., { recordEgress: true })` confines the hook AND records every
// host:port a proxy-honoring tool tried to reach (then blocks it). These assert
// over that record: a hook should phone home to nothing, or only to an allowlist.

/** Anything carrying recorded egress attempts (a runHook recordEgress result). */
interface HasEgress {
  readonly egress: readonly EgressAttempt[];
}

const hostPort = (e: EgressAttempt): string => `${e.host}:${String(e.port)}`;

/**
 * Assert every egress attempt went to an allowed host. `allowed` matches a host
 * (exact string or regex), or a specific `host:port`. Any attempt outside the
 * allowlist fails, naming the offender — exfil / unexpected-registry detection.
 */
export function assertEgressOnly(
  r: HasEgress,
  allowed: ReadonlyArray<string | RegExp>,
): void {
  const ok = (e: EgressAttempt): boolean =>
    allowed.some((a) =>
      typeof a === "string"
        ? a === e.host || a === hostPort(e)
        : a.test(e.host) || a.test(hostPort(e)),
    );
  const bad = r.egress.filter((e) => !ok(e));
  if (bad.length > 0) {
    fail(`egress to non-allowlisted host(s): ${bad.map(hostPort).join(", ")}`);
  }
}

// --- file writes (IO) — confined runs --------------------------------------
//
// A confined `runHook` records what the hook wrote to its work dir
// (`r.filesWritten`, relative paths). These assert a hook touched only the files
// it should — e.g. "wrote nothing but its own state cache".

/**
 * Anything carrying recorded file writes (a confined `runHook`/`runScript`
 * result). `filesWritten` is OPTIONAL on purpose: `undefined` means the run
 * never recorded writes at all, which is a different fact from `[]` ("recorded,
 * and it wrote nothing"). See {@link requireWrites}.
 */
interface HasWrites {
  readonly filesWritten?: readonly string[];
}

const matches = (f: string, p: string | RegExp): boolean =>
  typeof p === "string" ? f.includes(p) : p.test(f);

/**
 * The recorded write list, or a THROW when the run never recorded one.
 *
 * Writes are captured by diffing the work dir, which only happens on a confined
 * run. An unconfined run therefore knows nothing about what the program wrote —
 * and an assertion that silently treats "nobody looked" as "nothing happened"
 * reports success while inspecting no evidence. That is the failure mode this
 * whole library exists to catch in other people's harnesses, so it must not be
 * this library's own default. Refuse instead, and name the fix.
 */
function requireWrites(r: HasWrites, assertion: string): readonly string[] {
  if (r.filesWritten !== undefined) return r.filesWritten;
  return fail(
    `${assertion} cannot run: this result never recorded file writes, so ` +
      `passing it would assert nothing. Writes are captured by diffing the work ` +
      `dir, which only a CONFINED run does — pass \`{ sandbox: "auto" }\` (or ` +
      `\`"strict"\`) to record them. Note confinement needs Linux + bubblewrap.`,
  );
}

/** Assert the run wrote NO file matching `pattern` (substring or regex). */
export function assertNoWrite(r: HasWrites, pattern: string | RegExp): void {
  const bad = requireWrites(r, "assertNoWrite").filter((f) =>
    matches(f, pattern),
  );
  if (bad.length > 0) {
    fail(
      `expected no write matching ${String(pattern)}, but wrote: ${bad.join(", ")}`,
    );
  }
}

/** Assert every file the run wrote matches one of `allowed` (substring or regex). */
export function assertWroteOnly(
  r: HasWrites,
  allowed: ReadonlyArray<string | RegExp>,
): void {
  const bad = requireWrites(r, "assertWroteOnly").filter(
    (f) => !allowed.some((a) => matches(f, a)),
  );
  if (bad.length > 0) {
    fail(`run wrote file(s) outside the allowlist: ${bad.join(", ")}`);
  }
}

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
