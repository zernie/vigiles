/**
 * The eval REPORT shapes — what the eval runners produce (an eval file's
 * `assert` receives one) and what the readers take (`compare`, `assertRates`,
 * `assertRates`, a baseline).
 *
 * They live in core, not beside the runners in `src/eval.ts`, because more than
 * one package entry speaks them: the root (`defineEval`, `vigilesMatchers`) and
 * `vigiles/eval` (the paid runners and the readers). Each entry imports them
 * from here, and none imports another entry's barrel. Pure data, no behaviour.
 *
 * A run scored with `checks` returns the same `EvalReport` as one scored with
 * `measure(ctx)`: each check is one 0/1 metric, and `EvalReport.checks` names
 * the check behind each such metric. So the serialized check shape (`CheckJSON`)
 * is declared here too, and `src/check.ts` re-exports it.
 */
import type { StubCall } from "./stub-rules.js";
import type { ContextEvidence } from "./context-evidence.js";

/**
 * A check serialized to plain data — what `Check.toJSON()` returns and what a
 * report records about the check behind a metric.
 *
 * @public
 */
export interface CheckJSON {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/**
 * Per-metric summary statistics across an arm's runs.
 *
 * @public
 */
export interface MetricStat {
  /** Mean (numbers) / fraction-true (booleans). */
  readonly mean: number;
  /** Sample standard deviation (0 when n < 2). */
  readonly std: number;
  /** Standard error of the mean (std / √n). */
  readonly se: number;
  /** Number of runs the metric was observed in. */
  readonly n: number;
  /**
   * How many trials scored 1 — set only when EVERY observed value was 0 or 1
   * (a boolean counts as 0/1). Its presence is what makes the metric a pass/fail
   * tally, judged by Wilson intervals (`experimental_verdict`). Absent for any
   * other metric, and in reports written before this field existed: those are
   * judged by Welch's test.
   */
  readonly successes?: number;
  /**
   * pass^k (τ-bench): 1 if the metric succeeded on EVERY trial, else 0. The
   * reliability question a non-deterministic harness needs — "worked every time"
   * is not "worked on average". A trial counts as a success when its value is
   * truthy (booleans true, counts > 0), so model your metric as success/fail.
   */
  readonly passK: number;
}

/**
 * Aggregated cost / latency / tokens across an arm's runs.
 *
 * @public
 */
export interface ArmUsage {
  readonly totalCostUsd: number;
  readonly meanCostUsd: number;
  readonly meanDurationMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCacheReadTokens: number;
}

/** @public */
export interface ArmReport {
  readonly runs: number;
  /** Aggregated metrics: mean for numbers, fraction-true (0..1) for booleans. */
  readonly metrics: Record<string, number>;
  /** Per-metric mean / std / se / n, so an A/B gap can be read for significance. */
  readonly stats: Record<string, MetricStat>;
  /** Cost / latency / token totals + means for this arm. */
  readonly usage: ArmUsage;
  /**
   * Stub invocations no rule answered, across this arm's trials. Non-empty means
   * the arm measured at least one answer nobody wrote: `vigiles eval` exits 2 on
   * it and `--update` refuses to record the lock. Empty when the eval has no stubs.
   */
  readonly unansweredStubCalls: readonly StubCall[];
  /**
   * One entry per trial run: did the instruction files reach the model? A
   * `missing` trial is not in `runs`/`metrics`/`stats` (its cost still is in
   * `usage`). Absent on a report recorded before the check existed.
   */
  readonly context?: readonly ContextEvidence[];
  /**
   * The plugin namespace this arm's skills installed under — the `<plugin>`
   * half of the `<plugin>:<skill>` id a `skill()` check matches. Absent when
   * the arm installed nothing (no `pluginDir` / `skillsDir`). Reported because
   * with `skillsDir` the name is chosen by the packager, not the caller, so the
   * most common cause of a 0% `skill()` rate was a value the caller never saw.
   */
  readonly namespace?: string;
}

/** @public */
export interface EvalReport {
  readonly name: string;
  readonly trials: number;
  readonly arms: Record<string, ArmReport>;
  /** Total measured cost across every arm × trial (0 when usage wasn't reported). */
  readonly totalCostUsd: number;
  /**
   * What the run counted against `maxCostUsd`: every reported cost, plus, for a
   * run that reported none (killed by the timeout), the per-run cap it was given
   * — nothing proves it spent less. At least `totalCostUsd`. Absent on a report
   * recorded before this field existed.
   */
  readonly chargedUsd?: number;
  /** Runs that reported no cost, so `totalCostUsd` is a floor. Absent on older reports. */
  readonly unknownCostRuns?: number;
  /** True if a `maxCostUsd` budget cap stopped the run before all trials ran. */
  readonly aborted: boolean;
  /**
   * The run environment the trials used, without seeded file contents — so an
   * `inherit` run's reason travels with the report and is printed with it.
   * Absent on a report built before `env` existed.
   */
  readonly env?:
    | { readonly kind: "ephemeral" }
    | { readonly kind: "inherit"; readonly reason: string };
  /**
   * Present when the run was scored with `checks`: each metric key (the
   * check's label, e.g. `tool(Bash)`, with ` #2` appended to a repeated one)
   * mapped to the check it scores. Every such metric is 0/1. `assertRates`
   * without a `metric` gates exactly these. Absent on a run scored with
   * `measure(ctx)`.
   */
  readonly checks?: Readonly<Record<string, CheckJSON>>;
  /**
   * Present when the run measured `experimental_regressionCases`: one entry per
   * case, in the spec's order — what was measured and how each arm did on it.
   * The arm's pooled `case.*` metrics are in `arms`; this says which case moved.
   *
   * @experimental
   */
  readonly experimental_regressionCases?: readonly CaseResult[];
}

/**
 * One arm on one regression case: its trials that were scored, how many of
 * them solved the case, and the trials left unscored for integrity.
 *
 * @experimental
 * @public
 */
export interface CaseArmResult {
  /** Scored trials whose tree passed the case's tests. */
  readonly solved: number;
  /** Trials scored at all: solved or not. */
  readonly scored: number;
  /** Trials whose tree could not be scored as the agent left it; any one fails the run. */
  readonly unscored: number;
}

/**
 * One regression case of a run, as the report keeps it: the commits, the
 * resolved paths, the controls that qualified it, and each arm's result. A
 * replayed lock prints from it, so it shows what was measured.
 *
 * @experimental
 * @public
 */
export interface CaseResult {
  /** The entry's `id`. */
  readonly id: string;
  /** The fix commit the case measures. */
  readonly commit: string;
  /** The commit the world was built at. */
  readonly head: string;
  /** Where an agent's edit is kept from: the declared globs, or the fix's own top-level paths. */
  readonly source: readonly string[];
  /** The fix's test files, run as the oracle. */
  readonly oracle: readonly string[];
  /** Markdown files of the fix kept as they are at `head`. */
  readonly markdownKeptAtHead: readonly string[];
  /** Solved per control run: the world as is, with the fix, with the fix and a test edit. */
  readonly controls: {
    readonly red: readonly boolean[];
    readonly gold: readonly boolean[];
    readonly goldEdit: readonly boolean[];
  };
  /** Whether the world ran a build; a command's argv is left out of the report. */
  readonly build:
    | { readonly kind: "command" }
    | { readonly kind: "none"; readonly reason: string };
  /** Each arm's result on this case, keyed by arm name. */
  readonly arms: Readonly<Record<string, CaseArmResult>>;
}

/**
 * Per-prompt trigger result: how many of its trials fired.
 *
 * @public
 */
export interface PromptTriggerStat {
  readonly prompt: string;
  readonly fired: number;
  readonly trials: number;
  /** `fired / trials` (0 when no trials). */
  readonly rate: number;
}

/** @public */
export interface TriggerRateReport {
  /** Overall fraction of relevant runs in which the behaviour fired (recall, 0..1). */
  readonly rate: number;
  /** Total relevant runs (prompts × trials). */
  readonly n: number;
  readonly perPrompt: readonly PromptTriggerStat[];
  /**
   * Fraction of *irrelevant* runs that wrongly fired (lower is better). Present
   * only when `TriggerRateSpec.irrelevantPrompts` was given.
   */
  readonly falsePositiveRate?: number;
  /**
   * `relevantFired / (relevantFired + irrelevantFired)` — of all firings, the
   * share on the right prompts. Present only when irrelevant prompts were given
   * AND something fired (undefined when nothing fired at all). Pairs with `rate`
   * (recall) to catch a skill that fires on everything _or_ nothing.
   */
  readonly precision?: number;
  /** Per-prompt stats for the irrelevant set. Present with irrelevant prompts. */
  readonly perIrrelevant?: readonly PromptTriggerStat[];
  /**
   * Competitor skills co-installed via `TriggerRateSpec.installSet`. `0`
   * (the default) means the skill was measured **ISOLATED** — so `rate` is an
   * UPPER bound on real recall and `falsePositiveRate` a LOWER bound, because
   * selection is competitive (a populated harness can evict or out-compete the
   * description). A non-zero count is the whole-harness measurement.
   */
  readonly competitors: number;
  /**
   * The plugin namespace the skills actually installed under — the `<plugin>`
   * half of the `<plugin>:<skill>` id `check.skill` matches.
   *
   * Reported because with `skillsDir` the name is chosen by the packager, not by
   * the caller, so the single most common cause of a 0% run was a value the
   * caller had no way to know. Optional so a report recorded before this field
   * still parses.
   */
  readonly namespace?: string;
  /**
   * Runs EXCLUDED because the turn errored / was rate-limited (detected by the
   * driver's `runError`), present only when > 0. These are NOT counted in `n` or
   * as misses — so `rate` reflects only valid runs. A large `errored` relative to
   * `n` means the measurement is thin (e.g. a Codex usage limit was hit); re-run.
   */
  readonly errored?: number;
  /** Cost / tokens SPENT across all runs (relevant + irrelevant) — feeds the cost summary. */
  readonly usage: ArmUsage;
  /**
   * Present when the driver's harness measures trigger-rate on an EXPERIMENTAL
   * basis (copied from `EvalDriver.experimental`) — the number is not
   * validated and can be wrong. `formatTriggerRateReport` prints it as a loud
   * caveat. Absent = a supported, trustworthy measurement (Claude Code).
   */
  readonly experimental?: string;
}
