/**
 * A real model is spawned only inside a vigiles runner, and never while an eval
 * file is being loaded.
 *
 * ## The failures this removes
 *
 * 1. IMPORT IS EXECUTION. An eval file used to do its work at the top level:
 *
 *      const report = await measureTriggerRate({ … });   // ← module body
 *
 *    so `node -e 'import("./x.eval.mjs")'` — the cheapest way to ask "does this
 *    parse?" — spent real money (measured 2026-08-12, reproduced 2026-08-18).
 *    The shape changed (an eval file DESCRIBES its eval with `defineEval` and a
 *    runner runs it), and the LOAD PHASE below refuses a half-migrated file that
 *    still calls a runner in its module body.
 *
 * 2. TWO WAYS TO RUN, TWO ANSWERS. A script that called `paid_runEval(spec)`
 *    directly got a report back on a broken trial (an instruction file missing
 *    from the model's request) and exited 0; only `vigiles eval` exited 1
 *    (reported in vigiles#416, fixed in vigiles#586). A model is now spawned only
 *    inside a RUNNER — `vigiles eval`, the programmatic door `paid_runEval(definition)`
 *    or the consented half of `vigiles audit` — and the eval runners share one
 *    function, so the two answers cannot differ.
 *
 * ## Why the default is CLOSED
 *
 * Until vigiles#586 it was open ("a guard that fires on correct input is a guard
 * people delete"). The tools closest to this one close it and give the correct
 * case its own door instead: Playwright Test refuses `test()` outside its runner
 * ("Playwright Test did not expect test() to be called here."), Vitest refuses an
 * import outside its run and offers `vitest/node` for programmatic use. The door
 * here is `paid_runEval(definition)`: a correct direct call goes through it.
 *
 * ## How "inside" is known
 *
 * One `AsyncLocalStorage`, kept on a `Symbol.for` global so a second installed
 * copy of vigiles sees the same one. A process-wide boolean was the first design
 * and both reviews refuted it: two concurrent runs (`Promise.all`) share one
 * boolean, so the first to finish closes the door on the second mid-run. A store
 * is scoped to the async call chain that entered it, so concurrent runs and an
 * import inside one never see each other's phase.
 *
 * ⚠️ NOT A SECURITY BOUNDARY. Anyone can enter the store. It stops ACCIDENTS — a
 * direct call that would exit 0, a half-migrated file that bills on import — not
 * a caller who means to spend.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Who entered the runner. Each is a composition point that owns an exit. */
export type RunnerKind = "eval-cli" | "eval-programmatic" | "audit-measure";

/** The phase of the run the current async chain is in. */
interface RunnerState {
  readonly kind: RunnerKind;
  /** True while an eval file is being imported: no model may be spawned. */
  readonly loading: boolean;
}

const KEY = Symbol.for("vigiles.runner");

/**
 * The one store, shared across installed copies of this module. What it holds
 * is PARSED on the way out ({@link current}): another copy, of another version,
 * may have put a differently shaped state in it.
 */
function store(): AsyncLocalStorage<unknown> {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (found instanceof AsyncLocalStorage) return found;
  const fresh = new AsyncLocalStorage<unknown>();
  Reflect.set(globalThis, KEY, fresh);
  return fresh;
}

const KINDS: readonly string[] = [
  "eval-cli",
  "eval-programmatic",
  "audit-measure",
];

function isRunnerState(v: unknown): v is RunnerState {
  return (
    typeof v === "object" &&
    v !== null &&
    "kind" in v &&
    typeof v.kind === "string" &&
    KINDS.includes(v.kind) &&
    "loading" in v &&
    typeof v.loading === "boolean"
  );
}

/** The state of the current async chain, or undefined outside every runner. */
function current(): RunnerState | undefined {
  const s = store().getStore();
  return isRunnerState(s) ? s : undefined;
}

/**
 * Run `fn` inside a vigiles runner: a model may be spawned within it — unless
 * it was entered DURING a load phase. An eval file whose module body calls the
 * programmatic door enters a runner inside the CLI's import, and that nested
 * runner must not reopen spawning there (Codex on #587).
 */
export function withVigilesRunner<T>(kind: RunnerKind, fn: () => T): T {
  const state: RunnerState = { kind, loading: current()?.loading === true };
  return store().run(state, fn);
}

/**
 * Run `fn` — the runner's own `import()` of an eval file — in the load phase:
 * any model spawn inside it refuses. Only inside a runner, because only a
 * runner imports eval files.
 */
export function withEvalLoad<T>(fn: () => T): T {
  const state: RunnerState = {
    kind: current()?.kind ?? "eval-cli",
    loading: true,
  };
  return store().run(state, fn);
}

/** Whether the current async chain is loading an eval file. */
export function inEvalLoad(): boolean {
  return current()?.loading === true;
}

/** Whether the current async chain is inside a vigiles runner. */
export function inVigilesRunner(): boolean {
  return current() !== undefined;
}

/**
 * The load-phase refusal. Separate from the check so a test can assert the
 * WORDS: it fires on a file whose author has not seen the new shape yet, so it
 * has to teach it, not just stop.
 */
export function evalLoadRefusal(what: string): string {
  return (
    `vigiles refused to spawn a model: ${what} while an eval file was being IMPORTED.\n` +
    `  An eval file DESCRIBES its eval; it must not run one at the top level — importing such a\n` +
    `  file spends real money (that is the defect this shape removes).\n` +
    `  Move the runner call into the description, keyed by the runner's own name:\n` +
    `      import { defineEval } from "vigiles";\n` +
    `      export default defineEval({ measureTriggerRate: { …the spec you passed… } });\n` +
    `  and read the report in \`assert(report)\`. See docs/harness-testing.md § Eval files.`
  );
}

/** The refusal for a spawn outside any runner. It names both doors. */
export function outsideRunnerRefusal(what: string): string {
  return (
    `vigiles refused to spawn a model: ${what} outside a vigiles runner.\n` +
    `  Describe the eval in a \`*.eval.mjs\` file and run it with \`npx vigiles eval <file>\`:\n` +
    `      import { defineEval } from "vigiles";\n` +
    `      export default defineEval({ runEval: { …spec… }, assert: (report) => … });\n` +
    `  From a script, pass that description to the programmatic door:\n` +
    `      import { paid_runEval } from "vigiles/eval";\n` +
    `      const outcome = await paid_runEval(definition); // sets process.exitCode on a failure\n` +
    `  A grader (\`paid_judge\`, \`paid_judged\`) runs inside an eval's \`measure\` or \`checks\`.\n` +
    `  See docs/harness-testing.md § Eval files.`
  );
}

/**
 * Refuse a model spawn unless a runner is active and no eval file is loading.
 *
 * 🔴 CALL THIS AT EVERY REAL-MODEL SPAWN, right after `refuseUnderForeignRunner`
 * (whose message is the right one under vitest or jest), and OUTSIDE any `try`
 * that swallows — `judge` and `deriveAttackReal` both wrap their spawn in
 * `try { … } catch { return fallback }`, so a refusal thrown inside would be
 * downgraded to a score of 0 instead of stopping the run.
 */
export function refuseOutsideRunner(what: string): void {
  const state = current();
  if (state === undefined) throw new Error(outsideRunnerRefusal(what));
  if (state.loading) throw new Error(evalLoadRefusal(what));
}
