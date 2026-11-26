// 🔴 PUBLIC ENTRY POINT `vigiles/eval` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-eval.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/eval` — the door of the moment you MEASURE: the runners that drive a
 * real model (every one named `paid_`, because it can spend money) and the
 * readers of the report they produce (which spend nothing).
 *
 * The package root, [`vigiles`](./index.ts), is the free testing surface. A
 * report reader is free too, but its only reader is someone who just ran an
 * eval, so it lives here beside the runner (v50) rather than on the root.
 * "Can this call bill me?" is answered by the NAME — `paid_*` — not by the
 * door: a CI rule that forbids spending matches `paid_*`, not `vigiles/eval`.
 * The name rhymes with the `vigiles eval` CLI verb.
 *
 * ## Why every runner is also named `paid_`
 *
 * The import path warns ONCE, at the top of the file. The name warns EVERY time,
 * at the call site. Reading `await judged(trace, "did it refuse?")` on line 140,
 * the import line is long out of view — `await paid_judged(...)` still says what
 * it costs. This is not a new idiom in this package: the `experimental_` prefix
 * says the same kind of thing on a second axis, at the same place.
 *
 * That comparison used to read "`vigiles/experimental` already pairs a
 * quarantined subpath WITH a name prefix". The subpath was deleted 2026-08-21
 * and the prefix kept, on the argument this paragraph makes: of the two, only
 * the name is present where the reader is. Which is also why THIS surface has
 * no `vigiles/paid` subpath and never needed one.
 *
 * ⚠️ **The prefix slightly OVERSTATES the cost, and that is a deliberate trade
 * rather than an oversight.** `paid_judged` takes an injectable judge:
 * `paid_judged(rubric, { judge: myFn })` calls no model and spends nothing — only
 * the DEFAULT judge bills. a `measureTriggerRate` eval likewise accepts
 * an injected `evalDriver`. The strictly accurate prefix would be `metered_`, but
 * it reads a beat slower, and a warning that is not absorbed at a glance is not a
 * warning. Clarity wins; the imprecision is recorded here and on each symbol
 * rather than left for a reader to discover.
 *
 * ## Why the split had to be cost, not tier
 *
 * The old `vigiles/unit` docstring promised "no `claude`, no model, no
 * bubblewrap, no network" — and re-exported `judged`, whose default judge is a
 * real model call (`check.ts` resolves `opts.judge ?? ((o) => runJudge(o))`). A
 * test importing only from that barrel could still spend money, and the one line
 * a reader would have relied on to know otherwise was the false one. `judged`
 * moved HERE and became `paid_judged`, which makes that class of defect
 * unrepresentable rather than apologised for: billing is advertised in every
 * name that can do it. The readers below share the door and carry no prefix —
 * a closed list in `scripts/check-export-prefixes.mjs`, so a new unprefixed
 * export here still fails until someone decides it is free.
 *
 * ## The readers, and why they are few
 *
 * `compare(report, baseline, arm)` answers "how far apart, and is it beyond the
 * noise" per metric, and `compare(before, after)` on two trigger-rate reports
 * which prompts a change gained and lost; `assertImproves` gates on it (`significant: true` for the
 * computed noise floor, `lowerIsBetter` for a cost or a turn count); `assertRates` gates an
 * arm's checks or one arm × metric on a rate (`min`) or on every trial (`passK: 1`), and a
 * trigger-rate report on a skill's firing; `assertNoRegression(current, { baseline })` gates
 * against a committed baseline file, which `update: true` records. Every one of them takes the
 * report of `paid_runEval` whichever way it was scored. They replaced eleven narrower helpers
 * (v50), and `assertTriggerRate` / `readBaseline` / `writeBaseline` folded into them (v52).
 *
 * The report TYPES are not here: they are declared in core and exported from
 * the root, because `defineEval` and `vigilesMatchers` speak them too, and one
 * name has one door. Import `type { EvalReport } from "vigiles"`.
 *
 * Harness-specific eval drivers are not here either — `paid_codexEvalDriver` lives
 * on `vigiles/harness/codex`, and `measureSelectionMatrix` / `assertNoCollision` on
 * `vigiles/harness/claude-code`, because those surfaces are chosen by harness.
 */
import { withVigilesRunner } from "../core/eval-load-phase.js";
import type { EvalDefinition, EvalKind } from "../eval-define.js";
import { trialsOverride } from "../eval-entry.js";
import {
  publicExitCodeOf,
  runDefinition,
  type EvalOutcome,
} from "../eval-run.js";
import { repoCopyHost } from "../host/workspace-host.io.js";

// --- the runner: the programmatic door to what `vigiles eval` runs ---

