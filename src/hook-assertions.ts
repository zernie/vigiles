/**
 * Testing a COMPILED hook in-process — the assertions behind `vigiles/hook-test`.
 *
 * `experimental_loadHook(file)` loads the hook the way the runtime does, and these assert its
 * decision on a raw event: no subprocess, no model. They are NOT on `vigiles/hook`:
 * that entry is the only import a compiled hook may have, so anything on it is
 * reachable from inside every hook (src/hook-entry-effects.test.ts). This module
 * still stays small, because the CLI runner loads it beside the hook under test:
 * it imports the pure evaluator and the check counter, never the harness runner
 * or the eval tier.
 */
import { hookSource, runHookProgram } from "./core/hook-program.js";
import type {
  AnyHook,
  RawHookEvent,
  HookProgramOutcome,
} from "./core/hook-program.js";
import { recordCheck, recordSurfaceProbe } from "./check-count.js";

function fail(message: string): never {
  throw new Error(message);
}

/** Render a {@link HookProgramOutcome} for an assertion message. */
function describeOutcome(o: HookProgramOutcome): string {
  if (o.kind === "decision") return `${o.decision.kind} (a gate decision)`;
  if (o.kind === "injection") return `an injection`;
  return `${o.reaction.kind} (a reaction)`;
}

/**
 * `runHookProgram`, counted AND attributed. An in-process hook decision is an
 * observation the CLI runner can see — without it, a `*.harness.*` file that only
 * tests compiled hooks would look like it did nothing at all. See check-count.ts.
 *
 * 🔴 THE PROBE BELONGS HERE, AND NOWHERE EARLIER OR LATER. The documented
 * in-process path — `experimental_loadHook(file)` then `experimental_assertHookDenies(hook, event)` — used
 * to record a check and no SURFACE, so the child exited a non-vacuous pass with
 * an empty `surfaces` list, `runsFromResults` discarded it, and a harness that
 * genuinely executed a compiled hook produced NO execution record. The hook then
 * showed as untested unless filename colocation happened to cover it. Unlike
 * every other coverage finding in this review that is a false NEGATIVE — real
 * execution going unrecorded — which is why the bar for what gets recorded here
 * is the high one, not the cheap one.
 *
 * Not at LOAD: `experimental_loadHook` only remembers the path. Someone loading a hook to
 * inspect its shape has not run it, and crediting that would be the "an empty
 * file counts" substitution the execution tier exists to remove.
 *
 * Not in `runHookProgram`: that is the PURE evaluator, and it is what the CLI's
 * `hook-runtime run-program` calls on every live event in production. Recording
 * there would make the pure decision impure and would fire outside any test.
 *
 * This function is the only place that has both facts — the hook is about to be
 * evaluated, and (when it came from `experimental_loadHook`) we know its file. Four public
 * assertions funnel through it, so none of them can be added without inheriting
 * the attribution.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT ATTRIBUTE — run, not asserted. A hook built
 * in-process rather than loaded from disk has no file to name, so nothing is
 * recorded and nothing is invented:
 *
 *     const h = experimental_defineHook({…}); experimental_assertHookDenies(h, e);  → surfacesRecorded() === []
 *
 * …and a direct `runHookProgram(hook, event)` call (the pure evaluator, public
 * via `vigiles/hook`) records nothing either, for the reason above. Both cost a
 * missed record, never a false one.
 */
function runCountedHookProgram(
  hook: AnyHook,
  event: RawHookEvent,
): HookProgramOutcome {
  recordCheck();
  // `command`, the same shape a parsed hook ref gets — but note the provenance
  // differs: that one is inferred from a command string and is best-effort; this
  // one is the path `experimental_loadHook` resolved, so it is exact by construction.
  const source = hookSource(hook);
  if (source !== undefined) recordSurfaceProbe("command", source);
  return runHookProgram(hook, event);
}

/**
 * Assert a COMPILED hook (a `vigiles/hook` program) denies an event — evaluated
 * in-process, no subprocess, no model. The cheapest way to test a gate's logic:
 * pass the hook's default export and a raw event. (For the wired-into-the-real-CLI
 * check, use `check.blocked()` over a `runHook` result.)
 *
 * @experimental Tests the experimental compiled-hook vocabulary
 * (`experimental_define*`), so it moves with it.
 */
export function experimental_assertHookDenies(
  hook: AnyHook,
  event: RawHookEvent,
): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "decision" || o.decision.kind !== "deny") {
    fail(`expected the hook to deny, got ${describeOutcome(o)}`);
  }
}

/** Assert a COMPILED hook allows an event (in-process). The twin of {@link experimental_assertHookDenies}. *
 * @experimental Tests the experimental compiled-hook vocabulary
 * (`experimental_define*`), so it moves with it.
 */
export function experimental_assertHookAllows(
  hook: AnyHook,
  event: RawHookEvent,
): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "decision" || o.decision.kind !== "allow") {
    fail(`expected the hook to allow, got ${describeOutcome(o)}`);
  }
}

/**
 * Assert a COMPILED **react** hook emits a `notice(…)` for an event, optionally
 * matching its message — the react-tier twin of {@link experimental_assertHookDenies}.
 *
 * A react hook can't block, so the gate assertions don't apply to it, and there
 * was no assertion that did. That left `notice()` a live trap: a probe built on
 * `execFileSync` (which returns stdout only) reported a perfectly healthy react
 * hook as DEAD — measured against three real hooks on 2026-08-03. Reading the
 * reaction in-process means no stream enters into it, which is why this
 * assertion did not change when delivery did: since 2026-09-07 a notice also
 * goes to stdout as `additionalContext` on an event the harness injects (see
 * `noticeDelivery`), so WHICH stream carries it now depends on the event — a
 * stream probe is even less answerable than before, and this one is unaffected.
 *
 * @experimental Tests the experimental compiled-hook vocabulary
 * (`experimental_define*`), so it moves with it.
 */
export function experimental_assertHookNotices(
  hook: AnyHook,
  event: RawHookEvent,
  matcher?: string | RegExp,
): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "reaction" || o.reaction.kind !== "notice") {
    fail(`expected the hook to notice, got ${describeOutcome(o)}`);
  }
  if (matcher === undefined) return;
  const { message } = o.reaction;
  const matched =
    typeof matcher === "string"
      ? message.includes(matcher)
      : matcher.test(message);
  if (!matched) {
    fail(
      `expected the notice to match ${String(matcher)}, got ${JSON.stringify(message)}`,
    );
  }
}

/**
 * Assert a COMPILED **react** hook stays silent for an event — it returns
 * `nothing()` (a `"none"` reaction). The twin of {@link experimental_assertHookNotices}: together they pin both
 * halves of a react hook's behaviour — it fires when it should, and (the half
 * that actually regresses) it does NOT fire when it shouldn't.
 *
 * A `run(…)` reaction is not silent for this purpose: the hook still reacted.
 *
 * @experimental Tests the experimental compiled-hook vocabulary
 * (`experimental_define*`), so it moves with it.
 */
export function experimental_assertHookSilent(
  hook: AnyHook,
  event: RawHookEvent,
): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "reaction") {
    fail(`expected a react hook, got ${describeOutcome(o)}`);
  }
  if (o.reaction.kind !== "none") {
    fail(`expected the hook to stay silent, got ${describeOutcome(o)}`);
  }
}
