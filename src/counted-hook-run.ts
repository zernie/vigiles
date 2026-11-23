/**
 * The one in-process door for evaluating a compiled hook inside a TEST — shared
 * by the `assertHook*` assertions (harness-assert.ts) and the disaster battery
 * (guardrail-check.ts), so each run is counted and attributed the same way.
 * Not re-exported from any barrel.
 */
import {
  hookSource,
  runHookProgram,
  type AnyHook,
  type HookProgramOutcome,
  type RawHookEvent,
} from "./core/hook-program.js";
import { recordCheck, recordSurfaceProbe } from "./check-count.js";

/**
 * `runHookProgram`, counted AND attributed. An in-process hook decision is an
 * observation the CLI runner can see — without it, a `*.harness.*` file that only
 * tests compiled hooks would look like it did nothing at all. See check-count.ts.
 *
 * 🔴 THE PROBE BELONGS HERE, AND NOWHERE EARLIER OR LATER. The documented
 * in-process path — `loadHook(file)` then `assertHookDenies(hook, event)` — used
 * to record a check and no SURFACE, so the child exited a non-vacuous pass with
 * an empty `surfaces` list, `runsFromResults` discarded it, and a harness that
 * genuinely executed a compiled hook produced NO execution record. The hook then
 * showed as untested unless filename colocation happened to cover it. Unlike
 * every other coverage finding in this review that is a false NEGATIVE — real
 * execution going unrecorded — which is why the bar for what gets recorded here
 * is the high one, not the cheap one.
 *
 * Not at LOAD: `loadHook` only remembers the path. Someone loading a hook to
 * inspect its shape has not run it, and crediting that would be the "an empty
 * file counts" substitution the execution tier exists to remove.
 *
 * Not in `runHookProgram`: that is the PURE evaluator, and it is what the CLI's
 * `hook-runtime run-program` calls on every live event in production. Recording
 * there would make the pure decision impure and would fire outside any test.
 *
 * This function is the only place that has both facts — the hook is about to be
 * evaluated, and (when it came from `loadHook`) we know its file. Four public
 * assertions funnel through it, so none of them can be added without inheriting
 * the attribution.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT ATTRIBUTE — run, not asserted. A hook built
 * in-process rather than loaded from disk has no file to name, so nothing is
 * recorded and nothing is invented:
 *
 *     const h = experimental_defineHook({…}); assertHookDenies(h, e);  → surfacesRecorded() === []
 *
 * …and a direct `runHookProgram(hook, event)` call (the pure evaluator, public
 * via `vigiles/hook`) records nothing either, for the reason above. Both cost a
 * missed record, never a false one.
 *
 * The disaster battery (`guardrail-check.ts`) funnels a compiled hook through
 * here too, so a battery run is counted like any other in-process assertion.
 */
export function runCountedHookProgram(
  hook: AnyHook,
  event: RawHookEvent,
): HookProgramOutcome {
  recordCheck();
  // `command`, the same shape a parsed hook ref gets — but note the provenance
  // differs: that one is inferred from a command string and is best-effort; this
  // one is the path `loadHook` resolved, so it is exact by construction.
  const source = hookSource(hook);
  if (source !== undefined) recordSurfaceProbe("command", source);
  return runHookProgram(hook, event);
}