/**
 * Run one eval DESCRIPTION — the value `defineEval({ … })` returns, which an
 * eval file default-exports — exactly as `vigiles eval` runs that file: the
 * same report printed, the same failures, the same `assert`. Spends money.
 *
 * It never throws on a failed run. It returns how the run ended, and on a
 * failure or a refusal it also sets `process.exitCode` to the code `vigiles eval`
 * would exit with, so a script that ignores the result still fails (vigiles#416:
 * the old spec-taking call returned a report and exited 0 on a broken trial).
 * A skip sets no exit code; it prints `SKIPPED: <reason>` and returns `skipped`.
 *
 * Since vigiles#586 this is the ONE way to run an eval outside the CLI: a model is
 * spawned only inside a vigiles runner, so the old `paid_runEval(spec)` and
 * `paid_measureTriggerRate(spec)` calls refuse. Wrap the spec instead:
 * `paid_runEval(defineEval({ runEval: spec }))`.
 *
 * @public
 */
export function paid_runEval(
  definition: { [K in EvalKind]: EvalDefinition<K> }[EvalKind],
  options: { readonly trials?: number } = {},
): Promise<EvalOutcome> {
  return withVigilesRunner("eval-programmatic", async () => {
    const outcome = await runDefinition(definition, {
      label: "paid_runEval",
      trials: options.trials ?? trialsOverride(process.env["VIGILES_TRIALS"]),
      // The composition: the host adapter that copies a repo for `experimental_workspace`.
      host: repoCopyHost,
      notADescription: notADescription,
    });
    if (outcome.kind === "failed" || outcome.kind === "refused")
      // The door's contract, at the composition root: the caller's script fails
      // without its process being ended under it, as Vitest's `startVitest` does.
      // eslint-disable-next-line functional/immutable-data
      process.exitCode = publicExitCodeOf(outcome);
    return outcome;
  });
}

/** The refusal for a value that is not a description: the v-next migration. */
function notADescription(why: string): string {
  return (
    `✗ paid_runEval: ${why}\n` +
    `  paid_runEval takes the description an eval file exports, not a spec (vigiles#586):\n` +
    `      import { defineEval } from "vigiles";\n` +
    `      await paid_runEval(defineEval({ runEval: { …the spec you passed… } }));\n` +
    `  See docs/testing-api.md § Migrating to v57.`
  );
}

/**
 * The model-graded judge (harness-agnostic — grades text against a rubric).
 * Shells out to the `claude` CLI synchronously; needs model auth. Spends money.
 *
 * ⚠️ Unlike the others this one has no injection seam — it always calls a model,
 * so here `paid_` is exact.
 */
export { judge as paid_judge } from "../judge.js";

/**
 * The one member of the declarative check vocabulary that bills: its default
 * judge is a real model call. Every other `Check` is deterministic and lives
 * unprefixed on the free root barrel.
 *
 * ⚠️ The `paid_` prefix overstates slightly, and this is the symbol it overstates
 * most: `paid_judged(rubric, { judge: myFn })` calls YOUR function and spends
 * nothing. Only `paid_judged(rubric)` — the default — bills.
 */
export { judged as paid_judged } from "../check.js";

/**
 * The Claude-Code eval driver: the transport `paid_runEval` and friends use by
 * default. Naming it here is how you pass it explicitly; using it spends money.
 */
export { claudeEvalDriver as paid_claudeEvalDriver } from "../eval.js";

/** How a `paid_runEval` run ended: `passed`, `failed`, `skipped` or `refused`. */
export type { EvalOutcome } from "../eval-run.js";

// --- reading the report: free, so unprefixed ---
export { compare, assertNoRegression } from "../eval-readers.js";
export type {
  ArmComparison,
  TriggerDiff,
  RegressionGate,
  TriggerRateGate,
} from "../eval-readers.js";
export { assertImproves } from "../eval-improves.js";
export type { ImprovesGate } from "../eval-improves.js";
export { assertRates } from "../eval-rate-gate.js";
export type { RateGate, ArmRateGate } from "../eval-rate-gate.js";
export type { BaselineFile, DiffOptions } from "../eval-baseline.js";
// `compare`'s verdict and the interval a 0/1 metric is judged by.
export type { Verdict, Interval } from "../core/evidence.js";

// --- building the arms: free, so unprefixed ---
// The with/without arms of an output-style eval, for `paid_runEval`. Free:
// the one run it makes to prove the style reaches the model uses the scripted
// model. Its only reader is someone about to run that eval, so it shares this
// door with the runner it feeds.
export { experimental_outputStyleArms } from "../output-style-arms.js";
export type { OutputStyleArms } from "../output-style-arms.js";
