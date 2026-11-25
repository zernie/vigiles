/**
 * vigiles — Claude Code harness *evals*.
 *
 * Measure whether a harness change actually changes agent behaviour. Define a
 * fixture, a set of **arms** (e.g. a hook on vs off, with/without a CLAUDE.md
 * rule), a task prompt, and a **metric**; `runEval` drives the real `claude` CLI
 * N trials per arm and aggregates. This is the generalized form of the
 * benchmark harness under `bench/` — the empirical half of testing your harness.
 *
 *   const report = await runEval({
 *     env: { kind: "ephemeral" },
 *     fixture: { "src/billing.ts": "export function chargeCard(){}" },
 *     arms: {
 *       vanilla: {},
 *       gated:  { settings: { hooks: { PostToolUse: [refsHook] } } },
 *     },
 *     task: "document chargeCard in SKILL.md, referencing it by name",
 *     measure: (ctx) => ({ marked: ctx.sh("grep -c vigiles:symbol SKILL.md") > 0 }),
 *     trials: 6,
 *   });
 *
 * Real model → real cost + statistical, not deterministic. For fast, free,
 * deterministic checks of hook *logic*, see `harness-test.ts`.
 */
import { refuseUnderForeignRunner } from "./core/foreign-runner.js";
import { refuseDuringEvalLoad } from "./core/eval-load-phase.js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  copyFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, delimiter } from "node:path";

import { appendObservation } from "./observe.js";
import { resolveHarness } from "./adapters/claude-code/plugin-loader.js";
import { claudeCodeRuntime } from "./adapters/claude-code/runtime.js";
import type { HarnessRuntime } from "./core/runtime.js";
import {
  scrubbedRunEnv,
  withoutSessionIdentity,
  type HomeFiles,
  type RunEnv,
} from "./core/run-env.js";
import {
  emitCostSummary,
  costFromEvalReport,
  costFromArm,
} from "./eval-cost.js";
import type { HarnessLiveDriver } from "./core/live-driver.js";
import {
  hasModelAccess,
  isMeteredAccess,
  CLAUDE_CODE_ACCESS_FIX,
} from "./adapters/claude-code/model-access.js";
import type {
  AgentRunArgs,
  AgentRunner,
  EvalDriver,
  EvalUsage,
  ModelOutputParser,
  ParsedModelRun,
  RunOut,
} from "./core/eval-driver.js";
// The executing tiers' shared shapes moved to core so a core PORT
// (`HarnessLiveDriver`) can reference them — the core may not import this
// module. Re-exported here unchanged, so `vigiles/eval` and every existing
// `from "./eval.js"` import resolve exactly as before.
export type {
  AgentRunArgs,
  AgentRunner,
  EvalDriver,
  EvalUsage,
  ModelOutputParser,
  ParsedModelRun,
  RunOut,
} from "./core/eval-driver.js";
// The report shapes moved to core so every entry that speaks them imports them
// from one module and none imports another entry's barrel. Re-exported here so
// existing `from "./eval.js"` imports resolve as before.
import type {
  ArmReport,
  EvalReport,
  PromptTriggerStat,
  TriggerRateReport,
} from "./core/eval-report.js";
export type {
  ArmReport,
  ArmUsage,
  EvalReport,
  MetricStat,
  PromptTriggerStat,
  TriggerRateReport,
} from "./core/eval-report.js";
import {
  parseToolCalls,
  parseResultEvent,
  parseHooks,
  parseReplies,
  parseSubagents,
  reachedModel,
  streamSkillFacts,
  type ToolCall,
  type Trace,
} from "./harness-test.js";
import {
  cacheKey,
  readCache,
  writeCache,
  snapshotDir,
  restoreDir,
  hashDir,
  type CacheMode,
} from "./eval-cache.js";
import { EVAL_CACHE_DIR, VIGILES_DIR } from "./local-files.js";
import {
  evalInputsHash,
  buildLock,
  readLock,
  writeLock,
  decideLock,
  diffReportNumbers,
  formatLockUpdate,
  lockModeFromEnv,
  evalApiVersionFromEnv,
  DEFAULT_LOCK_DIR,
  type LockMode,
  type EvalLockOptions,
} from "./eval-lock.js";
import type { Check } from "./check.js";
import { recordCheck } from "./check-count.js";
import { probeTrace } from "./coverage-probe.js";
import {
  type ToolIntercept,
  buildInterceptSettings,
  serializeIntercepts,
  INTERCEPT_TOOLS_ENV,
} from "./tool-intercept.js";
import {
  readStubCalls,
  removeStubDir,
  resetStubCalls,
  writeStubDir,
} from "./tool-stub.js";
import {
  isUnanswered,
  unloggedMisses,
  encodeStub,
  type StubCall,
  type ToolStub,
} from "./core/stub-rules.js";
import { parseRunEnv, parseToolStubs } from "./core/eval-spec-parse.js";
import { makeTmpDir } from "./core/tmp-root.js";
import type { ContextEvidence } from "./core/context-evidence.js";
import { startContextCapture } from "./eval-context.js";
import {
  aggregate,
  aggregateStats,
  aggregateUsage,
  type Metrics,
} from "./core/eval-aggregate.js";
import { assertPromptDiversity } from "./core/prompt-diversity.js";
import {
  contextInReport,
  unansweredInReport,
} from "./core/eval-report-failures.js";
import { assertKnownKeys } from "./core/known-keys.js";
import {
  stubSkillBody,
  unregisteredSkillFiles,
} from "./core/eval-skill-files.js";
import {
  SINGLE_ARM_KEYS,
  shapeEvalSpec,
  type EvalShape,
} from "./eval-spec-shape.js";

/**
 * The harness the eval tier spawns. ONE binding on purpose: the paid tier is
 * still wired to the Claude Code runner rather than chosen through the adapter's
 * eval driver (#325), and every fact this file needs about that harness — its
 * binary, its version key, which env a child may inherit — is read off this
 * runtime's port fields, never spelled here.
 */
const EVAL_RUNTIME: HarnessRuntime = claudeCodeRuntime;

/**
 * One arm of the comparison: fixture overrides + settings (hooks) for this arm.
 *
 * @public
 */
export interface EvalArm {
  /** Files written on top of the base fixture for this arm. */
  readonly files?: Record<string, string>;
  /** `.claude/settings.json` (hooks/permissions) for this arm; omit for none. */
  readonly settings?: unknown;
  /**
   * Path to a real plugin/repo to load for this arm (hooks + CLAUDE.md +
   * skills). Lets an arm be "the whole plugin on" vs "off". See
   * src/plugin-loader.ts.
   */
  readonly plugin?: string;
  /**
   * Path to a plugin dir to install NATIVELY (`claude --plugin-dir`) for this
   * arm, so its skills/commands/agents activate the real way — the real model
   * can trigger a skill by its description (vs. `plugin`, which materializes a
   * file subset that does not register skills). Point at a COMPLETE plugin. Lets
   * an arm be "skill installed" vs "off" to measure real activation. Provide this
   * OR {@link skillsDir}, not both.
   */
  readonly pluginDir?: string;
  /**
   * A directory of LOOSE skills (`<skillsDir>/<name>/SKILL.md`, e.g. a repo's
   * `.claude/skills`) to install for this arm. vigiles packages them into a
   * throwaway `--plugin-dir` (manifest + `skills/<name>/`, each skill dir copied
   * whole) for the run and removes it afterward — the one-liner for repo-local
   * skills that aren't a published plugin. The skills install under the
   * namespace `vigiles-loose-skills`, so a `skill()` check / `check.skill`
   * matches `vigiles-loose-skills:<name>` (the report's `namespace` says so).
   * Provide this OR {@link pluginDir}, not both.
   */
  readonly skillsDir?: string;
  /**
   * Tools to intercept for this arm (the tool-call spy). Each
   * {@link ToolIntercept} is denied its real execution by an auto-wired PreToolUse
   * hook — the model still emits the `tool_use` (so its arguments land in the
   * `Trace` for `check.tool(name, { with })`), but the side effect (a paid API call, a
   * `git push`, a paid subagent) never happens: the call is intercepted
   * (prevented), NOT executed. This makes a real-model eval **side-effect-free and
   * safe** (it does NOT cut the model-call cost); and because CC surfaces the
   * denial as a *blocked* call, it's for asserting the agent's ATTEMPT, not for
   * stubbing a tool to continue a multi-step flow. See `src/tool-intercept.ts`.
   */
  readonly interceptTools?: readonly ToolIntercept[];
  /**
   * Model alias/id for THIS arm, overriding the eval-level `model`. A model
   * comparison IS a harness A/B — `arms: { sonnet: { model: "claude-sonnet-4-6" },
   * opus: { model: "claude-opus-4-8" } }` — so model-as-an-arm answers "does my
   * harness still hold on the cheaper tier / after a model upgrade?" through the
   * same significance machinery, with no separate model-matrix runner. Omit to
   * use the eval-level model. See `research/eval-architecture.md` (model strategy).
   */
  readonly model?: string;
  /**
   * Reasoning budget for the run (`claude --effort`, e.g. `"low"` or an integer).
   * Lives here beside `model` because it is part of the MEASUREMENT — it moves the
   * output distribution, not the sample size — so it is hashed into the lock and
   * the cache, and never read from an env var. Omit for the harness default.
   */
  readonly effort?: string | number;
}

/**
 * Context handed to `measure` after a run, to compute that run's metrics. It is
 * a `Trace` (so every check — `check.tool`, `check.skill`, a custom
 * `check(name, fn)` — evaluates over it, the same as over a
 * `runHarnessTest` result) plus the eval-only `sh` end-state probe and `usage`.
 *
 * @public
 */
export interface RunContext extends Trace {
  readonly cwd: string;
  /** The harness's exit code; -1 when a signal ended it (see {@link timedOut}). */
  readonly exitCode: number;
  /**
   * True when `timeoutMs` ran out and the run was killed. Its metrics are still
   * computed from what the agent did before the kill; its cost was not reported,
   * so `usage` is a floor (see `EvalReport.chargedUsd`).
   */
  readonly timedOut: boolean;
  readonly stdout: string;
  /** `num_turns` reported by claude, or 0. */
  readonly turns: number;
  /** The tools the agent invoked, each paired with its result (parsed from the stream). */
  readonly toolCalls: readonly ToolCall[];
  /** Cost / latency / tokens for this run (use as metrics, e.g. `{ cost: ctx.usage.costUsd }`). */
  readonly usage: EvalUsage;
  /** Run a shell command in the working dir; returns trimmed stdout ("" on error). */
  sh(command: string): string;
}

/**
 * What `paid_runEval` runs: one task, N trials per configuration, each trial
 * scored. Two choices shape it, and each is exactly-one — a type error in
 * TypeScript and a refusal before any trial runs in plain JavaScript:
 *
 * - **Configurations.** `arms` — named configurations compared against each
 *   other (a hook on vs off, two models) — or no `arms`, which is ONE arm named
 *   `"default"`, configured by the top-level `settings` / `plugin` /
 *   `pluginDir` / `skillsDir` / `interceptTools`. Those five fields are refused
 *   beside `arms`: set them on each arm there.
 * - **Scoring.** `checks` — the `check.*` vocabulary, each a 0/1 metric keyed by
 *   its label (`tool(Bash)`), listed in `EvalReport.checks` — or `measure(ctx)`,
 *   your own metrics (numbers or booleans) computed from each run.
 *
 * @public
 */
export type EvalSpec<M extends Metrics = Metrics> = {
  readonly name?: string;
  /** Base fixture files (path → contents), written fresh for every run. */
  readonly fixture?: Record<string, string>;
  /**
   * Stub each arm's skill BODIES (frontmatter kept) before the run — for firing
   * comparisons (does the skill get SELECTED?), where a selected skill should
   * stop at selection instead of running its (often expensive) procedure. Every
   * arm with a `pluginDir` / `skillsDir` is repackaged with bodies stripped; arms
   * without one are untouched, and a spec where no arm has one is refused.
   * Don't combine with quality metrics: the body is gone, so there is nothing to
   * grade — a `judged` check beside it is refused. See {@link stubSkillBody}.
   */
  readonly stubSkillBodies?: boolean;
  /** The task prompt given to the agent. */
  readonly task: string;
  /** Trials per arm. Default 5. */
  readonly trials?: number;
  /** Model alias. Default "haiku". */
  readonly model?: string;
  /**
   * Reasoning budget for the run (`claude --effort`, e.g. `"low"` or an integer).
   * Lives here beside `model` because it is part of the MEASUREMENT — it moves the
   * output distribution, not the sample size — so it is hashed into the lock and
   * the cache, and never read from an env var. Omit for the harness default.
   */
  readonly effort?: string | number;
  /**
   * Tools pre-approved for the run (`--allowedTools`, a permission allowlist);
   * the default tools stay available either way. `[]` approves none.
   * Default: Read Edit Write Bash.
   */
  readonly allowedTools?: readonly string[];
  /** Per-run timeout ms. Default 240000. */
  readonly timeoutMs?: number;
  /** Seconds to wait between runs (avoid rate-limit bursts). Default 4. */
  readonly spacingSec?: number;
  /**
   * Record/replay cache mode. Default `"off"` (always re-sample). `"readwrite"`
   * records each trial (output + post-run files) and replays it on a matching
   * re-run — so editing `measure` re-scores for free; the model is re-called only
   * when a model-affecting input changes. `"read"` replays but never records.
   * The cache key excludes `measure`, so changing your metric still hits.
   */
  readonly cache?: CacheMode;
  /** Where cache records live. Default `.vigiles/eval-cache` under cwd. */
  readonly cacheDir?: string;
  /**
   * How many trials to run at once (across all arms × trials). Default 1 (fully
   * sequential — the safe, no-surprise default). Raise it to cut wall-clock time;
   * rate-limit bursts are absorbed by the retry/backoff below.
   */
  readonly concurrency?: number;
  /**
   * Abort the run once measured cost reaches this many USD. In-flight trials
   * finish; remaining ones are skipped and `report.aborted` is set. Needs the
   * model to report `total_cost_usd` (the eval tier does).
   */
  readonly maxCostUsd?: number;
  /** Retries on a detected rate-limit/overload before giving up. Default 3. */
  readonly rateLimitRetries?: number;
  /** Base backoff ms (doubled each retry). Default 1000. */
  readonly retryBackoffMs?: number;
  /**
   * **Where each trial runs — required, no default.**
   *
   * - `{ kind: "ephemeral" }` — a throwaway HOME (under the trial's temp dir) and
   *   a scrubbed environment: the OS essentials, the harness's own auth
   *   (`runEnv.keep`, plus its auth file copied in), the eval's own `VIGILES_*`
   *   variables, and nothing else. `home: { kind: "files", files }` seeds that
   *   HOME first (HOME-relative paths; the harness's auth file cannot be
   *   overwritten). Running a model-driven skill is itself a side effect, so a
   *   `git push` or a write to `~` lands in a disposable HOME.
   * - `{ kind: "inherit", reason }` — your real HOME and environment, minus the
   *   parent session's identity. `reason` is printed with the report.
   *
   * There is no default because both are wrong silently in one case: inheriting
   * measures the author's machine (their config, their tokens), and an
   * ephemeral run fails if a user's credential is not where the harness says it
   * is — loudly, on trial 1, which is why it is the one to try first. See
   * `docs/safety.md` (what a child run inherits).
   */
  readonly env: RunEnv;
  /**
   * **Tool stubs on PATH (rung R2)** — fake binaries that answer PER INVOCATION.
   * Build each with {@link experimental_stub}: a list of rules over the argv
   * tokens, first match wins. vigiles writes a shim per stub into a temp dir
   * BESIDE the trial's working dir and puts it first on the run's PATH, so a
   * skill/hook/agent — or a script it runs — that calls `gh`/`psql`/`git` gets
   * the recorded answer instead of the real service.
   *
   * An invocation no rule answers is UNANSWERED: the model sees one neutral
   * stderr line and a non-zero exit, no new trials start, the report lists the
   * call (`ArmReport.unansweredStubCalls`), `vigiles eval` exits 2 and
   * `--update` writes no lock. Every call is recorded in `RunContext.stubCalls`,
   * so `experimental_stub.called(...)` can assert one happened.
   *
   * The answers are author/recorded fixtures, **never** model-synthesized — a
   * synthesized tool output looks plausible but diverges from the real tool.
   */
  readonly stubs?: readonly ToolStub[];
  /**
   * **The eval LOCK** — a committed staleness gate for CI (see `src/eval-lock.ts`).
   * With a `name` set, `vigiles eval --update` (local, on your subscription)
   * records the report to `.vigiles/eval-locks/<name>.lock.json`; `--check` (CI)
   * verifies the committed result against the current inputs WITHOUT a model call,
   * failing "stale" when they diverge. Mode normally comes from the CLI; set
   * `lock` to drive it programmatically or point a test at a throwaway dir. The
   * lock engages only when `name` is set (it keys the lock file).
   */
  readonly lock?: EvalLockOptions;
  /**
   * The per-trial context check (vigiles#416), on by default: every trial
   * checks that the instruction files the harness should load from the trial's
   * world (`CLAUDE.md`, `AGENTS.md`, their `@`-imports) reached the model's
   * first request. A trial where one did not is NOT scored and the eval fails.
   * `false` turns the check off; the report then says "not checked".
   *
   * @experimental
   */
  readonly experimental_contextCheck?: false;
} & (
  | {
      /** The configurations to compare, by name. */
      readonly arms: Record<string, EvalArm>;
      readonly settings?: never;
      readonly plugin?: never;
      readonly pluginDir?: never;
      readonly skillsDir?: never;
      readonly interceptTools?: never;
    }
  | {
      /** Omitted: one arm, named `"default"`, set up by the fields below. */
      readonly arms?: never;
      /** The one arm's `.claude/settings.json` — see {@link EvalArm.settings}. */
      readonly settings?: unknown;
      /** A real plugin/repo to load (materialized) — see {@link EvalArm.plugin}. */
      readonly plugin?: string;
      /** A complete plugin to install natively — see {@link EvalArm.pluginDir}. */
      readonly pluginDir?: string;
      /** A loose skills dir to install — see {@link EvalArm.skillsDir}. */
      readonly skillsDir?: string;
      /** Tools to intercept — see {@link EvalArm.interceptTools}. */
      readonly interceptTools?: readonly ToolIntercept[];
    }
) &
  (
    | {
        /**
         * The checks to score each trial with — any check over the run:
         * `Trace` checks (`tool`/`skill`/`output`/`mcp`/`judged`) and resource
         * checks (`cost`/`latency`/`tokens`, which read the eval-only `usage`).
         * Each becomes a 0/1 metric keyed by its label; an empty list is refused.
         */
        readonly checks: readonly Check<RunContext>[];
        readonly measure?: never;
      }
    | {
        /** Compute this run's metrics from its outcome. */
        readonly measure: (ctx: RunContext) => M;
        readonly checks?: never;
      }
  );

