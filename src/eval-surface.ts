// 🔴 PUBLIC ENTRY POINT `vigiles/eval` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-eval.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/eval` — the **paid** surface: every runtime export here can call a
 * model, and therefore can spend money.
 *
 * That single property is the whole reason this subpath exists. The package used
 * to split its testing API by TEST TIER (`vigiles/unit`, `vigiles/integration`,
 * `vigiles/e2e`, `vigiles/testing`); it now splits on COST. Everything free is on
 * the package root, [`vigiles`](./test.ts). Everything that bills is here. The
 * name rhymes with the `vigiles eval` CLI verb.
 *
 * ## Why every runtime export is also named `paid_`
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
 * unrepresentable rather than apologised for: on this path, billing is the
 * advertised property, in the subpath and in every name.
 *
 * ## What is NOT here, and why
 *
 * The ~two dozen helpers that read an eval RESULT — `assertImproves`,
 * `assertNoRegression`, `assertReliable`, `assertSignificant`, `assertTriggerRate`,
 * `reliable`, `improvement`, `significantlyBeats`, `compareArms`, `diffReports`,
 * `diffToJUnit`, `formatBaselineDiff`, `parseBaselineFile`, `readBaseline`,
 * `toBaselineFile`, `writeBaseline`, `cost`, `latency`, `tokens`, `inputTokens`,
 * `outputTokens`, `cacheTokens`, `formatEvalReport`, `formatCheckReport`,
 * `formatTriggerRateReport`, `checkReportToJUnit`, `assertRates` — spend nothing,
 * so they live on the free root barrel, unprefixed, even though their subject
 * matter is evals.
 *
 * That is the one seam the split cannot make clean: the free helpers are typed
 * over report shapes DEFINED here. The coupling is real and irreducible, so both
 * barrels re-export the same report types. **The types are NOT prefixed** — the
 * prefix is a warning about calling something, and a type is never called;
 * `paid_EvalReport` would be noise on a symbol that cannot bill. Importing
 * `vigiles/eval` for a type alone should never be necessary; importing it for a
 * FUNCTION means you accepted a bill.
 *
 * Harness-specific eval drivers are not here either — `codexEvalDriver` /
 * `codexEvalRunner` / `codexEvalAgentRunner` live on `vigiles/codex`, and
 * `measureSelectionMatrix` / `assertNoCollision` on `vigiles/claude-code`, because
 * those surfaces are chosen by harness, not by cost.
 */

// --- the runners: each one drives a real model ---

/**
 * Run an A/B eval across arms with a real model. Spends money.
 *
 * ⚠️ The `paid_` prefix overstates slightly: pass your own `evalDriver` and no
 * model of ours is called. The DEFAULT path bills.
 */
export { runEval as paid_runEval } from "./eval.js";

/**
 * Score checks over N trials of one task with a real model. Spends money.
 *
 * ⚠️ `paid_` overstates slightly: with an injected `evalDriver` this drives
 * whatever you supply. The DEFAULT path bills.
 */
export { measure as paid_measure } from "./eval.js";

/**
 * Score the same checks per arm (a hook/skill/rule on vs off) with a real model.
 * Spends money.
 *
 * ⚠️ `paid_` overstates slightly: an injected `evalDriver` replaces the billed
 * path. The DEFAULT path bills.
 */
export { measureArms as paid_measureArms } from "./eval.js";

/**
 * Measure whether a skill's description actually FIRES (recall + precision) by
 * running real prompts against a real model. Spends money.
 *
 * ⚠️ `paid_` overstates slightly: an injected `evalDriver` replaces the billed
 * path, and `stubSkillBodies` makes the default path much cheaper without making
 * it free. The DEFAULT path bills.
 */
export { measureTriggerRate as paid_measureTriggerRate } from "./eval.js";

/**
 * The model-graded judge (harness-agnostic — grades text against a rubric).
 * Shells out to the `claude` CLI synchronously; needs model auth. Spends money.
 *
 * ⚠️ Unlike the others this one has no injection seam — it always calls a model,
 * so here `paid_` is exact.
 */
export { judge as paid_judge } from "./judge.js";

/**
 * The one member of the declarative check vocabulary that bills: its default
 * judge is a real model call. Every other `Check` is deterministic and lives
 * unprefixed on the free root barrel.
 *
 * ⚠️ The `paid_` prefix overstates slightly, and this is the symbol it overstates
 * most: `paid_judged(rubric, { judge: myFn })` calls YOUR function and spends
 * nothing. Only `paid_judged(rubric)` — the default — bills.
 */
export { judged as paid_judged } from "./check.js";

/**
 * The Claude-Code eval driver: the transport `paid_runEval` and friends use by
 * default. Naming it here is how you pass it explicitly; using it spends money.
 */
export { claudeEvalDriver as paid_claudeEvalDriver } from "./eval.js";

// --- types: deliberately NOT prefixed (a type cannot be called, so it cannot bill) ---
export type { Check, CheckResult, JudgeFn } from "./check.js";
export type { Trace } from "./harness-test.js";

// Report shapes, deliberately re-exported from BOTH barrels (see the module doc):
// the free analysis helpers on `vigiles` are typed over these, and a caller of
// those helpers must not be forced onto the paid import path for a type alone.
export type {
  EvalArm,
  EvalDriver,
  EvalSpec,
  EvalReport,
  EvalUsage,
  MeasureSpec,
  ArmsMeasureSpec,
  ArmReport,
  ArmUsage,
  ArmsCheckReport,
  CheckRate,
  CheckReport,
  MetricStat,
  Metrics,
  ModelOutputParser,
  ParsedModelRun,
  PromptDiversityIssue,
  PromptTriggerStat,
  RunContext,
  RunOut,
  SelectionTrialResult,
  TriggerRateReport,
  TriggerRateSpec,
  AgentRunArgs,
  AgentRunner,
} from "./eval.js";
