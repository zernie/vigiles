// 🔴 PUBLIC ENTRY POINT `vigiles/battery` — every export here is a promise to users. The default
// for a symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b)
// it is a deliberate extension point listed in STABILITY.md. Review point: the diff of
// `api-surface/vigiles-battery.api.md`, which `npm run api:check` fails on.
/**
 * `vigiles/battery` — prove a guard blocks every disaster, and lets the same
 * text through when it is only data.
 *
 * Its reader is someone holding a guard — a compiled hook, a hook command, a
 * plugin's hook directory — and asking "does it actually block?". That is a
 * different person at a different moment from someone writing a harness test,
 * so the battery has its own door (v49) rather than sitting on the root.
 * Nothing here calls a model.
 *
 *   import { assertGuardrail } from "vigiles/battery";
 *   assertGuardrail(myHook); // every disaster blocked, every harmless twin allowed
 */

// The catalog, the verifier and the assertion over one guard (a compiled hook
// in-process, a command string over runHook).
export {
  DISASTER_CATALOG,
  verifyGuardrail,
  assertGuardrail,
  experimental_alternateSpellings,
  experimental_harmlessTwins,
} from "./guardrail-check.js";
export type {
  DisasterEvent,
  DisasterCategory,
  GuardrailResult,
  GuardrailRow,
  GuardrailRun,
  HarmlessEvent,
  HarmlessForm,
  VerifyGuardrailOptions,
} from "./guardrail-check.js";

// The same battery pointed at a DIRECTORY: each hook's event, matcher, command
// and condition are read off its own registration, so the pairing mistake a
// hand-built `verifyGuardrail` call can make cannot be made.
export { experimental_verifyPluginGuards } from "./verify-plugin-guards.js";
export type {
  PluginGuardReport,
  SweptHook,
  SweptHookOutcome,
  // What the sweep found DECLARED but cannot drive — a `prompt`/`http`/
  // `mcp_tool`/`agent` action. Named here so `report.unmeasurable` is foldable.
  NonCommandHookAction,
  VerifyPluginGuardsOptions,
} from "./verify-plugin-guards.js";

// Seed + read a compiled hook's NAMED STATE from a test. A throttled guard only
// does anything interesting against an OLD fact, and "old" is not something a
// test can produce by waiting. It is here and not on `vigiles/hook` on purpose:
// `vigiles/hook` is the only import a compiled hook may have, and its guarantee
// is that it hands out no writer. `StateFact` / `Duration` in these signatures
// are `vigiles/hook`'s.
export { experimental_hookState } from "./hook-state-store.js";
export type { HookStateHandle, SeedStateOptions } from "./hook-state-store.js";
