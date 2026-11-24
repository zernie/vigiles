// 🔴 PUBLIC ENTRY POINT `vigiles/hook-test` — every export here is a promise to users. The default
// for a symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b)
// it is a deliberate extension point listed in STABILITY.md. Review point: the diff of
// `api-surface/vigiles-hook-test.api.md`, which `npm run api:check` fails on.
/**
 * `vigiles/hook-test` — test a compiled hook in-process: load it from its file,
 * run it on a raw event, assert what it decided. No subprocess, no model.
 *
 * Its reader is someone TESTING a compiled hook, never the hook itself. It is a
 * separate door from `vigiles/hook` for a security reason, not a tidiness one:
 * `vigiles/hook` is the only import a compiled hook may have, so anything on it
 * is reachable from inside every hook. `experimental_loadHook` imports a module
 * by path; on `vigiles/hook` it let a hook load code that no capability check
 * reads and no stamp covers. A compiled hook that imports this entry does not
 * compile (`checkHookImports`).
 *
 *   import { experimental_defineHook } from "vigiles/hook";      // in the hook
 *   import { experimental_loadHook, experimental_assertHookDenies } from "vigiles/hook-test"; // in its test
 */

// Load a hook the way the runtime does (the runtime calls the same loader).
export { experimental_loadHook } from "./load-hook.js";

// The pure evaluator: one raw event in, the hook's outcome out, dispatched by role.
export { runHookProgram } from "./core/hook-program.js";
export type { RawHookEvent, HookProgramOutcome } from "./core/hook-program.js";

// The assertions over one decision, counted and attributed like every check.
export {
  experimental_assertHookDenies,
  experimental_assertHookAllows,
  experimental_assertHookNotices,
  experimental_assertHookSilent,
} from "./hook-assertions.js";