function writeFiles(cwd: string, files: Record<string, string>): void {
  for (const [p, content] of Object.entries(files)) {
    const full = resolve(cwd, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Resolve the environment a trial's subprocess actually runs with — the
 * SECURITY-CRITICAL decision behind `env: { kind: "ephemeral" }`. When `replaceEnv` is set, the
 * scrubbed `env` is the COMPLETE environment, so the real `$HOME` and inherited
 * secrets are DROPPED; otherwise `env` is an overlay on `base`. In BOTH, the
 * harness's declared session identity (`runEnv.sessionIdentity`) is removed: a
 * run started from inside a live session must not run as that session, scrubbed
 * or not. Extracted from the `v8 ignore`d `spawnAgent` so the one line that
 * enforces the scrub is both unit- and behaviourally-tested — a regression to an
 * always-merge would otherwise silently defeat ephemerality and leak the host
 * environment into an untrusted, model-driven run.
 */
export function resolveSpawnEnv(
  a: Pick<AgentRunArgs, "env" | "replaceEnv" | "effort">,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = a.replaceEnv ? (a.env ?? {}) : { ...base, ...a.env };
  return pinEffortEnv(
    withoutSessionIdentity(resolved, EVAL_RUNTIME.runEnv),
    a.effort,
  );
}

/**
 * The env var name the harness reads for the reasoning budget. It sits ABOVE the
 * `--effort` flag in the CLI's own precedence chain, so passing the flag alone
 * does NOT pin the level.
 */
export const EFFORT_ENV_VAR = "CLAUDE_CODE_EFFORT_LEVEL";

/**
 * Pin the effort the run actually gets, so the recorded effort is the effort
 * that ran.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL. Effort has THREE inputs — the
 * `--effort` flag, the `effortLevel` settings key, and `CLAUDE_CODE_EFFORT_LEVEL`
 * — and the env var wins over the flag. The default (inherited) spawn env
 * carries the caller's whole environment, so an ambient
 * `CLAUDE_CODE_EFFORT_LEVEL=max` in the author's shell reaches the run unless
 * something removes it. Without this pin,
 * hashing effort into the lock would make the lock CONFIDENTLY WRONG: it would
 * record `low` over a run that executed at `max` — the exact defect the feature
 * exists to prevent, reintroduced by the fix for it.
 *
 * Both directions matter, so both are handled:
 *  - effort DECLARED  → set the var, overriding whatever the shell had.
 *  - effort OMITTED   → DELETE an inherited var, so "omit" means the harness
 *                       default rather than "whatever this machine happened to
 *                       export". An omitted effort must not be a hidden input.
 */
export function pinEffortEnv(
  env: NodeJS.ProcessEnv,
  effort: string | number | undefined,
): NodeJS.ProcessEnv {
  // Rebuilt WITHOUT the key rather than deleting or assigning `undefined`:
  // omission has to be provable here, and whether a spawn drops an
  // `undefined`-valued env entry is a Node-version detail we should not lean on.
  const { [EFFORT_ENV_VAR]: _inherited, ...rest } = env;
  return effort === undefined
    ? rest
    : { ...rest, [EFFORT_ENV_VAR]: String(effort) };
}

/**
 * The harness's own rejection of an `--effort` value, or null. Pure.
 *
 * The CLI does NOT fail on a bad level — it prints this to stderr and silently
 * runs at its default. That silent substitution is precisely the bug class this
 * feature addresses (a number produced by a configuration nobody asked for), so
 * a rejected value must never become a sample. Matched on the binary's own
 * wording, the same shape as {@link isRateLimited}.
 */
export function effortRejection(out: RunOut): string | null {
  const text = `${out.stderr ?? ""}\n${out.stdout}`;
  const m = /Unknown --effort value[^\n]*/.exec(text);
  return m ? m[0].trim() : null;
}

/**
 * Wrap a runner so a run the harness rejected on `--effort` FAILS LOUDLY.
 *
 * Applied ONCE, around the real runner, rather than as a guard repeated at each
 * of the five `runner(...)` call sites — a guard per call site is the shape that
 * left four of five compilers unprotected in #173.
 *
 * It THROWS rather than counting the trial as `runError`. A `runError` trial is
 * dropped from the denominator, which is right for a transient (a rate limit) and
 * wrong here: an unusable effort value is deterministic and repeatable, so every
 * trial fails it and the run would report a rate computed over ZERO samples. A
 * configuration mistake should stop the run and name itself.
 */
export function withEffortGuard(runner: AgentRunner): AgentRunner {
  // 🔴 DELIBERATELY NOT `async`. An `async` wrapper turns the wrapped runner's
  // SYNCHRONOUS throws into rejected promises, and the real runner refuses
  // synchronously on purpose — `refuseDuringEvalLoad` / `refuseUnderForeignRunner`
  // stop a paid eval from billing when a foreign test runner collects it. Making
  // this `async` silently downgraded those refusals from "throws at the call" to
  // "returns a promise that rejects", which `assert.throws` cannot see and an
  // un-awaited caller would not notice. Caught by the full suite, not by the
  // targeted one; pinned below by `withEffortGuard preserves a SYNCHRONOUS throw`.
  return (a) => {
    const pending = runner(a);
    return pending.then((out) => {
      const rejection = effortRejection(out);
      if (rejection !== null) {
        throw new Error(
          `the harness rejected effort ${JSON.stringify(a.effort)}: ${rejection}`,
        );
      }
      return out;
    });
  };
}

/**
 * Build the real runner's argv. Pure and exported so the FLAGS are provable —
 * `spawnAgentRaw` is `v8 ignore`d (it spawns a subprocess), so an argv assembled
 * inline there could not be asserted at all. Mirrors `buildCodexArgs`.
 */
export function buildAgentArgs(a: AgentRunArgs): string[] {
  return [
    "-p",
    a.task,
    // stream-json (+ --verbose, required with -p) so the per-turn tool_use
    // events survive into `ctx.toolCalls` — the unified Trace, same as the
    // harness tier. The terminal `result` event still carries num_turns/output.
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    a.model,
    ...(a.effort !== undefined ? ["--effort", String(a.effort)] : []),
    // The run's own share of `maxCostUsd`: past it the CLI ends the turn and
    // still reports `total_cost_usd`, which a run killed by the timeout cannot.
    ...(a.maxBudgetUsd !== undefined
      ? ["--max-budget-usd", String(a.maxBudgetUsd)]
      : []),
    "--permission-mode",
    "acceptEdits",
    ...(a.pluginDir !== undefined
      ? ["--plugin-dir", resolve(a.pluginDir)]
      : []),
    ...(a.hasSettings ? ["--settings", "settings.json"] : []),
    // A permission allowlist: an empty one approves nothing, so the flag is
    // left out (a bare `--allowedTools` exits before any model turn).
    ...(a.tools.length === 0 ? [] : ["--allowedTools", ...a.tools]),
  ];
}

/**
 * Why a run never reached the model, or null when it did. A run that exited
 * non-zero with no `assistant` event and no `result` event asked the model
 * nothing — a usage error in the command line, a missing binary — and scored as
 * a trial it reads as a miss on every check that needs output and a pass on
 * every bound it cannot break. A run that reached the model and then broke is a
 * scored outcome, not this. Rate-limited runs are left to the retry loop.
 */
export function startFailure(out: Readonly<RunOut>): string | null {
  if (out.code === 0 || parseResultEvent(out.stdout) !== null) return null;
  // The timeout killed it, possibly while its first request was in flight. That
  // is a scored, charged outcome (vigiles#416), not a command that never started.
  if (out.timedOut === true) return null;
  if (reachedModel(out.stdout) || isRateLimited(out)) return null;
  const said = (out.stderr ?? "").trim().split("\n").slice(-5).join("\n");
  return `the harness exited ${String(out.code)} before calling the model: ${said || "(no stderr)"}`;
}

/**
 * Wrap a runner so a run that never reached the model THROWS instead of being
 * scored — the same choice, for the same reason, as {@link withEffortGuard}:
 * the cause is usually deterministic, so every trial would fail it. Not `async`,
 * for the reason that guard gives.
 */
export function withStartGuard(runner: AgentRunner): AgentRunner {
  return (a) =>
    runner(a).then((out) => {
      const failure = startFailure(out);
      if (failure !== null) throw new Error(failure);
      return out;
    });
}

/**
 * The real `claude`-spawning runner (composition root). Exported so other
 * real-model entries (e.g. the `audit` trigger tier) bind the same runner.
 *
 * The effort guard is composed in HERE, at the single definition, rather than at
 * each of the places that bind this runner — so every consumer, including ones
 * not yet written, is covered by construction. Guarding each call site instead is
 * the shape that left four of five compilers unprotected in #173.
 */
export const spawnAgent: AgentRunner = withEffortGuard(
  withStartGuard(spawnAgentRaw),
);

/**
 * Kill `child` when `signal` fires: the eval no longer needs the run, because
 * another trial failed (#527). Returns whether it fired, so a cancelled run is
 * not read as a timeout and charged its whole budget cap (#416).
 */
export function killOnAbort(
  child: Readonly<Pick<ChildProcess, "kill">>,
  signal: Readonly<AbortSignal> | undefined,
): () => boolean {
  if (signal === undefined) return () => false;
  const kill = (): void => {
    child.kill("SIGKILL");
  };
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
  return () => signal.aborted;
}

// Moves with #552: this subprocess group (resolveSpawnEnv … closedRun) spells
// the `claude` CLI and belongs in src/adapters/claude-code/; the pipeline below
// needs only the AgentRunner port. After the move, the timeout kill becomes an
// Effect finalizer (acquireRelease + Effect.timeout), the last item of #527.
/* v8 ignore start -- real claude subprocess; exercised by bench/, not the unit gate */
/** The unguarded spawn itself; wrapped by {@link spawnAgent}, never bound raw. */
function spawnAgentRaw(a: AgentRunArgs): Promise<RunOut> {
  refuseDuringEvalLoad("spawning `claude`");
  refuseUnderForeignRunner("spawning `claude`");
  return new Promise((resolvePromise) => {
    const args = buildAgentArgs(a);
    const child = spawn(EVAL_RUNTIME.agentBinary, args, {
      cwd: a.cwd,
      // The security-critical env resolution (overlay vs. scrubbed replacement)
      // lives in the tested `resolveSpawnEnv` seam above, not inline here.
      env: resolveSpawnEnv(a),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), a.timeoutMs);
    const cancelled = killOnAbort(child, a.signal);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Two kills: the timer's and a cancel's, so a kill is a timeout only
      // when the run was not cancelled.
      const timedOut = child.killed && !cancelled();
      resolvePromise(closedRun({ code, signal, timedOut, stdout, stderr }));
    });
  });
}
/* v8 ignore stop */

/**
 * The {@link RunOut} of a finished child process. A process a signal ended has
 * no exit code: it reads as -1 with the signal named, never as 0 — `code ?? 0`
 * once turned every run the timeout killed into a clean exit (vigiles#416).
 */
export function closedRun(c: {
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}): Readonly<RunOut> {
  return {
    code: c.code ?? -1,
    stdout: c.stdout,
    stderr: c.stderr,
    ...(c.signal === null ? {} : { signal: c.signal }),
    ...(c.timedOut ? { timedOut: true } : {}),
  };
}
/* v8 ignore start -- the rest of the real-model runtime, as above */

/** Warn (loud, non-fatal) for every arm that drops an unregistered skill file. */
function warnUnregisteredSkillArms(arms: Record<string, EvalArm>): void {
  for (const [name, arm] of Object.entries(arms)) {
    for (const path of unregisteredSkillFiles(arm.files)) {
      console.warn(
        `⚠ eval arm "${name}": files["${path}"] is a SKILL.md with skill ` +
          `frontmatter, but a SKILL.md written to the run cwd is NOT registered as a ` +
          `skill by the harness — it never activates, so this arm measures nothing. ` +
          `Install it via \`pluginDir\` (a real --plugin-dir plugin) or \`skillsDir\`, ` +
          `not \`files\`. See docs/harness-testing.md.`,
      );
    }
  }
}

/**
 * Run the eval: every arm × every trial against the real `claude` CLI, each
 * trial scored by `checks` or `measure(ctx)` and aggregated per arm. Requires
 * `claude` on PATH and working model auth. Thin wrapper over `runEvalWith` with
 * the real agent runner.
 *
 * @public
 */
export async function runEval<M extends Metrics>(
  spec: EvalSpec<M>,
): Promise<EvalReport> {
  return runEvalReporting(spec, spawnAgent);
}
/* v8 ignore stop */

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Pull cost / latency / tokens out of a parsed `result` event (0 when absent). */
function usageFrom(result: Record<string, unknown> | null): EvalUsage {
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const usage = (result?.usage ?? {}) as Record<string, unknown>;
  return {
    costUsd: num(result?.total_cost_usd),
    durationMs: num(result?.duration_ms),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

/** Parse per-run cost/latency/tokens from a stream — pure, model-free. */
export function parseUsage(stdout: string): EvalUsage {
  return usageFrom(parseResultEvent(stdout));
}

/** An `assistant` event's message id and usage, or null for any other line. */
function assistantUsage(
  line: string,
): readonly [string, Readonly<Record<string, unknown>>] | null {
  try {
    const evt: unknown = JSON.parse(line);
    if (!isRecord(evt) || evt.type !== "assistant" || !isRecord(evt.message))
      return null;
    const { id, usage } = evt.message;
    return typeof id === "string" && isRecord(usage) ? [id, usage] : null;
  } catch {
    return null;
  }
}

/**
 * What a run with no `result` event had spent, read from its `assistant`
 * events: a FLOOR, not a measurement. Each API response is counted once (the
 * events of one response share its message id). Input and cache tokens are
 * exact; `output_tokens` is the count at `message_start`, a placeholder far
 * below the real one, and no USD is reported at all — Claude Code's cost
 * tracking docs say the same of this recovery path.
 */
function streamUsage(stdout: string): EvalUsage {
  const byId = Object.fromEntries(
    stdout
      .split("\n")
      .map(assistantUsage)
      .filter((e) => e !== null),
  );
  const sum = (key: string): number =>
    Object.values(byId).reduce(
      (acc, u) => acc + (typeof u[key] === "number" ? u[key] : 0),
      0,
    );
  return {
    costUsd: 0,
    durationMs: 0,
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    cacheCreationTokens: sum("cache_creation_input_tokens"),
    cacheReadTokens: sum("cache_read_input_tokens"),
  };
}

/**
 * Parse Claude Code's stream-json stdout into the common trace fields.
 *
 * @public
 */
export function parseClaudeRun(out: RunOut): ParsedModelRun {
  const result = parseResultEvent(out.stdout);
  const costObserved = typeof result?.total_cost_usd === "number";
  const toolCalls = parseToolCalls(out.stdout);
  return {
    turns: typeof result?.num_turns === "number" ? result.num_turns : 0,
    output: typeof result?.result === "string" ? result.result : "",
    toolCalls,
    skills: streamSkillFacts(out.stdout, toolCalls),
    hooks: parseHooks(out.stdout),
    subagents: parseSubagents(out.stdout),
    replies: parseReplies(out.stdout),
    // No `result` (a run killed by the timeout): the stream's floor, not zeros.
    usage: result === null ? streamUsage(out.stdout) : usageFrom(result),
    costObserved,
  };
}

function makeContext(
  cwd: string,
  out: RunOut,
  parse: ModelOutputParser = parseClaudeRun,
): RunContext {
  return makeTrialContext(cwd, out, parse).ctx;
}

/** {@link makeContext}, plus whether the run reported its cost. */
function makeTrialContext(
  cwd: string,
  out: Readonly<RunOut>,
  parse: ModelOutputParser = parseClaudeRun,
): { readonly ctx: RunContext; readonly costObserved: boolean } {
  const p = parse(out);
  // The one place every real-model trial's trace is assembled — `runEval`,
  // `measureTriggerRate` and the selection runs all pass through here — so the
  // attribution is derived once, from what FIRED. A trigger-rate run installs
  // competing skills on purpose (`installSet`); crediting the install set would
  // credit a skill for LOSING selection. See coverage-probe.ts.
  probeTrace({ toolCalls: p.toolCalls, hooks: p.hooks });
  const ctx: RunContext = {
    cwd,
    exitCode: out.code,
    timedOut: out.timedOut === true,
    stdout: out.stdout,
    turns: p.turns,
    toolCalls: p.toolCalls,
    hooks: p.hooks,
    output: p.output,
    subagents: p.subagents,
    ...(p.replies === undefined ? {} : { replies: p.replies }),
    ...(p.skills === undefined ? {} : { skills: p.skills }),
    usage: p.usage,
    // The eval tier drives the real API (no mock between the agent and the model),
    // so the requests can't be captured here — modelRequests is harness-tier only.
    modelRequests: [],
    file: (p) => {
      const f = resolve(cwd, p);
      return existsSync(f) ? readFileSync(f, "utf-8") : null;
    },
    sh: (command) => {
      try {
        return execSync(command, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch (e) {
        // Return captured stdout even on a non-zero exit (e.g. `lint` exits 2
        // but still prints its findings), rather than swallowing it.
        const out = (e as { stdout?: string }).stdout;
        return typeof out === "string" ? out.trim() : "";
      }
    },
  };
  return { ctx, costObserved: p.costObserved !== false };
}

/**
 * The set of skills that RESOLVED (the `Skill` tool fired without error) in a run,
 * by their namespaced id (e.g. `superpowers:test-driven-development`). The
 * multi-skill generalization of {@link check.skill}: where a trigger-rate run
 * asks "did skill X fire?", a SELECTION-collision run asks "which skills fired?" —
 * so a single pass over the plugin's prompts reveals whether one skill's prompt
 * wrongly activates a SIBLING (the behavioral confirmation of the deterministic
 * `description-overlap` proxy). Errored Skill calls are excluded, like
 * `check.skill`.
 */
export function whichSkillsFired(trace: Trace): string[] {
  const ids = new Set<string>();
  for (const c of trace.toolCalls) {
    if (c.name !== "Skill" || c.isError) continue;
    const id = (c.input as { skill?: string } | undefined)?.skill;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}

/** One selection-trial outcome: which skills fired (namespaced ids), or errored. */
export interface SelectionTrialResult {
  readonly fired: readonly string[];
  readonly errored: boolean;
}

/**
 * Run ONE prompt against an installed plugin and report WHICH of its skills fired
 * — the per-run primitive behind the plugin selection-collision matrix
 * (`measurePluginSelection` in `scan-behavioral.ts`). Mirrors the trigger-rate
 * trial (throwaway cwd, fixture seeded, errored turn excluded) but returns the
 * fired-skill SET instead of a single boolean, so the whole N×N collision matrix
 * falls out of one pass over the prompts (N× cheaper than re-running per pair).
 */
export async function runSkillSelectionTrial(args: {
  readonly prompt: string;
  readonly pluginDir: string;
  readonly runner: AgentRunner;
  readonly parse?: ModelOutputParser;
  readonly model: string;
  readonly effort?: string | number;
  readonly tools?: readonly string[];
  readonly timeoutMs?: number;
  readonly fixture?: Record<string, string>;
  readonly runError?: (out: RunOut) => string | null;
}): Promise<SelectionTrialResult> {
  const cwd = makeTmpDir("selection");
  try {
    if (args.fixture) writeFiles(cwd, args.fixture);
    const out = await args.runner({
      task: args.prompt,
      cwd,
      model: args.model,
      effort: args.effort,
      tools: args.tools ?? ["Read", "Edit", "Write", "Bash", "Skill"],
      hasSettings: false,
      pluginDir: args.pluginDir,
      timeoutMs: args.timeoutMs ?? 240000,
    });
    if (args.runError?.(out)) return { fired: [], errored: true };
    const trace = makeContext(cwd, out, args.parse ?? parseClaudeRun);
    return { fired: whichSkillsFired(trace), errored: false };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Resolved per-run settings shared across an eval's trials. */
interface RunConfig {
  readonly model: string;
  readonly effort?: string | number;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
  readonly cache: CacheMode;
  readonly cacheDir: string;
}

/**
 * Run one trial through the cache: on a hit, restore the recorded post-run
 * filesystem into `cwd` and return the recorded output (no model call); on a
 * miss, run the agent and (in `readwrite`) record output + cwd snapshot. The
 * cache key excludes `measure`, so editing the metric still replays.
 */
async function runWithCache(
  runArgs: AgentRunArgs,
  keyParts: {
    files: Record<string, string>;
    settings: unknown;
    trialIndex: number;
    /** The run's env WITHOUT the stub PATH entry (a fresh temp dir per trial). */
    env: Record<string, string> | undefined;
    /** Encoded stubs — a changed answer is a changed input. */
    stubs: readonly string[];
    /** Where the run executes (kind + seed), never the per-trial HOME path. */
    runEnv: unknown;
  },
  runner: AgentRunner,
  cfg: RunConfig,
  collect: () => TrialObservations,
): Promise<TrialObservations & { readonly out: RunOut }> {
  if (cfg.cache === "off") {
    const out = await runner(runArgs);
    return { out, ...collect() };
  }
  const key = cacheKey({
    task: runArgs.task,
    model: runArgs.model,
    effort: runArgs.effort,
    tools: runArgs.tools,
    files: keyParts.files,
    settings: keyParts.settings,
    env: keyParts.env,
    stubs: keyParts.stubs.length > 0 ? keyParts.stubs : undefined,
    runEnv: keyParts.runEnv,
    // A native --plugin-dir install isn't in `files`, so hash its CONTENTS into
    // the key — otherwise editing a skill in it would false-replay.
    pluginDirHash: runArgs.pluginDir ? hashDir(runArgs.pluginDir) : undefined,
    // The harness binary evolves fast; a CLI upgrade must invalidate (stale
    // replay otherwise serves a result from a different system prompt).
    harnessVersion: harnessVersion(),
    trialIndex: keyParts.trialIndex,
    // The per-run budget cap ends a turn early: a trial recorded under one cap
    // is not the trial another cap asks for.
    maxBudgetUsd: runArgs.maxBudgetUsd,
  });
  const hit = readCache(cfg.cacheDir, key);
  // A run that never reached the model is not replayed: the real runner now
  // throws on one, and an entry cached before that guard existed would
  // otherwise be scored as a trial on every later run.
  if (hit && startFailure(hit.out) === null) {
    restoreDir(runArgs.cwd, hit.files);
    // The stub log lives beside the work dir, so the record carries it: a
    // replayed trial reports the same calls, unanswered ones included. The
    // context evidence likewise; a record without it was never checked.
    return {
      out: hit.out,
      stubCalls: hit.stubCalls,
      context: hit.context ?? {
        kind: "unobservable",
        why: "replayed-without-evidence",
        files: [],
      },
    };
  }
  const out = await runner(runArgs);
  refuseCancelled(runArgs.signal);
  const seen = collect();
  if (cfg.cache === "readwrite") {
    writeCache(cfg.cacheDir, key, {
      out,
      files: snapshotDir(runArgs.cwd),
      ...(seen.stubCalls === undefined ? {} : { stubCalls: seen.stubCalls }),
      context: seen.context,
    });
  }
  return { out, ...seen };
}

/**
 * Throw for a run whose signal fired. A cancelled run's output is partial:
 * replayed later it would count as a real trial, so it is neither recorded nor
 * returned to be scored (#527). The retry's interruption already stops most
 * cancelled runs; this covers one that finished as the cancel arrived.
 */
export function refuseCancelled(
  signal: Readonly<AbortSignal> | undefined,
): void {
  if (signal?.aborted === true) throw new Error("trial cancelled");
}

/** What a trial observed besides its output: stub calls and context evidence. */
interface TrialObservations {
  readonly stubCalls: readonly StubCall[] | undefined;
  readonly context: ContextEvidence;
}

/**
 * The `vigiles hook-runtime intercept-tool` command, as an absolute `node <cli> …`
 * invocation — the eval runs in a throwaway cwd where `npx vigiles` wouldn't
 * resolve, so the auto-wired PreToolUse hook must point at this CLI's own `cli.js`
 * (resolved from `__dirname`, the same way `run-hook.ts`/`sandbox.ts` locate their
 * entries).
 */
const INTERCEPT_TOOL_HOOK_CLI =
  [
    join(import.meta.dirname, "cli.js"),
    join(import.meta.dirname, "..", "dist", "cli.js"),
  ].find((p) => existsSync(p)) ?? join(import.meta.dirname, "cli.js");
/** This node binary — what every command the eval writes for a child calls back into. */
const NODE_BIN = process.execPath;
const INTERCEPT_TOOL_HOOK_CMD = `"${NODE_BIN}" "${INTERCEPT_TOOL_HOOK_CLI}" hook-runtime intercept-tool`;
/**
 * How a stub shim reaches the stub runtime: the same node and `cli.js` as the
 * intercept hook, for the same reason (`npx vigiles` does not resolve from a
 * throwaway dir). The shim runs `cli.js hook-runtime stub`.
 */
const STUB_LAUNCHER = { node: NODE_BIN, cli: INTERCEPT_TOOL_HOOK_CLI };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/**
 * A model id is "dated" (honestly pinned) when it ends in an 8-digit date stamp,
 * e.g. `claude-haiku-4-5-20251001`. A floating alias (`haiku`, `sonnet`, or even
 * `claude-sonnet-4-6` with no date) can change underneath you — so a cached or
 * baselined result pinned to it can silently hide model drift. See
 * `research/eval-architecture.md` (honest model pinning).
 */
export function isDatedModel(model: string): boolean {
  return /\d{8}$/.test(model);
}

/**
 * Capability tier of a model by FAMILY: haiku=1 < sonnet=2 < opus=3 (version is
 * ignored, so `claude-sonnet-4-6` and a dated Sonnet rank equal). An unrecognized
 * family returns `null` — unrankable, so the floor never blocks a model we can't
 * judge (fail-open on ranking). Used by the model floor; aliases and full/dated
 * ids both work.
 */
export function modelTier(id: string): number | null {
  const s = id.toLowerCase();
  if (s.includes("haiku")) return 1;
  if (s.includes("sonnet")) return 2;
  if (s.includes("opus")) return 3;
  return null;
}

/**
 * Is `model` a weaker tier than `floor`? Both must be rankable (see
 * {@link modelTier}); an unrankable model/floor is never "below" (fail-open).
 */
export function belowModelFloor(model: string, floor: string): boolean {
  const m = modelTier(model);
  const f = modelTier(floor);
  return m !== null && f !== null && m < f;
}

// Moves with #552: the harness version is a Claude Code fact, like the spawn above.
/* v8 ignore start -- spawns the real harness binary; memoized, cache-path only */
let cachedHarnessVersion: string | undefined;
/**
 * The harness binary version (`claude --version`), reduced to its
 * behaviorally-significant token by the runtime port's
 * {@link HarnessRuntime.versionKey} — so a Claude Code **minor/major** upgrade
 * (new system prompt / tool defs) invalidates a stale replay while patches don't
 * churn it. The reduction is per-harness (CC → `major.minor`, Codex → `""`) and
 * lives on the adapter, not here. Memoized (one spawn per process), resolved only
 * on the cache path, "unknown" if the binary isn't found (then it doesn't
 * partition the key).
 */
function harnessVersion(): string {
  if (cachedHarnessVersion === undefined) {
    try {
      cachedHarnessVersion = EVAL_RUNTIME.versionKey(
        execSync(`${EVAL_RUNTIME.agentBinary} --version`, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      cachedHarnessVersion = "unknown";
    }
  }
  return cachedHarnessVersion;
}
/* v8 ignore stop */

/** Warn (once per run) that replaying/recording a cache on a floating alias hides drift. */
function warnFloatingModel(model: string): void {
  const msg =
    `vigiles: eval cache is on but the model "${model}" is a floating alias — ` +
    `a replay can serve a result computed against a since-changed model, hiding ` +
    `drift. Pin a dated id (e.g. ...-20251001) for honest replay.`;
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`);
  else console.warn(msg);
}

/**
 * Merge the tool-intercept PreToolUse hook into an arm's resolved settings
 * (appending to any existing `PreToolUse` list). Returns the settings unchanged
 * when there are no intercepts. The intercept list itself rides the
 * `VIGILES_INTERCEPT_TOOLS` env, not the settings — see {@link executeTrial}.
 */
function withInterceptToolHook(
  settings: unknown,
  intercepts: readonly ToolIntercept[],
): unknown {
  if (intercepts.length === 0) return settings;
  const intercept = buildInterceptSettings(intercepts, {
    command: INTERCEPT_TOOL_HOOK_CMD,
  });
  const base = isRecord(settings) ? settings : {};
  const baseHooks = isRecord(base.hooks) ? base.hooks : {};
  const basePre: unknown[] = Array.isArray(baseHooks.PreToolUse)
    ? (baseHooks.PreToolUse as unknown[])
    : [];
  return {
    ...base,
    hooks: {
      ...baseHooks,
      PreToolUse: [...basePre, ...intercept.hooks.PreToolUse],
    },
  };
}

/**
 * Build an **ephemeral run environment** for a model-driven run: a NEW env object
 * with a *fresh* `HOME` (and `TMPDIR`) pointed at the throwaway `opts.home`, the
 * OS essentials (`PATH`, `LANG`, `LC_*`, `TERM`), the harness's OWN auth, and
 * nothing else. Pure — no fs, no spawn.
 *
 * The rationale is "fresh HOME + only the harness credential injected, **not** a
 * blanket wipe": running a model-driven skill/agent is itself a side effect (the
 * *model*, not the author, chose the actions), so it should not be able to read
 * the real `~/.gitconfig` / `~/.ssh` / `~/.aws` or write to the real `~`. But the
 * real CLI must still AUTHENTICATE, so the auth names the harness declares
 * (`runtime.runEnv.keep`) are re-injected, and the parent session's identity
 * (`runtime.runEnv.sessionIdentity`) never is. Which names those are is the
 * adapter's fact, not this file's: see `RunEnvPolicy` in `core/runtime.ts`.
 * Because this needs no kernel features, it is the cross-platform
 * STATE-protection floor (lands on macOS immediately), orthogonal to the Linux
 * bubblewrap HOST confinement in `src/sandbox.ts`.
 *
 * Notably it does NOT pass through `GIT_*`, `GH_TOKEN`, `SSH_*`, `AWS_*` access
 * keys, a config-dir override, or any other undeclared variable — those are
 * exactly what an ephemeral run must not see. A too-narrow `keep` breaks auth
 * loudly (the run fails to start); a too-broad one leaks silently, which is why
 * it is an allowlist and not a prefix.
 *
 * @param base  the source environment to filter (usually `process.env`).
 * @param opts.home  the throwaway dir to set as `HOME`/`TMPDIR`.
 * @param opts.allow  extra var NAMES to pass through (e.g. the `VIGILES_*` keys
 *   the eval already injects). Layered ON TOP of the harness's `keep`; a
 *   session-identity name is dropped even when listed here.
 */
export function ephemeralRunEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined>,
  opts: { home: string; allow?: readonly string[] },
): Record<string, string> {
  // A fresh object: the trial layers its overlay and stub PATH onto it.
  return {
    ...scrubbedRunEnv(base, {
      home: opts.home,
      policy: EVAL_RUNTIME.runEnv,
      allow: opts.allow,
    }),
  };
}

/**
 * Seed the throwaway HOME with the harness's own auth FILE(s) — best-effort;
 * covers local file-based OAuth; the env-var/host-brokered path is covered by
 * `ephemeralRunEnv`. The files are the runtime's declared `keepHomeFiles`.
 *
 * COPIES (never symlinks) each path from `realHome` into `throwawayHome`,
 * creating parent dirs as needed; a symlink would let the model-driven run write
 * back to the real credential file, defeating ephemerality. A path that doesn't
 * exist in the real HOME is skipped silently (that user auths via env-var / host
 * broker instead). Pure fs — no env, no spawn.
 */
export function seedEphemeralHome(
  throwawayHome: string,
  realHome: string,
  keep: readonly string[] = EVAL_RUNTIME.runEnv?.keepHomeFiles ?? [],
): void {
  for (const rel of keep) {
    const src = join(realHome, rel);
    if (!existsSync(src)) continue; // env-var / host-brokered auth covers this.
    const dest = join(throwawayHome, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // The DATA, never a link: `cpSync` recreates a symlinked credential
    // (dotfiles, a secret manager) as a link, and the run would write through
    // it into the real file. `copyFileSync` always copies the contents.
    copyFileSync(src, dest);
  }
}

/**
 * The parts of a {@link RunEnv} that move behaviour — the kind and the seed —
 * for the cache key and the lock. Never the per-trial HOME path, and never an
 * `inherit` reason (prose, not an input).
 */
function runEnvKeyView(env: RunEnv): unknown {
  return env.kind === "ephemeral"
    ? { kind: env.kind, home: env.home }
    : { kind: env.kind };
}

/** The run environment as a report carries it: the kind, and an inherit's reason. */
function runEnvReportView(env: RunEnv): EvalReport["env"] {
  return env.kind === "ephemeral"
    ? { kind: "ephemeral" }
    : { kind: "inherit", reason: env.reason };
}

/** Write a seed's files under a throwaway HOME, parents created. Effects only. */
function materializeHome(home: string, files: HomeFiles): void {
  Object.entries(files).forEach(([path, contents]) => {
    const dest = join(home, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  });
}

/** What a trial's subprocess runs with, and the stub-free view of it for the cache key. */
interface TrialEnv {
  readonly env: Record<string, string> | undefined;
  readonly replaceEnv: boolean;
  readonly keyEnv: Record<string, string> | undefined;
}

/**
 * Build a trial's environment from the spec's {@link RunEnv}. `ephemeral`: a
 * throwaway HOME (`home`, a directory BESIDE the trial cwd — never in it, or a
 * cache snapshot of the cwd would carry the credentials and the seed), seeded
 * (the seed first, then the harness's own auth file), and a scrubbed allowlist env — the eval's injected
 * keys (`VIGILES_INTERCEPT_TOOLS`) allowlisted through so interception works.
 * `inherit`: an overlay on the caller's env. Either way the stub bin dir, when
 * there is one, goes first on PATH.
 */
function trialEnv(
  runEnv: RunEnv,
  home: string,
  overlay: Record<string, string> | undefined,
  stubBin: string | undefined,
): TrialEnv {
  const withStubs = (path: string | undefined): string =>
    stubBin === undefined
      ? (path ?? "")
      : path === undefined || path === ""
        ? stubBin
        : `${stubBin}${delimiter}${path}`;
  switch (runEnv.kind) {
    case "ephemeral": {
      // The seed was validated at the spec boundary (`parseRunEnv`): every
      // path HOME-relative, inside HOME, and not the harness's auth file.
      materializeHome(home, runEnv.home?.files ?? {});
      // Carry the harness's own auth FILE (local OAuth) into the fresh HOME —
      // env-var/host-brokered auth is covered by ephemeralRunEnv's allowlist.
      seedEphemeralHome(home, process.env.HOME ?? homedir());
      const base = {
        ...ephemeralRunEnv(process.env, {
          home,
          allow: overlay ? Object.keys(overlay) : [],
        }),
        ...overlay,
      };
      return {
        env:
          stubBin === undefined
            ? base
            : { ...base, PATH: withStubs(base.PATH) },
        replaceEnv: true,
        keyEnv: base,
      };
    }
    case "inherit":
      // `spawnAgent` spreads `{ ...process.env, ...env }`, so a stub PATH is
      // set in the overlay as the stub dir prepended over process.env.PATH.
      return {
        env:
          stubBin === undefined
            ? overlay
            : { ...overlay, PATH: withStubs(process.env.PATH) },
        replaceEnv: false,
        keyEnv: overlay,
      };
  }
}

/** A finished trial: its metric row, usage, and the stub calls nobody answered. */
interface TrialOutcome<M extends Metrics> {
  readonly row: M;
  readonly usage: EvalUsage;
  readonly unanswered: readonly StubCall[];
  /** False when the run reported no cost (see `ParsedModelRun.costObserved`). */
  readonly costObserved: boolean;
  /** Did the instruction files reach the model? `missing` → not scored. */
  readonly context: ContextEvidence;
}

/** Execute one trial in a fresh sandbox; returns its metric row + usage. */
async function executeTrial(
  spec: ParsedEvalSpec,
  arm: EvalArm,
  trial: {
    readonly index: number;
    readonly maxBudgetUsd?: number;
    readonly signal?: AbortSignal;
  },
  retrying: RetryingRunner,
  cfg: RunConfig,
): Promise<TrialOutcome<Metrics>> {
  const { index: trialIndex, maxBudgetUsd, signal } = trial;
  // Resolved before any temp dir exists, so a bad plugin leaves nothing behind.
  const resolved = resolveHarness({
    plugin: arm.plugin,
    settings: arm.settings,
    files: { ...spec.fixture, ...arm.files },
  });
  const { files } = resolved;
  // The trial's world decides what its first request must carry (vigiles#416).
  const observed = startContextCapture({
    runtime: EVAL_RUNTIME,
    world: files,
    enabled: spec.experimental_contextCheck !== false,
  });
  const cwd = makeTmpDir("eval");
  // The ephemeral env's HOME: beside the work dir, so `snapshotDir(cwd)` (the
  // cache record) never sees the credentials file or the seed, and the agent's
  // `ls -a` of its project does not show it. An `inherit` run leaves it empty.
  const home = makeTmpDir("home");
  // Tool stubs (rung R2): a shim per stub in a temp dir BESIDE the work dir —
  // not in it, so the agent does not find vigiles plumbing in its project.
  const stubs = spec.stubs;
  const stubDir =
    stubs.length > 0 ? writeStubDir(stubs, STUB_LAUNCHER) : undefined;
  try {
    const intercepts = arm.interceptTools ?? [];
    const settings = withInterceptToolHook(resolved.settings, intercepts);
    // The eval-injected overlay (VIGILES_INTERCEPT_TOOLS), if any.
    const overlay =
      intercepts.length > 0
        ? { [INTERCEPT_TOOLS_ENV]: serializeIntercepts(intercepts) }
        : undefined;
    const run = trialEnv(spec.env, home, overlay, stubDir?.binDir);
    writeFiles(cwd, files);
    const hasSettings = settings !== undefined;
    if (hasSettings) {
      writeFileSync(
        join(cwd, "settings.json"),
        JSON.stringify(settings, null, 2).replaceAll("{cwd}", cwd),
      );
    }
    const { out, stubCalls, context } = await runWithCache(
      {
        task: spec.task,
        cwd,
        // A model comparison is a harness A/B: an arm may override the model.
        model: arm.model ?? cfg.model,
        effort: arm.effort ?? cfg.effort,
        tools: cfg.tools,
        hasSettings,
        pluginDir: arm.pluginDir,
        timeoutMs: cfg.timeoutMs,
        ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
        ...(signal === undefined ? {} : { signal }),
        // The request-body channel is added here, not in `run`: it is an
        // observation, not an input, so it stays out of the cache key.
        env:
          Object.keys(observed.env).length === 0
            ? run.env
            : { ...run.env, ...observed.env },
        replaceEnv: run.replaceEnv,
      },
      {
        files,
        settings,
        trialIndex,
        env: run.keyEnv,
        stubs: stubs.map(encodeStub),
        runEnv: runEnvKeyView(spec.env),
      },
      // A rate-limited attempt is discarded and retried; its stub calls must
      // go with it, or the retry inherits a used-up `inOrder` answer and the
      // report counts calls from a run nobody scores.
      retrying(() => {
        observed.reset();
        if (stubDir !== undefined) resetStubCalls(stubDir);
      }),
      cfg,
      () => ({
        stubCalls: stubDir === undefined ? undefined : readStubCalls(stubDir),
        context: observed.finish(),
      }),
    );
    const { ctx: base, costObserved } = makeTrialContext(cwd, out);
    const ctx: RunContext =
      stubCalls === undefined ? base : { ...base, stubCalls };
    return {
      row: spec.measure(ctx),
      usage: ctx.usage,
      costObserved,
      unanswered: unansweredCalls(ctx, stubCalls, stubs),
      context,
    };
  } finally {
    observed.dispose();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (stubDir !== undefined) removeStubDir(stubDir);
  }
}

/** The stub calls nobody answered in one trial. */
function unansweredCalls(
  ctx: RunContext,
  stubCalls: readonly StubCall[] | undefined,
  stubs: readonly ToolStub[],
): readonly StubCall[] {
  return [
    ...(stubCalls ?? []),
    // A stub that could not write its log still printed its neutral line
    // into the agent's tool results: count those too, or a confined shell
    // would leave the report clean.
    ...unloggedMisses(
      ctx.toolCalls.map((c) => c.resultText),
      stubCalls ?? [],
      stubs.map((s) => s.name),
    ),
  ].filter((c) => isUnanswered(c.outcome));
}

// A signal in the captured streams that the model call was rate-limited /
// overloaded — worth a backoff + retry rather than counting as a real sample.
//
// 🔴 The separator is `[ -]?`, NOT `.?`, and that is load-bearing. Claude Code's
// stream-json emits an INFORMATIONAL `{"type":"rate_limit_event","rate_limit_info":
// {"status":"allowed",…}}` line on EVERY run (captured verbatim in
// examples/experimental-emit/records/rate-limit-event.json). `rate.?limit` matched
// `rate_limit_event`, because `.` matches `_` — so every trial looked rate-limited,
// every trial was retried `retries + 1` = 4 times, and only the LAST attempt's cost
// reached `maxCostUsd`. Measured 2026-08-13: 2 trials → 8 model runs, a budget cap
// of $0.60 crossed at roughly $3, and the run reported one trial. `[ -]?` cannot
// match `_`, so the telemetry line is no longer a match; a REAL limit still is,
// because the API reports it as `rate_limit_error` / 429 / "overloaded".
//
// Known boundary, stated rather than hidden: a `rate_limit_event` whose `status`
// is a rejection is no longer a match either. It never was one on its merits — the
// old pattern fired on the event's NAME regardless of status, so status-aware
// detection has never existed here.
const RATE_LIMIT_RE =
  /rate[ -]?limit(?:ed)?\b|rate_limit_error|\b429\b|overloaded|too many requests/i;

/** Whether a run's captured output looks like a rate-limit / overload. Pure. */
export function isRateLimited(out: RunOut): boolean {
  return RATE_LIMIT_RE.test(`${out.stderr ?? ""}\n${out.stdout}`);
}

/** A runner that retries rate-limited attempts, running `beforeAttempt` before each one. */
type RetryingRunner = (beforeAttempt?: () => void) => AgentRunner;

/**
 * Call `runner`, retrying with exponential backoff while it looks rate-limited.
 * `beforeAttempt` runs before every attempt, the first included: it resets the
 * state a discarded attempt would otherwise leave to the next. The run's
 * `signal` interrupts the backoff too, so a cancelled trial does not start the
 * agent again once its wait ends (#527).
 */
function runWithRetry(
  runArgs: AgentRunArgs,
  runner: AgentRunner,
  retries: number,
  baseMs: number,
  beforeAttempt?: () => void,
): Promise<RunOut> {
  const attempt = (): Promise<RunOut> => {
    beforeAttempt?.();
    return runner(runArgs);
  };
  return runEffect(
    ({ Effect, Schedule }) =>
      Effect.repeat(
        Effect.tryPromise({ try: attempt, catch: (error) => error }),
        {
          schedule: Schedule.exponential(baseMs),
          times: retries,
          while: isRateLimited,
        },
      ),
    runArgs.signal,
  );
}

/**
 * Map `worker` over `items` with at most `concurrency` in flight, order
 * preserved. When one worker fails, the others are interrupted: the `signal`
 * each received fires, so a run in flight can stop instead of spending until
 * its own timeout (#527). A worker that ignores the signal runs to its end.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, signal: Readonly<AbortSignal>) => Promise<R>,
): Promise<R[]> {
  return runEffect(({ Effect }) =>
    Effect.forEach(
      items,
      // The thunk must NAME its parameter: Effect passes the AbortSignal only
      // to a callback that declares one.
      (item) =>
        Effect.tryPromise({
          try: (signal) => worker(item, signal),
          catch: (error) => error,
        }),
      { concurrency: Math.max(1, concurrency) },
    ),
  );
}

type EffectModule = typeof import("effect");

/**
 * Run the Effect program `build` returns; `signal`, when given, interrupts it.
 * Rejects with the program's own error, not Effect's wrapper: callers match on it.
 *
 * `effect` loads here, by a dynamic import kept on purpose: it is ESM-only, and
 * the CommonJS copy this package ships for Jest is loaded by Jest's own module
 * system, which cannot `require` ESM. Loading it on first use also keeps it out
 * of every import that never runs an eval.
 */
async function runEffect<A>(
  build: (
    fx: Readonly<EffectModule>,
  ) => Readonly<import("effect").Effect.Effect<A, unknown>>,
  signal?: Readonly<AbortSignal>,
): Promise<A> {
  const fx = await import("effect");
  const exit = await fx.Effect.runPromiseExit(
    build(fx),
    signal === undefined ? undefined : { signal },
  );
  if (fx.Exit.isSuccess(exit)) return exit.value;
  throw fx.Cause.squash(exit.cause);
}

/** One unit of work: a single trial of a single arm. */
interface Unit {
  readonly armName: string;
  readonly arm: EvalArm;
  readonly trialIndex: number;
}

/** Flatten arms × trials into a single work list (so concurrency spans both). */
function buildUnits(arms: Record<string, EvalArm>, trials: number): Unit[] {
  const units: Unit[] = [];
  for (const [armName, arm] of Object.entries(arms)) {
    for (let t = 0; t < trials; t++)
      units.push({ armName, arm, trialIndex: t });
  }
  return units;
}

type DoneResult<M extends Metrics> = {
  readonly armName: string;
  readonly skipped: false;
  readonly row: M;
  readonly usage: EvalUsage;
  readonly unanswered: readonly StubCall[];
  /** False when the run reported no cost; absent on results built elsewhere. */
  readonly costObserved?: boolean;
  /** The trial's context evidence; absent on results built elsewhere. */
  readonly context?: ContextEvidence;
};
type UnitResult<M extends Metrics> =
  | DoneResult<M>
  | { readonly armName: string; readonly skipped: true };

/** Group completed (non-skipped) unit results by arm and aggregate each. */
function aggregateArms<M extends Metrics>(
  armNames: readonly string[],
  results: readonly UnitResult<M>[],
): { arms: Record<string, ArmReport>; totalCostUsd: number } {
  const arms: Record<string, ArmReport> = {};
  let totalCostUsd = 0;
  for (const armName of armNames) {
    const done = results.filter(
      (r): r is DoneResult<M> => !r.skipped && r.armName === armName,
    );
    // A trial whose instruction files never reached the model is not a sample
    // of this arm: it ran and it cost, but it is not scored (vigiles#416).
    const rows = done
      .filter((d) => d.context?.kind !== "missing")
      .map((d) => d.row);
    const context = done.flatMap((d) =>
      d.context === undefined ? [] : [d.context],
    );
    const usage = aggregateUsage(done.map((d) => d.usage));
    totalCostUsd += usage.totalCostUsd;
    arms[armName] = {
      runs: rows.length,
      metrics: aggregate(rows),
      stats: aggregateStats(rows),
      usage,
      unansweredStubCalls: done.flatMap((d) => d.unanswered),
      ...(context.length === 0 ? {} : { context }),
    };
  }
  return { arms, totalCostUsd };
}

/**
 * The eval orchestration — every arm × trial via `runner`, run through the cache
 * and a rate-limit retry, with at most `concurrency` in flight and an optional
 * `maxCostUsd` budget cap; metric + usage computed per run and aggregated per
 * arm. Exported with an injectable `runner` so the loop, `measure` context,
 * caching, pooling, and aggregation are unit-testable without spawning a model
 * (pass a fake returning canned stream-json). `runEval` is this with the real
 * agent runner.
 */
// ---------------------------------------------------------------------------
// The eval LOCK seam (see src/eval-lock.ts) — wraps a named eval's run so
// `--check` replays the committed report (no model) and `--update` records it.
// ---------------------------------------------------------------------------

/** Resolved lock settings for a run: mode (CLI/env) + where + the behavior epoch. */
interface ResolvedLock {
  readonly mode: LockMode;
  readonly dir: string;
  readonly evalApiVersion: number;
}

function resolveLock(over?: EvalLockOptions): ResolvedLock {
  return {
    mode: over?.mode ?? lockModeFromEnv(),
    dir: over?.dir ?? resolve(process.cwd(), DEFAULT_LOCK_DIR),
    evalApiVersion: over?.evalApiVersion ?? evalApiVersionFromEnv(),
  };
}

/** Emit a vigiles message (GitHub annotation under Actions, else stderr/stdout). */
function emitLockMessage(msg: string, warn: boolean): void {
  if (process.env.GITHUB_ACTIONS)
    console.log(`::${warn ? "warning" : "notice"}::${msg}`);
  else if (warn) console.warn(msg);
  else console.log(msg);
}

/**
 * Run a named eval through the lock. `off` → just `produce()`. `check` → replay a
 * matching committed lock (NO model call) or throw "stale". `update` → `produce()`,
 * write the lock, print the human-facing delta. The model is driven ONLY on the
 * run path — never on a clean `check`, which is what keeps the CI gate binary-free.
 * A lock-on run with no `name` is a LOUD skip (the lock needs a name to key the file).
 */
async function withEvalLock<R>(
  args: {
    readonly name: string | undefined;
    readonly inputs: unknown;
    readonly model: string;
    readonly effort?: string | number;
    readonly lock: ResolvedLock;
    /**
     * A reason this report must NOT be recorded, or undefined. A lock is a
     * claim that the committed numbers are a measurement; a report built on a
     * stub call nobody scripted is not one, so `--update` writes nothing.
     */
    readonly refuse?: (report: R) => string | undefined;
  },
  produce: () => Promise<R>,
): Promise<R> {
  const { lock } = args;
  if (lock.mode === "off") return produce();
  if (!args.name) {
    // An unnamed eval can't be keyed to a lock. In `check` (the CI gate) running
    // it would call the model — violating the no-model-in-CI contract and failing
    // for missing auth — so FAIL LOUDLY instead of silently hitting the model.
    // `update` (local, model available) keeps producing: the eval just isn't gated.
    if (lock.mode === "check") {
      throw new Error(
        `vigiles eval --check: an unnamed eval cannot run in CI — it has no ` +
          `committed lock to replay, and running it would call the model. Add a ` +
          `\`name\` to the spec to gate it, or exclude it from the --check run.`,
      );
    }
    emitLockMessage(
      `vigiles eval --${lock.mode}: skipped the lock for an unnamed eval — set ` +
        `\`name\` on the spec to enable the staleness gate for it.`,
      true,
    );
    return produce();
  }
  if (!isDatedModel(args.model)) warnFloatingModel(args.model);
  // OVERLAP, DELIBERATE — do not delete this as dead. Effort reaches the hash
  // twice: here (the CHOKEPOINT every seam passes through, so a future seam that
  // forgets to fold effort into its own `inputs` is still covered) and inside
  // each seam's `inputs` (which alone can see a PER-ARM override this line
  // cannot). Measured 2026-09-01: removing either one alone leaves the suite
  // green; removing BOTH fails `changing effort makes a committed lock STALE`.
  // That is two populations covered, not one line duplicated.
  const inputsHash = evalInputsHash({
    model: args.model,
    effort: args.effort,
    evalApiVersion: lock.evalApiVersion,
    inputs: args.inputs,
  });
  const existing = readLock(lock.dir, args.name);
  const decision = decideLock(lock.mode, args.name, inputsHash, existing);
  if (decision.kind === "stale") throw new Error(decision.reason);
  if (decision.kind === "replay") return decision.report as R;
  const report = await produce();
  const refusal = args.refuse?.(report);
  if (refusal !== undefined) {
    emitLockMessage(
      `vigiles eval --${lock.mode}: the lock for "${args.name}" was NOT written — ${refusal}`,
      true,
    );
    return report;
  }
  const builtLock = buildLock({
    name: args.name,
    inputsHash,
    model: args.model,
    effort: args.effort,
    harnessVersionKey: harnessVersion(),
    evalApiVersion: lock.evalApiVersion,
    builtAt: new Date().toISOString(),
    report,
  });
  const deltas = existing ? diffReportNumbers(existing.report, report) : [];
  writeLock(lock.dir, builtLock);
  emitLockMessage(
    formatLockUpdate(args.name, deltas, existing === null),
    false,
  );
  return report;
}

/**
 * Strip the machine-specific plugin-root prefix from a resolved value before it
 * enters the lock hash. `resolveHarness` expands `${PLUGIN_ROOT}` in a plugin's
 * hook commands to the checkout's ABSOLUTE path, so a lock recorded at
 * `/home/dev/...` would be falsely STALE when `--check` recomputes it at
 * `/home/runner/...` in CI (or any other machine). Normalizing the prefix back to
 * a token makes the hash location-independent. No-op when there's no plugin root.
 */
function stripPluginRoot(value: unknown, absRoot: string): unknown {
  if (absRoot === "") return value;
  const json = JSON.stringify(value);
  // A hookless plugin resolves to `settings: undefined`, which `JSON.stringify`
  // returns as `undefined` (not a string) — pass it through rather than `.split`
  // a non-string (which would throw before the eval can run).
  if (json === undefined) return value;
  return JSON.parse(json.split(absRoot).join("${PLUGIN_ROOT}"));
}

/**
 * Resolve each arm's model-affecting inputs into a canonical object for the lock
 * hash — WITHOUT running the model (it reads files + hashes plugin dirs only). The
 * trial count is excluded (a sample-size knob, not a behavior input); `measure` is
 * excluded by design (the script re-asserts against the replayed report);
 * `checks` are folded in (see the comment at the end).
 */
function evalArmsInputs(spec: ParsedEvalSpec, cfg: RunConfig): unknown {
  const arms: Record<string, unknown> = {};
  for (const [name, arm] of Object.entries(spec.arms)) {
    const resolved = resolveHarness({
      plugin: arm.plugin,
      settings: arm.settings,
      files: { ...spec.fixture, ...arm.files },
    });
    // The plugin root `resolveHarness` expanded into the resolved files/settings
    // is this checkout's absolute path — normalize it out so the hash is the same
    // on the dev's machine and in CI (else every plugin-with-root-hooks eval is
    // falsely stale across machines).
    const absRoot = arm.plugin ? resolve(process.cwd(), arm.plugin) : "";
    arms[name] = {
      model: arm.model ?? cfg.model,
      // The per-ARM half of the overlap documented at `inputsHash` — the
      // chokepoint sees only the eval-level effort, so an arm that overrides it
      // would otherwise hash identically to its sibling.
      effort: arm.effort ?? cfg.effort,
      tools: [...cfg.tools].sort(),
      files: stripPluginRoot(resolved.files, absRoot),
      settings: stripPluginRoot(resolved.settings, absRoot),
      pluginDirHash: arm.pluginDir ? hashDir(arm.pluginDir) : undefined,
      interceptTools: arm.interceptTools
        ? serializeIntercepts(arm.interceptTools)
        : undefined,
    };
  }
  // Tool stubs are a model-facing input: a changed answer changes what the agent
  // sees. Folded in ENCODED (`encodeStub`), never as the raw rules —
  // `JSON.stringify(/^repos/)` is `{}`, so two specs differing only in a RegExp
  // token would hash the same and `--check` would pass a stale lock. Sorted by
  // name for a key that ignores declaration order.
  const stubs = [...spec.stubs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(encodeStub);
  // Where the trials run (ephemeral + its seed, or inherit) moves behaviour, so
  // it is an input. The seed's CONTENTS are hashed — the author's input — never
  // the per-trial HOME path, which differs every run.
  return {
    task: spec.task,
    arms,
    stubs,
    env: runEnvKeyView(spec.env),
    // Each run's `--max-budget-usd` is derived from it, and a cap can end a turn
    // early, so a lock recorded under another ceiling measured another setup.
    maxCostUsd: spec.maxCostUsd,
    // A `measure(ctx)` function cannot be hashed, so editing it replays the
    // lock by design. Checks serialize, and the replayed report IS their
    // scores — a changed check must make the lock stale, not replay old ones.
    // Absent for `measure`, so the hash of a `measure` eval is unchanged.
    ...(spec.checks === undefined ? {} : { checks: spec.checks }),
  };
}

// ---------------------------------------------------------------------------
// The spec boundary — refuse a field the spec does not declare.
//
// A spec usually arrives from a plain-JS `*.eval.mjs` file, where nothing
// type-checks the object literal, so a key that is misspelled (`skillDir`) or
// belongs to a sibling runner (`prompts` on measure) used to be dropped without a
// word — and the run then reported a confident number about a setup the author
// never asked for (issue #307). The precedent is `driverMisplaced` in
// eval-entry.ts: a field that would silently do nothing is REFUSED, not ignored.
//
// Each key table is `satisfies Record<keyof Spec, true>`, so the compiler fails
// when a spec gains or loses a field the table does not: the list cannot drift.
// ---------------------------------------------------------------------------

const EVAL_ARM_KEYS = {
  files: true,
  settings: true,
  plugin: true,
  pluginDir: true,
  skillsDir: true,
  interceptTools: true,
  model: true,
  effort: true,
} satisfies Record<keyof EvalArm, true>;

const EVAL_SPEC_KEYS = {
  name: true,
  fixture: true,
  arms: true,
  stubSkillBodies: true,
  task: true,
  measure: true,
  checks: true,
  settings: true,
  plugin: true,
  pluginDir: true,
  skillsDir: true,
  interceptTools: true,
  trials: true,
  model: true,
  effort: true,
  allowedTools: true,
  timeoutMs: true,
  spacingSec: true,
  cache: true,
  cacheDir: true,
  concurrency: true,
  maxCostUsd: true,
  rateLimitRetries: true,
  retryBackoffMs: true,
  env: true,
  stubs: true,
  lock: true,
  experimental_contextCheck: true,
} satisfies Record<keyof EvalSpec, true>;

const TRIGGER_RATE_SPEC_KEYS = {
  name: true,
  lock: true,
  pluginDir: true,
  skillsDir: true,
  prompts: true,
  irrelevantPrompts: true,
  fired: true,
  installSet: true,
  stubSkillBodies: true,
  minPrompts: true,
  minDistance: true,
  trials: true,
  model: true,
  effort: true,
  minModel: true,
  allowedTools: true,
  timeoutMs: true,
  spacingSec: true,
  fixture: true,
  concurrency: true,
} satisfies Record<keyof TriggerRateSpec, true>;

/**
 * An {@link EvalSpec} after the boundary: one shape whatever the caller wrote —
 * the arms concrete (the one {@link DEFAULT_ARM} built when `arms` was omitted),
 * the scoring one `measure` (`checks` turned into one), stubs and env parsed.
 */
type ParsedEvalSpec = Omit<
  EvalSpec,
  | "arms"
  | "checks"
  | "measure"
  | "stubs"
  | "env"
  | (typeof SINGLE_ARM_KEYS)[number]
> &
  EvalShape & {
    /** Each arm's install namespace, read before the install is resolved. */
    readonly namespaces: Readonly<Record<string, string | undefined>>;
    readonly stubs: readonly ToolStub[];
    readonly env: RunEnv;
  };

/**
 * `runEval` with its author-facing output, over any runner — so the real one and
 * a test's fake share one path. Besides the run it prints, to stderr, what the
 * caller must not miss: a skill arm that never activates, a stub call no rule
 * answered (the same text `vigiles eval` fails with — a script that calls
 * `runEval` itself, as the `experimental_startServices` examples do, gets the report back and
 * nothing else, so the library is not silent about it either), and what the
 * run spent.
 */
export async function runEvalReporting<M extends Metrics>(
  spec: EvalSpec<M>,
  runner: AgentRunner,
): Promise<EvalReport> {
  warnUnregisteredSkillArms(spec.arms ?? {});
  const report = await runEvalWith(spec, runner);
  const unanswered = unansweredInReport(
    report,
    parseToolStubs(spec.stubs, "runEval"),
  );
  if (unanswered !== undefined) console.error(`⚠ runEval: ${unanswered}`);
  const context = contextInReport(report);
  if (context !== undefined) console.error(`⚠ runEval: ${context}`);
  // Surface what the run spent — tokens + API-equivalent $, and a LOUD warning if
  // it was billed to a metered API key instead of the subscription. See eval-cost.ts.
  emitCostSummary(costFromEvalReport(report));
  return report;
}

export async function runEvalWith<M extends Metrics>(
  input: EvalSpec<M>,
  runner: AgentRunner,
): Promise<EvalReport> {
  // A REMOVED field gets its rewrite, not "unknown field … did you mean".
  if (Object.hasOwn(input, "ephemeralEnv"))
    throw new Error(
      "runEval: `ephemeralEnv` was replaced by `env`, which is required:\n" +
        '    ephemeralEnv: true            → env: { kind: "ephemeral" }\n' +
        '    ephemeralEnv: false / absent  → env: { kind: "inherit", reason: "…" }  (your real HOME; the reason is printed with the report)',
    );
  // Refuse a stray field BEFORE spending a token: an eval file is plain JS, so a
  // typo'd or misplaced key would otherwise vanish and the run would report a
  // confident number about the wrong setup (issue #307).
  assertKnownKeys(input, EVAL_SPEC_KEYS, {
    caller: "runEval",
    type: "EvalSpec",
  });
  // The two exactly-one choices — `arms` or none, `checks` or `measure` — are
  // read HERE, before a token is spent: the type forbids "both" and "neither",
  // and a plain-JS eval file is refused the same way (eval-spec-shape.ts).
  const shape = shapeEvalSpec(input);
  for (const [name, arm] of Object.entries(shape.arms))
    assertKnownKeys(arm, EVAL_ARM_KEYS, {
      caller: "runEval",
      type: "EvalArm",
      arm: name,
    });
  // Tell the CLI runner this script exercised the harness, so a file that runs
  // NOTHING can be told apart from one that ran and passed. See check-count.ts.
  recordCheck();
  // Every arm's install source (`pluginDir` as-is / stubbed, or a loose
  // `skillsDir` packaged into a throwaway plugin) is resolved HERE, once — the
  // one place that decides what `--plugin-dir` receives. The throwaways are
  // removed afterward.
  // `stubs` and `env` are parsed HERE, once: the old argv-blind stub shape, a
  // stateful RegExp, a missing `env`, a seed path outside HOME — each refused
  // with its rewrite before a token is spent. The runner trusts the result.
  const stubs = parseToolStubs(input.stubs, "runEval");
  const env = parseRunEnv(
    input.env,
    "runEval",
    EVAL_RUNTIME.runEnv?.keepHomeFiles ?? [],
  );
  const { arms: resolvedArms, packaged } = resolveArmInstalls(
    shape.arms,
    input.stubSkillBodies ?? false,
  );
  const spec: ParsedEvalSpec = {
    ...input,
    measure: shape.measure,
    // Set even when absent: the caller's `checks` LIST must not survive the spread.
    checks: shape.checks,
    arms: resolvedArms,
    namespaces: mapValues(shape.arms, installNamespace),
    stubs,
    env,
  };
  try {
    return await runResolvedEval(spec, runner);
  } finally {
    for (const dir of packaged) rmSync(dir, { recursive: true, force: true });
  }
}

/** Each arm's report with the namespace its skills installed under, when any. */
function withNamespaces(
  arms: Readonly<Record<string, ArmReport>>,
  namespaces: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, ArmReport>> {
  return Object.fromEntries(
    Object.entries(arms).map(([name, arm]) => {
      const namespace = namespaces[name];
      return [name, namespace === undefined ? arm : { ...arm, namespace }];
    }),
  );
}

/** `f` over each value of a record, keys kept. */
function mapValues<V, R>(
  rec: Readonly<Record<string, V>>,
  f: (v: V) => R,
): Readonly<Record<string, R>> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, f(v)]));
}

/** {@link runEvalWith} after its arms' install sources are concrete plugin dirs. */
async function runResolvedEval(
  spec: ParsedEvalSpec,
  runner: AgentRunner,
): Promise<EvalReport> {
  const trials = spec.trials ?? 5;
  const spacing = (spec.spacingSec ?? 4) * 1000;
  const concurrency = spec.concurrency ?? 1;
  const retries = spec.rateLimitRetries ?? 3;
  const backoffMs = spec.retryBackoffMs ?? 1000;
  const cfg: RunConfig = {
    model: spec.model ?? "haiku",
    effort: spec.effort,
    tools: spec.allowedTools ?? ["Read", "Edit", "Write", "Bash"],
    timeoutMs: spec.timeoutMs ?? 240000,
    cache: spec.cache ?? "off",
    cacheDir:
      spec.cacheDir ?? resolve(process.cwd(), VIGILES_DIR, EVAL_CACHE_DIR),
  };
  if (cfg.cache !== "off" && !isDatedModel(cfg.model)) {
    warnFloatingModel(cfg.model);
  }
  const retrying: RetryingRunner = (beforeAttempt) => (a) =>
    runWithRetry(a, runner, retries, backoffMs, beforeAttempt);

  const units = buildUnits(spec.arms, trials);
  // What counts against `maxCostUsd`: a reported cost, or — for a run that
  // reported none, killed by the timeout — the cap it was given (vigiles#416).
  let charged = 0;
  // Why no NEW trial starts: the budget cap, or a stub call nobody scripted —
  // the report will be refused, so later trials would only spend. In-flight
  // trials finish either way.
  // TODO(#478): with `concurrency` > 1 every in-flight trial gets the same remaining
  // budget as its cap, so together they can pass the ceiling by up to
  // `concurrency` caps. Reserving each cap at start would hold the line but
  // serialize the pool behind the first trial; needs its own design.
  let stopped: "budget" | "unanswered" | undefined;
  const worker = async (
    unit: Unit,
    signal: Readonly<AbortSignal>,
  ): Promise<UnitResult<Metrics>> => {
    if (stopped !== undefined) return { armName: unit.armName, skipped: true };
    // The run's own cap: the budget not yet charged. Past it the CLI ends the
    // turn and reports its cost; a run killed first is charged the cap.
    const cap =
      spec.maxCostUsd === undefined ? undefined : spec.maxCostUsd - charged;
    const { row, usage, unanswered, costObserved, context } =
      await executeTrial(
        spec,
        unit.arm,
        {
          index: unit.trialIndex,
          signal,
          ...(cap === undefined ? {} : { maxBudgetUsd: cap }),
        },
        retrying,
        cfg,
      );
    charged += costObserved ? usage.costUsd : (cap ?? 0);
    if (spec.maxCostUsd !== undefined && charged >= spec.maxCostUsd)
      stopped = "budget";
    else if (unanswered.length > 0) stopped = stopped ?? "unanswered";
    if (spacing > 0) await sleep(spacing);
    return {
      armName: unit.armName,
      skipped: false,
      row,
      usage,
      unanswered,
      costObserved,
      context,
    };
  };

  const lock = resolveLock(spec.lock);
  // Resolve the lock inputs only when the lock is active (off skips the
  // resolveHarness/hashDir work). `check` replays the committed report below
  // without ever entering the run pool — so no model is driven in CI.
  const inputs = lock.mode === "off" ? undefined : evalArmsInputs(spec, cfg);
  return withEvalLock(
    {
      name: spec.name,
      inputs,
      model: cfg.model,
      effort: cfg.effort,
      lock,
      refuse: (report: EvalReport) =>
        unansweredInReport(report, spec.stubs) ?? contextInReport(report),
    },
    async (): Promise<EvalReport> => {
      const results = await runPool(units, concurrency, worker);
      const { arms, totalCostUsd } = aggregateArms<Metrics>(
        Object.keys(spec.arms),
        results,
      );
      return {
        name: spec.name ?? "eval",
        trials,
        arms: withNamespaces(arms, spec.namespaces),
        totalCostUsd,
        chargedUsd: Math.max(charged, totalCostUsd),
        unknownCostRuns: results.filter(
          (r) => !r.skipped && r.costObserved === false,
        ).length,
        aborted: stopped === "budget",
        env: runEnvReportView(spec.env),
        ...(spec.checks === undefined ? {} : { checks: spec.checks }),
      };
    },
  );
}

// --- trigger-rate: does a skill/behaviour actually FIRE across varied prompts ---

/**
 * Measure how reliably a skill/behaviour *triggers*. A skill's value is its
 * description firing on the right task — the #1 documented skill-authoring pain —
 * and that's a property of the real model, not the wiring (which the
 * deterministic tier already proves). Install the plugin natively (`pluginDir`),
 * give a set of varied `prompts`, and a `fired` predicate over the run's `Trace`
 * (reuse the bare predicates, e.g. `(t) => check.skill(t, "x:y")`).
 *
 * @public
 */
export interface TriggerRateSpec {
  /**
   * A stable name for this trigger eval — required to engage the {@link lock}
   * (it keys the committed `.vigiles/eval-locks/<name>.lock.json`). Two evals over
   * the same skill with different prompts get distinct names. Optional otherwise.
   */
  readonly name?: string;
  /**
   * **The eval LOCK** — the CI staleness gate (see `src/eval-lock.ts`). With
   * `name` set, `vigiles eval --update` records this trigger-rate report locally
   * and `--check` verifies it against the current inputs (skill contents, prompts,
   * model) with NO model call. Mode normally comes from the CLI flags.
   */
  readonly lock?: EvalLockOptions;
  /**
   * Plugin dir installed natively (`--plugin-dir`) so its skills/commands
   * activate. Provide this OR {@link skillsDir}, not both.
   */
  readonly pluginDir?: string;
  /**
   * A directory of LOOSE skills (`<skillsDir>/<name>/SKILL.md`, e.g. a repo's
   * `.claude/skills`) to trigger-test directly. vigiles packages them into a
   * throwaway `--plugin-dir` for you and removes it afterward — the one-liner
   * for repo-local skills that aren't a published plugin. Provide this OR
   * {@link pluginDir}, not both.
   */
  readonly skillsDir?: string;
  /** The varied prompts to test the trigger against. */
  readonly prompts: readonly string[];
  /**
   * Optional *irrelevant* prompts the skill should **not** fire on — the
   * precision side of triggering. Firing on these is a false positive (a skill
   * whose description is too broad and hijacks unrelated work). When given, the
   * report adds {@link TriggerRateReport.falsePositiveRate} and
   * {@link TriggerRateReport.precision}; `prompts` alone measures recall only.
   */
  readonly irrelevantPrompts?: readonly string[];
  /**
   * Did the behaviour fire on this run? A check — `fired: skill("x:y")`, which
   * asks the harness's adapter and so works on every harness — or a predicate
   * over the trace, `(t) => check.skill(t, "x:y")`. Either form scores a trial
   * the same way, and neither is part of the eval lock's hash: the lock pins
   * what the MODEL sees, not how the script reads the run.
   */
  readonly fired: Check<Trace> | ((trace: Trace) => boolean);
  /**
   * Co-install these skill sources ALONGSIDE the skill-under-test so it competes
   * for selection as it does in the real harness — the **whole-harness** tier.
   * Each entry is a plugin dir (`skills/` or `.claude/skills/`) or a loose skills
   * dir (`<name>/SKILL.md`); their skills are merged into one install under the
   * under-test plugin's name (the under-test skill wins a name collision, so its
   * `<name>:<skill>` id still matches `fired`).
   *
   * WHY: skill selection is competitive and Claude Code evicts the least-used
   * skill descriptions under a context budget, so an ISOLATED trigger-rate (the
   * default, `installSet` absent/empty) **overstates recall and understates
   * false-positives**. Isolated is the cheap authoring loop; populate the set for
   * a release gate. See `research/isolated-vs-whole-harness-eval.md`.
   */
  readonly installSet?: readonly string[];
  /**
   * Replace each skill's BODY with a no-op stub (keeping its frontmatter — name +
   * description). Trigger-rate is decided by the frontmatter ALONE (the model
   * selects a skill before its body loads), so stubbing can't change what's
   * measured — it just stops the run executing an expensive procedure once the
   * skill fires. All descriptions stay present, so selection competition is
   * faithful. **Defaults to `true`** here: testing a description never needs the
   * body, so it's automated, not a knob you must remember. Set `false` only in the
   * rare case you want the real body to run. See {@link stubSkillBody}.
   */
  readonly stubSkillBodies?: boolean;
  /**
   * Minimum number of prompts each set (relevant + irrelevant) must have. A
   * handful of prompts can't tell a real recall/precision rate from noise, so
   * the run is rejected before it spends a token. Default 10; lower it
   * deliberately for a genuinely narrow skill.
   */
  readonly minPrompts?: number;
  /**
   * Reject the run when two prompts in a set are closer than this in NCD
   * (gzip-based distance, 0..1; 0 = identical) — near-duplicate prompts inflate
   * a rate without testing varied phrasings. Default 0.3 (the rule-dup threshold).
   */
  readonly minDistance?: number;
  /** Trials per prompt. Default 1. */
  readonly trials?: number;
  /**
   * Model alias/id. Default `"sonnet"` — the realistic selector most Claude Code
   * users run. NOT haiku: trigger-rate is a *selection* measurement and haiku is a
   * much weaker selector, so it under-reports recall (dogfooded: a skill scored
   * 0.50 on haiku vs 0.90 on Sonnet). Override for a cheaper-but-pessimistic run.
   */
  readonly model?: string;
  /**
   * Reasoning budget for the run (`claude --effort`, e.g. `"low"` or an integer).
   * Lives here beside `model` because it is part of the MEASUREMENT — it moves the
   * output distribution, not the sample size — so it is hashed into the lock and
   * the cache, and never read from an env var. Omit for the harness default.
   */
  readonly effort?: string | number;
  /**
   * Minimum model tier this eval may run on (haiku<sonnet<opus by family). The
   * run **fails** if the resolved `model` is weaker — trigger-rate under-measures
   * selection on a too-weak model, so this stops a cheap model from producing
   * false-negative recall. Default `"sonnet"`. Lower it deliberately for a cheap run.
   */
  readonly minModel?: string;
  /**
   * Tools pre-approved for the run (`--allowedTools`); `[]` approves none.
   * Default: Read Edit Write Bash Skill.
   */
  readonly allowedTools?: readonly string[];
  /** Per-run timeout ms. Default 240000. */
  readonly timeoutMs?: number;
  /** Seconds to wait between runs (avoid rate-limit bursts). Default 4. */
  readonly spacingSec?: number;
  /**
   * Files (path → contents) seeded into every run's cwd before the prompt — the
   * filesystem CONTEXT the skill is measured in. The default empty cwd is faithful
   * for opening-move skills ("describe a feature", "debug this") but biased-low for
   * skills whose trigger is a repo STATE ("in a git repo", "dirty tree"); seed that
   * state here so recall is honest instead of an artifact of the cold start. Mirrors
   * `EvalSpec.fixture`. See `research/plugin-behavioral-findings.md`.
   */
  readonly fixture?: Record<string, string>;
  /**
   * How many runs to execute in parallel across the whole prompts × trials grid.
   * Default 1 (serial, the politest to rate limits). Raise it to cut wall-clock on
   * a large prompt set or roster sweep — the `spacingSec` pause still applies per
   * run, so it stays best-effort polite. Mirrors `EvalSpec.concurrency`.
   */
  readonly concurrency?: number;
}

/**
 * The default (Claude Code) eval driver: real `claude` + stream-json parsing.
 *
 * This lives at the COMPOSITION ROOT (`src/eval.ts`) on purpose, not in
 * `src/adapters/claude-code/` — it is NOT a boundary leak. Claude Code is the
 * wired DEFAULT (`measureTriggerRate`/`runEval` fall back to it), so `eval.ts`
 * must reference it directly; wiring the default is precisely a composition
 * root's job. `paid_codexEvalDriver` lives in its adapter dir instead because Codex
 * is caller-INJECTED (never a default), so `eval.ts` never imports it. Relocating
 * this into the adapter would make `eval.ts → adapters/claude-code → eval.ts` a
 * circular import (the shared `EvalDriver`/`ModelOutputParser` types live here).
 * The asymmetry reflects default-vs-injected, not a hexagonal violation.
 *
 * @public
 */
export const claudeEvalDriver: EvalDriver = {
  runner: spawnAgent,
  parse: parseClaudeRun,
  harness: "claude-code",
};

/**
 * The Claude Code {@link HarnessLiveDriver} — the EXECUTING tiers' side of the
 * adapter, reached through `claudeCodeAdapter.liveDriver()`.
 *
 * It lives HERE, at the composition root, for exactly the reason
 * `claudeEvalDriver` above does: it is assembled from the wired default runner
 * and `whichSkillsFired`, and moving it into `src/adapters/claude-code/` would
 * make `eval.ts → adapters/claude-code → eval.ts` a cycle. The adapter reaches
 * it through a dynamic `import()`, so nothing pays for this graph until an
 * executing tier actually runs.
 */
export const claudeCodeLiveDriver: HarnessLiveDriver = {
  evalDriver: claudeEvalDriver,
  // Env-only, and never a spent token: deciding whether to OFFER a measurement
  // must not cost one. The three arms are what the consent prompt words
  // differently — a key bills per token, a session is $0 metered, and neither
  // present means the tier is skipped with `fix` printed.
  access: (env) =>
    isMeteredAccess(env)
      ? { kind: "metered" }
      : hasModelAccess(env)
        ? { kind: "subscription" }
        : { kind: "none", fix: CLAUDE_CODE_ACCESS_FIX },
  // A discrete `Skill` tool_use in the trace says WHICH skill was selected, so
  // the selection-collision matrix and the adversarial gate can run here.
  firing: { kind: "event" },
  // Claude Code namespaces a plugin's skill as `<plugin>:<skill>`; the manifest
  // name is handed in by the domain, which read it off the layout.
  firedFor:
    (skill, plugin) =>
    (t): boolean =>
      whichSkillsFired(t).includes(
        plugin.name ? `${plugin.name}:${skill}` : skill,
      ),
  // The probe may rebuild the plugin to skills-only stubs: this is the harness
  // whose plugin shape vigiles packages, so a stubbed rebuild is validated.
  installsStubs: true,
};

/**
 * Is this directory entry a skill DIRECTORY — following a symlink to one?
 *
 * 🔴 `Dirent.isDirectory()` describes the ENTRY, not its target: for a symlink
 * pointing at a directory it is FALSE. Skipping on it therefore skips symlinked
 * skills entirely, and the failure is silent and misreads as a finding — the skill
 * never enters the temp install, so nothing fires on any prompt and the run reports
 * 0% recall plus a competing-skill count short by however many were linked. The
 * tool then says "usually SETUP, not the description", which is true and useless,
 * because the setup it means is its own.
 *
 * A symlinked skills tree is not exotic: it is what a consumer gets when skills are
 * distributed as an npm package and linked into `.claude/skills/`, which is exactly
 * how a package publishes them.
 *
 * `statSync` follows the link, so it answers about the TARGET. A dangling link
 * throws, and that is not-a-skill-dir — the same answer the `SKILL.md` check
 * downstream would give it, one step earlier and without an exception escaping.
 */
function isSkillDirEntry(parent: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Package loose `<skillsDir>/<name>/SKILL.md` skills into a throwaway plugin dir
 * that `claude --plugin-dir` accepts — so repo-local skills (e.g. `.claude/skills`)
 * can be trigger-tested without hand-rolling a `plugin.json`. Writes a minimal
 * `.claude-plugin/plugin.json` and copies each `<name>/` (recursively, so
 * `references/` etc. come along) under `skills/<name>/`. Returns the temp plugin
 * dir; the caller removes it (`measureTriggerRate` does). Throws if the directory
 * is missing or holds no `<name>/SKILL.md`.
 */
export function packageSkillsDir(
  skillsDir: string,
  opts: { name?: string; stub?: boolean } = {},
): string {
  const abs = resolve(skillsDir);
  if (!existsSync(abs))
    throw new Error(`skillsDir not found: ${skillsDir} (resolved ${abs})`);
  const root = makeTmpDir("skills");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      { name: opts.name ?? LOOSE_SKILLS_NAMESPACE, version: "0.0.0" },
      null,
      2,
    ),
  );
  const skillsOut = join(root, "skills");
  mkdirSync(skillsOut, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!isSkillDirEntry(abs, entry)) continue;
    const srcSkill = join(abs, entry.name, "SKILL.md");
    if (!existsSync(srcSkill)) continue;
    const destDir = join(skillsOut, entry.name);
    if (opts.stub) {
      // Frontmatter-only: keep the trigger surface (name + description), drop the
      // body so a selected skill stops instead of running its procedure.
      mkdirSync(destDir, { recursive: true });
      writeFileSync(
        join(destDir, "SKILL.md"),
        stubSkillBody(readFileSync(srcSkill, "utf-8")),
      );
    } else {
      cpSync(join(abs, entry.name), destDir, { recursive: true });
    }
    copied++;
  }
  if (copied === 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`No <name>/SKILL.md skills found under ${skillsDir}`);
  }
  return root;
}

/** The skills directory inside a plugin (`skills/` or `.claude/skills/`). */
function skillsDirOf(pluginDir: string): string {
  const direct = join(pluginDir, "skills");
  if (existsSync(direct)) return direct;
  return join(pluginDir, ".claude", "skills");
}

/** A plugin's declared name (from `.claude-plugin/plugin.json`), for the skill
 * id the `fired` predicate matches (`<name>:<skill>`). */
function pluginName(pluginDir: string): string | undefined {
  const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
  try {
    return (JSON.parse(readFileSync(manifest, "utf-8")) as { name?: string })
      .name;
  } catch {
    return undefined;
  }
}

/**
 * Build a throwaway plugin dir mirroring `pluginDir`'s skills with their BODIES
 * stripped (frontmatter kept) — the trigger surface a description/firing check
 * needs, without paying to run each skill's procedure. Keeps the original plugin
 * NAME so `<name>:<skill>` ids still match. The caller removes the returned dir.
 * See {@link stubSkillBody} for why the body is irrelevant to selection.
 */
export function stubbedPluginDir(pluginDir: string): string {
  return packageSkillsDir(skillsDirOf(pluginDir), {
    stub: true,
    name: pluginName(pluginDir),
  });
}

/**
 * Resolve the effective `--plugin-dir` for a trigger run: a caller's `pluginDir`
 * as-is, or a throwaway package built from a loose `skillsDir`. Exactly one must
 * be set. `packaged` is present only when vigiles built it, so the caller knows
 * to remove it afterward.
 */
/** The dir holding `<name>/SKILL.md` for a source that may be a plugin (`skills/`
 *  or `.claude/skills/`) or already a loose skills dir. */
function collectSkillsSource(dir: string): string {
  const abs = resolve(dir);
  const pluginSkills = join(abs, "skills");
  if (existsSync(pluginSkills)) return pluginSkills;
  const ccSkills = join(abs, ".claude", "skills");
  if (existsSync(ccSkills)) return ccSkills;
  return abs;
}

/**
 * Copy each `<name>/SKILL.md` skill from `src` into `skillsOut` (stubbing the body
 * when asked); skip a skill whose name is already `present` so the under-test
 * skill wins a collision. Returns how many were newly copied.
 */
function copySkillsInto(
  src: string,
  skillsOut: string,
  stub: boolean,
  present: Set<string>,
): number {
  const abs = resolve(src);
  if (!existsSync(abs))
    throw new Error(`installSet source not found: ${src} (resolved ${abs})`);
  let copied = 0;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!isSkillDirEntry(abs, entry) || present.has(entry.name)) continue;
    const srcSkill = join(abs, entry.name, "SKILL.md");
    if (!existsSync(srcSkill)) continue;
    const destDir = join(skillsOut, entry.name);
    if (stub) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(
        join(destDir, "SKILL.md"),
        stubSkillBody(readFileSync(srcSkill, "utf-8")),
      );
    } else {
      cpSync(join(abs, entry.name), destDir, { recursive: true });
    }
    present.add(entry.name);
    copied++;
  }
  return copied;
}

/**
 * Build a combined plugin: the under-test skills PLUS every `installSet` source's
 * skills, so the skill-under-test competes for selection as in the real harness.
 * Named after the under-test plugin so `<name>:<skill>` ids still match; the
 * under-test skills win a name collision. Returns the dir + `added` = how many
 * installSet skills were merged in (excludes collisions). The report's
 * `competitors` is derived separately from the FULL pool (see `countSkills`), so
 * sibling skills already in the under-test source count too. Caller removes the
 * dir. Pure (filesystem only).
 */
export function packageInstallSet(opts: {
  underTestSrc: string;
  name: string;
  installSet: readonly string[];
  stub: boolean;
}): { dir: string; added: number } {
  const root = makeTmpDir("harness");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: opts.name, version: "0.0.0" }, null, 2),
    );
    const skillsOut = join(root, "skills");
    mkdirSync(skillsOut, { recursive: true });
    const present = new Set<string>();
    const underTest = copySkillsInto(
      opts.underTestSrc,
      skillsOut,
      opts.stub,
      present,
    );
    if (underTest === 0)
      throw new Error(
        `No <name>/SKILL.md skills under the skill-under-test source ${opts.underTestSrc}`,
      );
    let added = 0;
    for (const src of opts.installSet)
      added += copySkillsInto(
        collectSkillsSource(src),
        skillsOut,
        opts.stub,
        present,
      );
    return { dir: root, added };
  } catch (e) {
    rmSync(root, { recursive: true, force: true }); // don't leak the temp dir
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The install source — the ONE place that decides what `--plugin-dir` receives.
//
// Every runner that installs skills (runEval via an EvalArm — the one arm of a
// spec with no `arms` included — and measureTriggerRate via its spec) accepts the same two fields —
// `pluginDir` (a complete plugin, used as-is or re-packaged with stubbed bodies)
// and `skillsDir` (a loose `<name>/SKILL.md` dir, packaged into a throwaway
// plugin) — and they all resolve through `resolveSkillInstall`. Before this
// existed each runner re-derived the rule for itself, and the one written last
// was the only one that knew about loose dirs (issue #307).
// ---------------------------------------------------------------------------

/** The plugin name a packaged loose skills dir installs under. */
const LOOSE_SKILLS_NAMESPACE = "vigiles-loose-skills";

/** Where the skills come from: a complete plugin, or a loose skills dir. */
interface SkillSource {
  readonly pluginDir?: string;
  readonly skillsDir?: string;
}

/** A source resolved to something `--plugin-dir` accepts. */
interface ResolvedInstall {
  /** The dir to install; undefined when the source names nothing. */
  readonly pluginDir?: string;
  /** Set iff vigiles BUILT `pluginDir` and the caller must remove it. */
  readonly packaged?: string;
  /** The `<namespace>` in the `<namespace>:<skill>` ids the install reports. */
  readonly namespace?: string;
}

/**
 * The plugin namespace a source's skills install under — the `<plugin>` half of
 * the `<plugin>:<skill>` id `skill()` / `check.skill` match. A loose dir gets
 * the packager's name; a plugin its declared name, falling back to the same
 * synthetic one when its manifest has none. Pure (reads the manifest only).
 */
function installNamespace(src: SkillSource): string | undefined {
  if (src.skillsDir) return LOOSE_SKILLS_NAMESPACE;
  if (src.pluginDir) return pluginName(src.pluginDir) ?? LOOSE_SKILLS_NAMESPACE;
  return undefined;
}

/**
 * Resolve a {@link SkillSource} to a concrete plugin dir. `stub` strips skill
 * bodies (frontmatter kept) into a throwaway; `installSet` merges competitor
 * skills in (the whole-harness tier, `measureTriggerRate` only). Exactly one of
 * `pluginDir` / `skillsDir` may be set; neither resolves to nothing installed —
 * the caller decides whether that is legal (an arm: yes; a trigger run: no).
 */
function resolveSkillInstall(
  src: SkillSource,
  opts: { caller: string; stub: boolean; installSet?: readonly string[] },
): ResolvedInstall {
  if (src.pluginDir && src.skillsDir)
    throw new Error(
      `${opts.caller}: set \`pluginDir\` OR \`skillsDir\`, not both.`,
    );
  const namespace = installNamespace(src);
  if (namespace === undefined) return {};
  const installSet = opts.installSet ?? [];
  if (installSet.length > 0) {
    // Whole-harness tier: merge the under-test skills with the install set so
    // selection is competitive (the realistic, differentiated measurement).
    const { dir } = packageInstallSet({
      underTestSrc: src.skillsDir ?? skillsDirOf(src.pluginDir as string),
      name: namespace,
      installSet,
      stub: opts.stub,
    });
    return { pluginDir: dir, packaged: dir, namespace };
  }
  if (src.skillsDir) {
    const dir = packageSkillsDir(src.skillsDir, { stub: opts.stub });
    return { pluginDir: dir, packaged: dir, namespace };
  }
  // A real plugin: as-is, or re-packaged from its skills/ with bodies stripped —
  // keeping the original plugin NAME so `<name>:<skill>` still matches.
  const pluginDir = src.pluginDir as string;
  if (!opts.stub) return { pluginDir, namespace };
  const dir = stubbedPluginDir(pluginDir);
  return { pluginDir: dir, packaged: dir, namespace };
}

/**
 * Resolve every arm's install source (see {@link resolveSkillInstall}) so each
 * arm carries only a concrete `pluginDir` — `skillsDir` is consumed here. Returns
 * the rewritten arms plus the throwaway dirs the caller removes afterward. A
 * failure part-way removes what was already built (no leaked temp dirs).
 */
function resolveArmInstalls(
  arms: Record<string, EvalArm>,
  stub: boolean,
): { arms: Record<string, EvalArm>; packaged: string[] } {
  const out: Record<string, EvalArm> = {};
  const packaged: string[] = [];
  try {
    for (const [name, arm] of Object.entries(arms)) {
      const { skillsDir: _consumed, ...rest } = arm;
      const r = resolveSkillInstall(arm, {
        caller: `eval arm "${name}"`,
        stub,
      });
      if (r.packaged) packaged.push(r.packaged);
      out[name] = { ...rest, pluginDir: r.pluginDir };
    }
  } catch (e) {
    for (const dir of packaged) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { arms: out, packaged };
}

/** Number of `<name>/SKILL.md` skills installed in a plugin — the selection pool. */
function countSkills(pluginDir: string): number {
  const dir = skillsDirOf(pluginDir);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (isSkillDirEntry(dir, e) && existsSync(join(dir, e.name, "SKILL.md")))
      n++;
  return n;
}

function resolveTriggerPluginDir(spec: TriggerRateSpec): {
  pluginDir: string;
  packaged?: string;
  competitors: number;
  namespace: string;
} {
  const r = resolveSkillInstall(spec, {
    caller: "measureTriggerRate",
    stub: spec.stubSkillBodies ?? true, // trigger = frontmatter; body never needed
    installSet: spec.installSet,
  });
  if (r.pluginDir === undefined || r.namespace === undefined)
    throw new Error("measureTriggerRate: provide `pluginDir` or `skillsDir`.");
  // `competitors` is the REAL selection pressure: every OTHER skill installed in
  // the resolved plugin (siblings already in the source + any installSet), not
  // just the installSet delta — so a multi-skill plugin is never mislabeled
  // "isolated". `max(0, …)` guards a 0-skill pool.
  return {
    pluginDir: r.pluginDir,
    packaged: r.packaged,
    competitors: Math.max(0, countSkills(r.pluginDir) - 1),
    namespace: r.namespace,
  };
}

/** A trigger spec's `fired`, in either form, as the predicate a trial applies. */
function firedPredicate(
  fired: TriggerRateSpec["fired"],
): (trace: Trace) => boolean {
  return typeof fired === "function"
    ? fired
    : (trace) => fired.eval(trace).pass;
}

/** The per-run knobs a trigger set shares (everything but the prompt list). */
interface TriggerRunConfig {
  readonly trials: number;
  readonly model: string;
  readonly effort?: string | number;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
  readonly spacing: number;
  readonly pluginDir: string;
  readonly fired: (trace: Trace) => boolean;
  /** Files seeded into each run's cwd (the skill's measured context). */
  readonly fixture?: Record<string, string>;
  /** Parallel runs across the prompts × trials grid (default 1). */
  readonly concurrency: number;
  /** How to parse the runner's stdout into a trace (default Claude stream-json). */
  readonly parse: ModelOutputParser;
  /** Detect an errored/rate-limited turn (excluded from the rate, not a miss). */
  readonly runError?: (out: RunOut) => string | null;
}

/** Run one prompt set × trials through `runner`, aggregating fired counts. */
/** Run one trigger trial in a throwaway cwd (fixture seeded) → fired 0/1. */
async function runTriggerTrial(
  prompt: string,
  cfg: TriggerRunConfig,
  runner: AgentRunner,
): Promise<{ fired: number; errored: boolean; usage: EvalUsage }> {
  const cwd = makeTmpDir("trigger");
  try {
    if (cfg.fixture) writeFiles(cwd, cfg.fixture);
    const out = await runner({
      task: prompt,
      cwd,
      model: cfg.model,
      effort: cfg.effort,
      tools: cfg.tools,
      hasSettings: false,
      pluginDir: cfg.pluginDir,
      timeoutMs: cfg.timeoutMs,
    });
    // Usage comes from the parser (harness-neutral: Claude + Codex both fill it),
    // and a run costs tokens even when it errors — so accumulate it either way.
    const ctx = makeContext(cwd, out, cfg.parse);
    // An errored/rate-limited turn is NOT a "skill didn't fire" miss — it's
    // excluded from the rate, so e.g. a Codex usage limit can't read as recall 0.
    if (cfg.runError?.(out))
      return { fired: 0, errored: true, usage: ctx.usage };
    return {
      fired: cfg.fired(ctx) ? 1 : 0,
      errored: false,
      usage: ctx.usage,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await sleep(cfg.spacing);
  }
}

/** A count for reporting: the number if positive, else undefined (omit zero). */
const positiveOrUndefined = (n: number): number | undefined =>
  n > 0 ? n : undefined;

async function runTriggerSet(
  prompts: readonly string[],
  cfg: TriggerRunConfig,
  runner: AgentRunner,
): Promise<{
  perPrompt: PromptTriggerStat[];
  fired: number;
  n: number;
  errored: number;
  /** Per-run usage across this set (every run, errored or not — cost is cost). */
  usages: EvalUsage[];
}> {
  // Flatten prompts × trials into one work list so concurrency spans both.
  const jobs = prompts.flatMap((prompt, promptIndex) =>
    Array.from({ length: cfg.trials }, () => ({ prompt, promptIndex })),
  );
  const outcomes = await runPool(jobs, cfg.concurrency, (job) =>
    runTriggerTrial(job.prompt, cfg, runner),
  );
  // Re-aggregate per prompt, preserving input order; errored runs don't count.
  const firedBy = new Array<number>(prompts.length).fill(0);
  const trialsBy = new Array<number>(prompts.length).fill(0);
  let errored = 0;
  jobs.forEach((job, i) => {
    if (outcomes[i].errored) {
      errored += 1;
      return;
    }
    firedBy[job.promptIndex] += outcomes[i].fired;
    trialsBy[job.promptIndex] += 1;
  });
  const perPrompt: PromptTriggerStat[] = prompts.map((prompt, i) => ({
    prompt,
    fired: firedBy[i],
    trials: trialsBy[i],
    rate: trialsBy[i] > 0 ? firedBy[i] / trialsBy[i] : 0,
  }));
  return {
    perPrompt,
    fired: firedBy.reduce((a, b) => a + b, 0),
    n: trialsBy.reduce((a, b) => a + b, 0),
    errored,
    usages: outcomes.map((o) => o.usage),
  };
}

/**
 * Trigger-rate orchestration — every prompt × trial via `runner`, the `fired`
 * predicate evaluated per run and aggregated into an overall + per-prompt rate.
 * With `irrelevantPrompts`, also runs the precision side (firing there is a false
 * positive) and adds `falsePositiveRate` + `precision`. Exported with an
 * injectable `runner` so the loop is unit-testable without a model;
 * `measureTriggerRate` is this with the real agent runner.
 */
/** Diversity pre-flight: reject a too-small / near-duplicate prompt set (both sides). */
function assertTriggerDiversity(spec: TriggerRateSpec): void {
  const diversity = {
    minPrompts: spec.minPrompts,
    minDistance: spec.minDistance,
  };
  assertPromptDiversity(spec.prompts, { ...diversity, label: "prompts" });
  if (spec.irrelevantPrompts && spec.irrelevantPrompts.length > 0) {
    assertPromptDiversity(spec.irrelevantPrompts, {
      ...diversity,
      label: "irrelevantPrompts",
    });
  }
}

export async function measureTriggerRateWith(
  spec: TriggerRateSpec,
  runner: AgentRunner,
  parse: ModelOutputParser = parseClaudeRun,
  runError?: (out: RunOut) => string | null,
  harness = "claude-code",
): Promise<TriggerRateReport> {
  assertKnownKeys(spec, TRIGGER_RATE_SPEC_KEYS, {
    caller: "measureTriggerRate",
    type: "TriggerRateSpec",
  });
  // Tell the CLI runner this script exercised the harness (see check-count.ts).
  recordCheck();
  // Deterministic gate FIRST — before spending a token (or packaging a skillsDir).
  assertTriggerDiversity(spec);

  // Model floor (default Sonnet): trigger-rate under-measures selection on a
  // weaker model, so FAIL before spending a token rather than report a
  // false-negative recall. The floor lives in the spec (`minModel`), not an env
  // override — model choice is part of the measurement definition. Lower it
  // deliberately for a cheap run.
  const model = spec.model ?? "sonnet";
  const minModel = spec.minModel ?? "sonnet";
  if (belowModelFloor(model, minModel))
    throw new Error(
      `measureTriggerRate: model "${model}" is below the minimum "${minModel}" — ` +
        "trigger-rate under-measures selection on a weaker model " +
        "(raise the model, or lower `minModel` for a deliberately cheap run).",
    );

  const { pluginDir, packaged, competitors, namespace } =
    resolveTriggerPluginDir(spec);
  const cfg: TriggerRunConfig = {
    trials: spec.trials ?? 1,
    // Sonnet, not haiku: trigger-rate is a selection measurement and haiku
    // under-selects, producing false-negative recall (see TriggerRateSpec.model).
    model,
    effort: spec.effort,
    tools: spec.allowedTools ?? ["Read", "Edit", "Write", "Bash", "Skill"],
    timeoutMs: spec.timeoutMs ?? 240000,
    spacing: (spec.spacingSec ?? 4) * 1000,
    pluginDir,
    fired: firedPredicate(spec.fired),
    fixture: spec.fixture,
    concurrency: Math.max(1, spec.concurrency ?? 1),
    parse,
    runError,
  };

  const lock = resolveLock(spec.lock);
  try {
    // The lock hashes the skill UNDER TEST (its dir contents) + the prompts +
    // model + tools — the inputs that steer whether it fires. `--check` replays
    // the committed report with no model; `--update` records it. Resolved only
    // when the lock is active. `trials` is excluded (a sample-size knob).
    const triggerInputs =
      lock.mode === "off"
        ? undefined
        : {
            pluginDirHash: hashDir(pluginDir),
            prompts: [...spec.prompts],
            irrelevantPrompts: spec.irrelevantPrompts
              ? [...spec.irrelevantPrompts]
              : undefined,
            model: cfg.model,
            effort: cfg.effort,
            tools: [...cfg.tools].sort(),
            fixture: spec.fixture,
            competitors,
            // The harness the driver runs is a model-facing input — a Claude vs
            // Codex run can fire a skill differently — so a recorded report is
            // STALE if the eval is switched to another harness.
            harness,
          };
    return await withEvalLock(
      {
        name: spec.name,
        inputs: triggerInputs,
        model: cfg.model,
        effort: cfg.effort,
        lock,
      },
      async () => {
        const relevant = await runTriggerSet(spec.prompts, cfg, runner);
        const base: TriggerRateReport = {
          rate: relevant.n > 0 ? relevant.fired / relevant.n : 0,
          n: relevant.n,
          perPrompt: relevant.perPrompt,
          competitors,
          namespace,
          errored: positiveOrUndefined(relevant.errored),
          usage: aggregateUsage(relevant.usages),
        };
        if ((spec.irrelevantPrompts?.length ?? 0) === 0) return base;

        const irrelevant = await runTriggerSet(
          spec.irrelevantPrompts ?? [],
          cfg,
          runner,
        );
        const fires = relevant.fired + irrelevant.fired;
        return {
          ...base,
          errored: positiveOrUndefined(relevant.errored + irrelevant.errored),
          falsePositiveRate:
            irrelevant.n > 0 ? irrelevant.fired / irrelevant.n : 0,
          precision: fires > 0 ? relevant.fired / fires : undefined,
          perIrrelevant: irrelevant.perPrompt,
          // Total cost across BOTH sets (the precision runs cost tokens too).
          usage: aggregateUsage([...relevant.usages, ...irrelevant.usages]),
        };
      },
    );
  } finally {
    // Remove the throwaway plugin dir we built from a loose `skillsDir`.
    if (packaged) rmSync(packaged, { recursive: true, force: true });
  }
}

/* v8 ignore start -- real claude subprocess; thin wrapper over measureTriggerRateWith */
/**
 * Measure a skill/behaviour's real trigger rate across prompts × trials. Defaults
 * to the real `claude` CLI (`claudeEvalDriver`); pass `{ evalDriver }` to drive a
 * second harness — e.g. `measureTriggerRate(spec, { evalDriver: paid_codexEvalDriver })`
 * from `vigiles/harness/codex` (the eval-tier analog of `runHarnessTest`'s `{ adapter }`).
 * Requires that harness's binary + auth.
 *
 * @public
 */
export async function measureTriggerRate(
  spec: TriggerRateSpec,
  opts: { evalDriver?: EvalDriver } = {},
): Promise<TriggerRateReport> {
  const d = opts.evalDriver ?? claudeEvalDriver;
  const measured = await measureTriggerRateWith(
    spec,
    d.runner,
    d.parse,
    d.runError,
    d.harness ?? "claude-code",
  );
  // Precision-first: if the driver flags its trigger-rate EXPERIMENTAL (Codex),
  // carry the caveat onto the report and warn loudly, so the number is never
  // mistaken for a validated measurement.
  const report = d.experimental
    ? { ...measured, experimental: d.experimental }
    : measured;
  if (d.experimental) {
    process.stderr.write(
      `⚠ EXPERIMENTAL trigger-rate on ${d.harness ?? "?"}: ${d.experimental}\n`,
    );
  }
  // Surface what the run spent (tokens + API-equivalent $ + metered warning).
  emitCostSummary(costFromArm(report.usage));
  // Feed the flight recorder: recall (+ precision when measured) for this skill.
  const evalName = spec.name ?? "trigger-rate";
  appendObservation({
    kind: "eval",
    name: evalName,
    metric: "recall",
    value: report.rate,
  });
  if (report.precision !== undefined) {
    appendObservation({
      kind: "eval",
      name: evalName,
      metric: "precision",
      value: report.precision,
    });
  }
  return report;
}
/* v8 ignore stop */
