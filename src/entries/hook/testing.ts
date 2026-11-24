// 🔴 PUBLIC ENTRY POINT `vigiles/hook/testing` — every export here is a promise to users. The default
// for a symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b)
// it is a deliberate extension point listed in STABILITY.md. Review point: the diff of
// `api-surface/vigiles-hook-testing.api.md`, which `npm run api:check` fails on.
/**
 * `vigiles/hook/testing` — everything for testing a hook: load a compiled hook
 * in-process, run it on a raw event, assert what it decided, and prove a guard
 * blocks every disaster while letting the same text through when it is only
 * data. No subprocess, no model call.
 *
 * Its reader is someone TESTING a hook, never the hook itself. It is a
 * separate door from `vigiles/hook` for a security reason, not a tidiness one:
 * `vigiles/hook` is the only import a compiled hook may have, so anything on it
 * is reachable from inside every hook. `experimental_loadHook` imports a module
 * by path; on `vigiles/hook` it let a hook load code that no capability check
 * reads and no stamp covers. A compiled hook that imports this entry does not
 * compile (`checkHookImports`).
 *
 * The name follows the `@angular/core/testing` convention: "X and its tests"
 * is a second level under X. It replaces `vigiles/hook/testing` and
 * `vigiles/hook/testing` (v51), which served the same person.
 *
 *   import { experimental_defineHook } from "vigiles/hook";      // in the hook
 *   import { experimental_loadHook, runHookProgram, experimental_decision,
 *     runGuardrail, guardrail } from "vigiles/hook/testing";     // in its test
 *
 * Names say the role (v53): `run…` runs and returns a result, a check is named
 * after what it observes, case sets are nouns, and `assertChecks` / `toPass`
 * are the one place that throws.
 */

// --- in-process: load a compiled hook, run it, check the decision ---
// Load a hook the way the runtime does (the runtime calls the same loader).
export { experimental_loadHook } from "../../load-hook.js";

// The runner: one raw event in, the hook's outcome out, dispatched by role —
// the pure evaluator, counted and attributed for the test runner. And the check
// over that outcome (v53: one check replaces four throwing assertions).
export {
  runHookProgram,
  experimental_decision,
} from "../../hook-assertions.js";
export type { ExpectedDecision } from "../../hook-assertions.js";
export type {
  RawHookEvent,
  HookProgramOutcome,
} from "../../core/hook-program.js";

// --- the guard battery: every disaster blocked, every harmless twin allowed ---
// One runner, case sets as values, one check (v53). `runGuardrail` returns the
// rows and never throws; `guardrail()` is the check over them, so it goes
// through `assertChecks` / `expect(r).toPass(...)` like every other check. The
// check lives HERE, not as `check.guardrail` on the root: its only input is
// this entry's runner result, and its reader is this entry's (a hook author
// proving a guard blocks). The case sets: `disasters(...)` (the default; the
// spelling and look-alike generators, formerly two exports, are its fields)
// and `experimental_crossRepo(...)` (#418).
export {
  DISASTER_CATALOG,
  disasters,
  experimental_crossRepo,
  runGuardrail,
  guardrail,
} from "../../guardrail-check.js";
export type {
  DisasterCases,
  DisasterCasesOptions,
  DisasterEvent,
  DisasterCategory,
  DisasterRow,
  GuardrailCases,
  GuardrailRow,
  GuardrailRun,
  GuardrailRunResult,
  CrossRepoRow,
  HarmlessEvent,
  HarmlessForm,
  RunGuardrailOptions,
} from "../../guardrail-check.js";
// The cross-repository set's shapes: what `experimental_crossRepo` takes and
// returns, the repository handed to its setup callbacks, and each case's event.
export type {
  CrossRepoCases,
  CrossRepoEvent,
  CrossRepoFixture,
  CrossRepoForm,
  CrossRepoSetup,
  CrossRepoSide,
} from "../../guardrail-target-repo.js";

// The same battery pointed at a DIRECTORY: each hook's event, matcher, command
// and condition are read off its own registration, so the pairing mistake a
// hand-built `runGuardrail` call can make cannot be made.
export { experimental_runPluginGuards } from "../../verify-plugin-guards.js";
export type {
  PluginGuardReport,
  SweptHook,
  SweptHookOutcome,
  // What the sweep found DECLARED but cannot drive — a `prompt`/`http`/
  // `mcp_tool`/`agent` action. Named here so `report.unmeasurable` is foldable.
  NonCommandHookAction,
  RunPluginGuardsOptions,
} from "../../verify-plugin-guards.js";

// Seed + read a compiled hook's NAMED STATE from a test. A throttled guard only
// does anything interesting against an OLD fact, and "old" is not something a
// test can produce by waiting. It is here and not on `vigiles/hook` on purpose:
// `vigiles/hook` is the only import a compiled hook may have, and its guarantee
// is that it hands out no writer. `StateFact` / `Duration` in these signatures
// are `vigiles/hook`'s.
export { experimental_hookState } from "../../hook-state-store.js";
export type {
  HookStateHandle,
  SeedStateOptions,
} from "../../hook-state-store.js";
