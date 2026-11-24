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
 *   import { experimental_loadHook, experimental_assertHookDenies, assertGuardrail }
 *     from "vigiles/hook/testing";                                // in its test
 */

// --- in-process: load a compiled hook, run it, assert the decision ---
// Load a hook the way the runtime does (the runtime calls the same loader).
export { experimental_loadHook } from "../../load-hook.js";

// The pure evaluator: one raw event in, the hook's outcome out, dispatched by role.
export { runHookProgram } from "../../core/hook-program.js";
export type {
  RawHookEvent,
  HookProgramOutcome,
} from "../../core/hook-program.js";

// The assertions over one decision, counted and attributed like every check.
export {
  experimental_assertHookDenies,
  experimental_assertHookAllows,
  experimental_assertHookNotices,
  experimental_assertHookSilent,
} from "../../hook-assertions.js";

// --- the guard battery: every disaster blocked, every harmless twin allowed ---
// The catalog, the verifier and the assertion over one guard (a compiled hook
// in-process, a command string over runHook).
export {
  DISASTER_CATALOG,
  verifyGuardrail,
  assertGuardrail,
  experimental_alternateSpellings,
  experimental_harmlessTwins,
} from "../../guardrail-check.js";
export type {
  DisasterEvent,
  DisasterCategory,
  GuardrailResult,
  GuardrailRow,
  GuardrailRun,
  HarmlessEvent,
  HarmlessForm,
  VerifyGuardrailOptions,
} from "../../guardrail-check.js";

// The same battery pointed at a DIRECTORY: each hook's event, matcher, command
// and condition are read off its own registration, so the pairing mistake a
// hand-built `verifyGuardrail` call can make cannot be made.
export { experimental_verifyPluginGuards } from "../../verify-plugin-guards.js";
export type {
  PluginGuardReport,
  SweptHook,
  SweptHookOutcome,
  // What the sweep found DECLARED but cannot drive — a `prompt`/`http`/
  // `mcp_tool`/`agent` action. Named here so `report.unmeasurable` is foldable.
  NonCommandHookAction,
  VerifyPluginGuardsOptions,
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
