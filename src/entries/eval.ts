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
 * the DEFAULT judge bills. `paid_measureTriggerRate` and friends likewise accept
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
 * on `vigiles/harness/codex`, and `paid_measureSelectionMatrix` / `assertNoCollision` on
 * `vigiles/harness/claude-code`, because those surfaces are chosen by harness.
 */
import type { Metrics } from "../core/eval-aggregate.js";
import type { EvalReport } from "../core/eval-report.js";
import { runEvalOnHost, type EvalSpec } from "../eval.js";
import { repoCopyHost } from "../host/repo-copy.io.js";

// --- the runners: each one drives a real model ---

/**
 * Run a task N times per configuration with a real model and score each trial —
 * by `checks` (the `check.*` vocabulary, 0/1 each) or by `measure(ctx)` (your
 * own metrics). One configuration (no `arms`, an arm named `"default"`) or
 * several compared as an A/B. Spends money. The one task runner of
 * `vigiles/eval` since v55, when the two checks-scored runners folded into it
 * (docs/testing-api.md, "Migrating to v55").
 *
 * Here the `paid_` prefix is exact: it always drives the real `claude` CLI.
 *
 * @public
 */
export function paid_runEval<M extends Metrics>(
  spec: EvalSpec<M>,
): Promise<EvalReport> {
  // The composition: the real agent runner plus the host adapter that copies
  // a repo for `experimental_workspace`.
  return runEvalOnHost(spec, repoCopyHost);
}

/**
 * Measure whether a skill's description actually FIRES (recall + precision) by
 * running real prompts against a real model. Spends money.
 *
 * ⚠️ `paid_` overstates slightly: an injected `evalDriver` replaces the billed
 * path, and `stubSkillBodies` makes the default path much cheaper without making
 * it free. The DEFAULT path bills.
 */
export { measureTriggerRate as paid_measureTriggerRate } from "../eval.js";

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
