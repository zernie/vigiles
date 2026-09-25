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
import { spawn, execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  cpSync,
  rmSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, delimiter } from "node:path";

import { appendObservation } from "./observe.js";
import { resolveHarness } from "./adapters/claude-code/plugin-loader.js";
import { claudeCodeRuntime } from "./adapters/claude-code/runtime.js";
import {
  emitCostSummary,
  costFromEvalReport,
  costFromArm,
  sumCosts,
} from "./eval-cost.js";
import { ncd } from "./core/proofs.js";
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
import {
  parseToolCalls,
  parseResultEvent,
  parseHooks,
  parseSubagents,
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
import type { Check, CheckJSON } from "./check.js";
import { welchTTest, type Comparison } from "./stats.js";
import { recordCheck } from "./check-count.js";
import { probeTrace } from "./coverage-probe.js";
import {
  type ToolIntercept,
  buildInterceptSettings,
  serializeIntercepts,
  INTERCEPT_TOOLS_ENV,
} from "./tool-intercept.js";
import { type ToolStub, stubBinDir } from "./tool-stub.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { editDistance } from "./core/edit-distance.js";

/** One arm of the comparison: fixture overrides + settings (hooks) for this arm. */
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
   * namespace `vigiles-loose-skills`, so a `skill()` check / `skillResolved`
   * matches `vigiles-loose-skills:<name>` (the report's `namespace` says so).
   * Provide this OR {@link pluginDir}, not both.
   */
  readonly skillsDir?: string;
  /**
   * Tools to intercept for this arm (the tool-call spy). Each
   * {@link ToolIntercept} is denied its real execution by an auto-wired PreToolUse
   * hook — the model still emits the `tool_use` (so its arguments land in the
   * `Trace` for `toolWith` / `notTool`), but the side effect (a paid API call, a
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
 * a `Trace` (so the bare predicates `usedTool` / `skillResolved` / `toolCount` /
 * `toolUsedWith` from `harness-assert.ts` run over it, the same as over a
 * `runHarnessTest` result) plus the eval-only `sh` end-state probe and `usage`.
 */
export interface RunContext extends Trace {
  readonly cwd: string;
  readonly exitCode: number;
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

export type Metrics = Record<string, number | boolean>;

export interface EvalSpec<M extends Metrics> {
  readonly name?: string;
  /** Base fixture files (path → contents), written fresh for every run. */
  readonly fixture?: Record<string, string>;
  /** The arms to compare, by name. */
  readonly arms: Record<string, EvalArm>;
  /**
   * Stub each arm's skill BODIES (frontmatter kept) before the run — for firing
   * comparisons (does the skill get SELECTED?), where a selected skill should
   * stop at selection instead of running its (often expensive) procedure. Every
   * arm with a `pluginDir` / `skillsDir` is repackaged with bodies stripped; arms
   * without one are untouched. Don't combine with quality metrics: the body is
   * gone, so there is nothing to grade. See {@link stubSkillBody}.
   */
  readonly stubSkillBodies?: boolean;
  /** The task prompt given to the agent. */
  readonly task: string;
  /** Compute this run's metrics from its outcome. */
  readonly measure: (ctx: RunContext) => M;
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
  /** Tools the agent may use. Default: Read Edit Write Bash. */
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
   * **Opt-in, default OFF.** Run each trial in an *ephemeral run environment* — a
   * throwaway `$HOME` + scrubbed env, re-injecting only the harness's own auth (see
   * `ephemeralRunEnv`). Running a model-driven skill/agent is itself a side
   * effect (the *model*, not the author, chose the actions), so a `git push` /
   * write to `~` should land in a disposable HOME, not the real `~/.gitconfig` /
   * `~/.ssh` / `~/.aws`. This is the cross-platform STATE-protection floor (no
   * kernel features), orthogonal to the bubblewrap host-confinement in
   * `src/sandbox.ts`.
   *
   * **Ships default-OFF** because a too-narrow auth allowlist would silently break
   * the real `claude` CLI's authentication; leaving it off keeps every existing
   * eval (including one running right now) authenticating exactly as before. When
   * absent / `false`, the per-trial env is byte-identical to today
   * (`{ ...process.env, ...arm.env }`). See `docs/safety.md` (ephemerality) and
   * `research/cross-platform-sandboxing.md`.
   */
  readonly ephemeralEnv?: boolean;
  /**
   * **Tool stubs on PATH (rung R2).** A list of fake binaries to shadow on PATH
   * for every trial, so a skill/hook/agent that calls a CLI tool (`gh`, `psql`,
   * `redis-cli`, `z3`, …) and works with its RESULT can be tested against a
   * **recorded / author-provided canned output** — no live service. vigiles writes
   * one executable stub per {@link ToolStub} into a bin dir under the trial cwd and
   * PREPENDS that dir to the run's PATH (both the default and the ephemeral env
   * path), so the fake wins over the real binary.
   *
   * The stubs are author/recorded fixtures, **never** model-synthesized — a
   * synthesized tool output looks plausible but diverges from the real
   * tool/version (false confidence). Absent → no change (the PATH is byte-identical
   * to today). See {@link ToolStub} and `research/eval-coverage-and-isolation.md`.
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
}

/** Per-metric summary statistics across an arm's runs. */
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
   * pass^k (τ-bench): 1 if the metric succeeded on EVERY trial, else 0. The
   * reliability question a non-deterministic harness needs — "worked every time"
   * is not "worked on average". A trial counts as a success when its value is
   * truthy (booleans true, counts > 0), so model your metric as success/fail.
   */
  readonly passK: number;
}

/** Aggregated cost / latency / tokens across an arm's runs. */
export interface ArmUsage {
  readonly totalCostUsd: number;
  readonly meanCostUsd: number;
  readonly meanDurationMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCacheReadTokens: number;
}

export interface ArmReport {
  readonly runs: number;
  /** Aggregated metrics: mean for numbers, fraction-true (0..1) for booleans. */
  readonly metrics: Record<string, number>;
  /** Per-metric mean / std / se / n, so an A/B gap can be read for significance. */
  readonly stats: Record<string, MetricStat>;
  /** Cost / latency / token totals + means for this arm. */
  readonly usage: ArmUsage;
}

export interface EvalReport {
  readonly name: string;
  readonly trials: number;
  readonly arms: Record<string, ArmReport>;
  /** Total measured cost across every arm × trial (0 when usage wasn't reported). */
  readonly totalCostUsd: number;
  /** True if a `maxCostUsd` budget cap stopped the run before all trials ran. */
  readonly aborted: boolean;
}

function writeFiles(cwd: string, files: Record<string, string>): void {
  for (const [p, content] of Object.entries(files)) {
    const full = resolve(cwd, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Resolve the environment a trial's subprocess actually runs with — the
 * SECURITY-CRITICAL decision behind `ephemeralEnv`. When `replaceEnv` is set, the
 * scrubbed `env` is the COMPLETE environment, so the real `$HOME` and inherited
 * secrets are DROPPED; otherwise `env` is an overlay on `base` (byte-identical to
 * the pre-ephemeral behaviour). Extracted from the `v8 ignore`d `spawnAgent` so
 * the one line that enforces the scrub is both unit- and behaviourally-tested — a
 * regression to an always-merge would otherwise silently defeat ephemerality and
 * leak the host environment into an untrusted, model-driven run.
 */
export function resolveSpawnEnv(
  a: Pick<AgentRunArgs, "env" | "replaceEnv" | "effort">,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = a.replaceEnv ? (a.env ?? {}) : { ...base, ...a.env };
  return pinEffortEnv(resolved, a.effort);
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
 * — and the env var wins over the flag. `EPHEMERAL_ALLOW_PREFIXES` passes
 * `CLAUDE_*` through by design (the CLI reads several such knobs and dropping one
 * is the failure mode), so an ambient `CLAUDE_CODE_EFFORT_LEVEL=max` in the
 * author's shell survives even the SCRUBBED ephemeral env. Without this pin,
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
    "--permission-mode",
    "acceptEdits",
    ...(a.pluginDir !== undefined
      ? ["--plugin-dir", resolve(a.pluginDir)]
      : []),
    ...(a.hasSettings ? ["--settings", "settings.json"] : []),
    "--allowedTools",
    ...a.tools,
  ];
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
export const spawnAgent: AgentRunner = withEffortGuard(spawnAgentRaw);

/* v8 ignore start -- real claude subprocess; exercised by bench/, not the unit gate */
/** The unguarded spawn itself; wrapped by {@link spawnAgent}, never bound raw. */
function spawnAgentRaw(a: AgentRunArgs): Promise<RunOut> {
  refuseDuringEvalLoad("spawning `claude`");
  refuseUnderForeignRunner("spawning `claude`");
  return new Promise((resolvePromise) => {
    const args = buildAgentArgs(a);
    const child = spawn(claudeCodeRuntime.agentBinary, args, {
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
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Run the eval: every arm × every trial against the real `claude` CLI, with the
 * metric computed per run and aggregated per arm. Requires `claude` on PATH and
 * working model auth (e.g. `ANTHROPIC_API_KEY`). Thin wrapper over
 * `runEvalWith` with the real agent runner.
 */
/**
 * A `SKILL.md` written straight into a run's cwd (via an arm's `files`) is NOT
 * registered as a skill by the harness. Claude Code — and Codex — load skills only
 * from a plugin / `.claude/skills` layout, so a bare cwd `SKILL.md` sits unread:
 * the arm silently measures NOTHING (baseline and "skill" become the same run). This
 * is the exact footgun the ecosystem benchmark hit — a skill file delivered where it
 * can never activate, with no error. Detect it so {@link runEval} / {@link measureArms}
 * can WARN and point at `pluginDir` (a real `--plugin-dir` install) or `skillsDir`.
 *
 * HIGH-PRECISION (don't cry wolf): only a file whose basename is `SKILL.md` AND that
 * carries real skill frontmatter (a `---` block naming `name`/`description`) is flagged
 * — so an empty scratch `SKILL.md` a task is asked to AUTHOR is never flagged. Pure +
 * exported for testing.
 */
export function unregisteredSkillFiles(
  files: Record<string, string> | undefined,
): string[] {
  if (files === undefined) return [];
  return Object.entries(files)
    .filter(([p, c]) => skillBasename(p) && hasSkillFrontmatter(c))
    .map(([p]) => p);
}

function skillBasename(path: string): boolean {
  return (path.split(/[\\/]/).pop() ?? path) === "SKILL.md";
}

function hasSkillFrontmatter(content: string): boolean {
  const m = /^\uFEFF?\s*---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return m !== null && /(^|\n)\s*(name|description)\s*:/.test(m[1]);
}

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

export async function runEval<M extends Metrics>(
  spec: EvalSpec<M>,
): Promise<EvalReport> {
  warnUnregisteredSkillArms(spec.arms);
  const report = await runEvalWith(spec, spawnAgent);
  // Surface what the run spent — tokens + API-equivalent $, and a LOUD warning if
  // it was billed to a metered API key instead of the subscription. See eval-cost.ts.
  emitCostSummary(costFromEvalReport(report));
  return report;
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// measure() — the SCORED evaluator (Phase 3 of testing-api-design.md)
// ---------------------------------------------------------------------------

/** A task run N times, scored against a `Trace` check vocabulary. */
export interface MeasureSpec {
  /** Base fixture files written for every run (path → contents). */
  readonly fixture?: Record<string, string>;
  /** `.claude/settings.json` (hooks/permissions) for the run. */
  readonly settings?: unknown;
  /** A real plugin/repo to load (materialized) — see `EvalArm.plugin`. */
  readonly plugin?: string;
  /**
   * A complete plugin dir to install natively (`--plugin-dir`) so skills activate
   * — see {@link EvalArm.pluginDir}. Provide this OR `skillsDir`, not both.
   */
  readonly pluginDir?: string;
  /**
   * A loose `<skillsDir>/<name>/SKILL.md` directory (e.g. a repo's `.claude/skills`)
   * to install, auto-packaged into a throwaway plugin — see {@link EvalArm.skillsDir}.
   * Installs under `vigiles-loose-skills`, so `skill("vigiles-loose-skills:<name>")`.
   */
  readonly skillsDir?: string;
  /**
   * Stub each skill BODY (frontmatter/trigger surface kept) before the run — for
   * checks about whether a skill FIRES (`skill()`), not what it produces. A
   * selected skill stops at selection instead of running its (often expensive)
   * procedure, so a description/firing run costs a fraction of the tokens. Do NOT
   * combine with `judged`/quality checks: the body is gone, so there's nothing to
   * grade. Requires `pluginDir` or `skillsDir`. See {@link stubSkillBody}.
   */
  readonly stubSkillBodies?: boolean;
  /** Tools to intercept (the tool-call spy) — see {@link EvalArm.interceptTools}. */
  readonly interceptTools?: readonly ToolIntercept[];
  /** The task prompt given to the agent. */
  readonly task: string;
  /**
   * The checks to score across the trials. Any check over the run is accepted:
   * `Trace` checks (`tool`/`skill`/`output`/`mcp`/`judged`) and resource checks
   * (`cost`/`latency`/`tokens`, which read the eval-only `usage`) — all fit
   * `Check<RunContext>`.
   */
  readonly checks: readonly Check<RunContext>[];
  /** Trials. Default 5. */
  readonly trials?: number;
  /** Model alias. Default "sonnet" — measure on the model your users run. */
  readonly model?: string;
  /**
   * Reasoning budget for the run (`claude --effort`, e.g. `"low"` or an integer).
   * Lives here beside `model` because it is part of the MEASUREMENT — it moves the
   * output distribution, not the sample size — so it is hashed into the lock and
   * the cache, and never read from an env var. Omit for the harness default.
   */
  readonly effort?: string | number;
  /** Tools the agent may use. */
  readonly allowedTools?: readonly string[];
  /** Per-run timeout ms. */
  readonly timeoutMs?: number;
  /** Seconds between runs. */
  readonly spacingSec?: number;
}

/** One check's measured rate across the trials. */
export interface CheckRate {
  readonly check: CheckJSON;
  /** Fraction of trials the check passed (0..1). */
  readonly rate: number;
  /** Standard error of the rate. */
  readonly se: number;
  /** pass^k — 1 iff the check passed on EVERY trial. */
  readonly passK: number;
  /** Trials observed. */
  readonly n: number;
}

export interface CheckReport {
  readonly n: number;
  readonly perCheck: readonly CheckRate[];
  /** Cost / latency / token totals for the run (the same source as `runEval`). */
  readonly usage: ArmUsage;
  /**
   * The plugin namespace the skills actually installed under — the `<plugin>`
   * half of the `<plugin>:<skill>` id a `skill()` check matches. Undefined when
   * the run installed nothing (no `pluginDir` / `skillsDir`). Reported because
   * with `skillsDir` the name is chosen by the packager, not the caller, so the
   * most common cause of a 0% `skill()` rate was a value the caller never saw.
   * Mirrors {@link TriggerRateReport.namespace}.
   */
  readonly namespace?: string;
}

/**
 * Score a check vocabulary across trials — the scored counterpart to
 * `assertChecks` (strict). Each check yields a `rate ± se` and `pass^k` over `n`
 * runs. Reuses the tested `runEvalWith` aggregation (one arm), so the loop,
 * cache, concurrency, and stats come for free. Exported with an injectable
 * `runner` so the orchestration is unit-testable without a model.
 */
export async function measureWith(
  spec: MeasureSpec,
  runner: AgentRunner,
): Promise<CheckReport> {
  assertKnownKeys(spec, MEASURE_SPEC_KEYS, {
    caller: "measure",
    type: "MeasureSpec",
  });
  if (spec.stubSkillBodies && !spec.pluginDir && !spec.skillsDir)
    throw new Error(
      "measure: `stubSkillBodies` requires `pluginDir` or `skillsDir`.",
    );
  // stubSkillBodies replaces each skill BODY with a no-op (the run stops at
  // selection), so there is no output to grade — a `judged` check would score an
  // empty body and mislead. The docs warn against this pairing; enforce it.
  if (
    spec.stubSkillBodies &&
    spec.checks.some((c) => c.toJSON().kind === "judged")
  )
    throw new Error(
      "measure: `stubSkillBodies` is for firing/`skill()` checks only — it stubs " +
        "the skill body, so there's no output for a `judged` check to grade. Drop " +
        "`stubSkillBodies`, or remove the `judged` check.",
    );
  const keyed = spec.checks.map((c, i) => [`c${String(i)}`, c] as const);
  // The install source (plugin / pluginDir / skillsDir, stubbed or not) is
  // resolved by runEvalWith, once per arm — measure is one arm, so it just
  // forwards the fields and reads the arm's report back.
  const arm: EvalArm = {
    settings: spec.settings,
    plugin: spec.plugin,
    pluginDir: spec.pluginDir,
    skillsDir: spec.skillsDir,
    interceptTools: spec.interceptTools,
  };
  const report = await runEvalWith(
    {
      fixture: spec.fixture,
      arms: { run: arm },
      stubSkillBodies: spec.stubSkillBodies,
      task: spec.task,
      trials: spec.trials ?? 5,
      model: spec.model ?? "sonnet",
      effort: spec.effort,
      allowedTools: spec.allowedTools,
      timeoutMs: spec.timeoutMs,
      spacingSec: spec.spacingSec,
      measure: (ctx) =>
        Object.fromEntries(keyed.map(([k, c]) => [k, c.eval(ctx).pass])),
    },
    runner,
  );
  return checkReportOf(report.arms.run, keyed, installNamespace(arm));
}

/** Read one arm's {@link ArmReport} back into a {@link CheckReport}. */
function checkReportOf(
  arm: ArmReport | undefined,
  keyed: readonly (readonly [string, Check<RunContext>])[],
  namespace: string | undefined,
): CheckReport {
  return {
    n: arm?.runs ?? 0,
    perCheck: keyed.map(([k, c]) => {
      const s = arm?.stats[k];
      return {
        check: c.toJSON(),
        rate: s?.mean ?? 0,
        se: s?.se ?? 0,
        passK: s?.passK ?? 0,
        n: s?.n ?? 0,
      };
    }),
    usage: arm?.usage ?? aggregateUsage([]),
    namespace,
  };
}

/* v8 ignore start -- real claude subprocess; thin wrapper over measureWith */
/** Score a check vocabulary across trials against the real `claude` CLI. */
export async function measure(spec: MeasureSpec): Promise<CheckReport> {
  const report = await measureWith(spec, spawnAgent);
  emitCostSummary(costFromArm(report.usage));
  return report;
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// measureArms — checks × A/B arms + significance. Unifies the harness-A/B moat
// (a hook/skill/CLAUDE.md ON vs OFF) with the check vocabulary: score the SAME
// checks per arm, then compare a check's rate across arms with Welch significance
// (reusing stats.ts) so a gap reads as real-or-noise, not a hand-fed delta.
// ---------------------------------------------------------------------------

/** A task scored against checks across NAMED arms (the harness variable on/off). */
export interface ArmsMeasureSpec {
  readonly fixture?: Record<string, string>;
  /** The arms to compare (settings / plugin / pluginDir per arm). */
  readonly arms: Record<string, EvalArm>;
  readonly task: string;
  readonly checks: readonly Check<RunContext>[];
  /**
   * Stub each arm's skill BODIES (frontmatter kept) before the run — the A/B
   * counterpart to {@link MeasureSpec.stubSkillBodies}. For firing comparisons
   * (does description variant A fire more than B?), every arm that sets
   * `pluginDir` / `skillsDir` is repackaged with bodies stripped so each run
   * stops at selection — a fraction of the tokens. Arms without one are left
   * untouched. Don't combine with `judged`/quality checks. See {@link stubSkillBody}.
   */
  readonly stubSkillBodies?: boolean;
  readonly trials?: number;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly timeoutMs?: number;
  /**
   * Reasoning budget for the run (`claude --effort`, e.g. `"low"` or an integer).
   * Lives here beside `model` because it is part of the MEASUREMENT — it moves the
   * output distribution, not the sample size — so it is hashed into the lock and
   * the cache, and never read from an env var. Omit for the harness default.
   */
  readonly effort?: string | number;
  readonly spacingSec?: number;
}

/** Per-arm {@link CheckReport}s — `arms[name].perCheck[i]` aligns across arms. */
export interface ArmsCheckReport {
  readonly arms: Record<string, CheckReport>;
}

/** Score checks across arms (injectable runner). Reuses `runEvalWith`. */
export async function measureArmsWith(
  spec: ArmsMeasureSpec,
  runner: AgentRunner,
): Promise<ArmsCheckReport> {
  assertKnownKeys(spec, ARMS_MEASURE_SPEC_KEYS, {
    caller: "measureArms",
    type: "ArmsMeasureSpec",
  });
  for (const [name, arm] of Object.entries(spec.arms))
    assertKnownKeys(arm, EVAL_ARM_KEYS, {
      caller: "measureArms",
      type: "EvalArm",
      arm: name,
    });
  const keyed = spec.checks.map((c, i) => [`c${String(i)}`, c] as const);
  // Per-arm install sources (and the stub) are resolved by runEvalWith.
  const report = await runEvalWith(
    {
      fixture: spec.fixture,
      arms: spec.arms,
      stubSkillBodies: spec.stubSkillBodies,
      task: spec.task,
      trials: spec.trials ?? 5,
      model: spec.model ?? "sonnet",
      effort: spec.effort,
      allowedTools: spec.allowedTools,
      timeoutMs: spec.timeoutMs,
      spacingSec: spec.spacingSec,
      measure: (ctx) =>
        Object.fromEntries(keyed.map(([k, c]) => [k, c.eval(ctx).pass])),
    },
    runner,
  );
  const arms: Record<string, CheckReport> = {};
  for (const [armName, arm] of Object.entries(report.arms)) {
    arms[armName] = checkReportOf(
      arm,
      keyed,
      installNamespace(spec.arms[armName] ?? {}),
    );
  }
  return { arms };
}

/* v8 ignore start -- real claude subprocess; thin wrapper over measureArmsWith */
/** Score checks across arms against the real `claude` CLI. */
export async function measureArms(
  spec: ArmsMeasureSpec,
): Promise<ArmsCheckReport> {
  warnUnregisteredSkillArms(spec.arms);
  const report = await measureArmsWith(spec, spawnAgent);
  // Sum every arm's spend — an A/B run pays for both arms.
  emitCostSummary(
    sumCosts(Object.values(report.arms).map((a) => costFromArm(a.usage))),
  );
  return report;
}
/* v8 ignore stop */

/**
 * Welch significance on one check's rate between two arms (`arm` vs `baseline`),
 * by index in `perCheck`. So "the gated arm resolves the skill significantly more
 * than vanilla" is a p-value, not a vibe. Reuses `welchTTest` from stats.ts.
 */
export function compareCheck(
  report: ArmsCheckReport,
  baseline: string,
  arm: string,
  checkIndex: number,
): Comparison {
  const b = report.arms[baseline]?.perCheck[checkIndex];
  const a = report.arms[arm]?.perCheck[checkIndex];
  if (!a || !b) {
    throw new Error(
      `compareCheck: unknown arm or check index (baseline="${baseline}", arm="${arm}", i=${String(checkIndex)})`,
    );
  }
  return welchTTest(
    { mean: a.rate, se: a.se, n: a.n },
    { mean: b.rate, se: b.se, n: b.n },
  );
}

/** A readable label for a check from its serialized form, e.g. `tool(Bash)`. */
function checkLabel(json: CheckJSON): string {
  const arg = json.name ?? json.id ?? json.event ?? json.path ?? json.matcher;
  if (
    typeof arg === "string" ||
    typeof arg === "number" ||
    typeof arg === "boolean"
  ) {
    return `${json.kind}(${String(arg)})`;
  }
  return json.kind;
}

/** Format a {@link CheckReport}: one line per check with its rate ± se and pass^k. */
export function formatCheckReport(report: CheckReport): string {
  const lines = [`measured ${String(report.n)} run(s):`];
  for (const c of report.perCheck) {
    lines.push(
      `  ${(c.rate * 100).toFixed(0)}% ± ${(c.se * 100).toFixed(0)}%  ${checkLabel(c.check)}` +
        `  (pass^k ${String(c.passK)})`,
    );
  }
  // The `skill()` twin of the trigger-rate TOTAL-zero note (see
  // formatTriggerRateReport): every skill() check at 0% over real runs is far
  // more often a wiring mistake — a bare id where the namespaced one is matched,
  // `pluginDir` handed a loose dir, an empty cwd — than a finding, and it reads
  // exactly like a finding. Only when EVERY skill check is at zero: a partial rate
  // is a real measurement, and a note that hedges on good data gets ignored.
  const skillChecks = report.perCheck.filter((c) => c.check.kind === "skill");
  if (
    report.n > 0 &&
    skillChecks.length > 0 &&
    skillChecks.every((c) => c.rate === 0)
  )
    lines.push(
      "⚠ nothing resolved for ANY skill() check. That is usually SETUP, not the skill — check, in order:\n" +
        (report.namespace !== undefined
          ? "  1. the id in `skill()` — your skills installed under " +
            `\`${report.namespace}\`, so \`skill()\` matches ` +
            `\`${report.namespace}:<skill>\`; a bare name silently never matches;\n`
          : "  1. the id in `skill()` — it matches the NAMESPACED id " +
            "(`<plugin>:<skill>`); a bare name silently never matches;\n") +
        "  2. the install field — a loose `.claude/skills` dir needs `skillsDir`, " +
        "not `pluginDir` (which wants a full plugin manifest);\n" +
        "  3. the `fixture` — a run starts in an EMPTY cwd, so a prompt about a " +
        "file that does not exist is one the model is right to decline.\n" +
        "  Rule out all three before recording this as a fact about the skill.",
    );
  return lines.join("\n");
}

/**
 * The min rate a check must clear: its per-KIND override in `per`, else the
 * default `min`. Shared by `assertRates` (the throwing gate) and
 * `checkReportToJUnit` (the XML report) so the two never diverge on thresholds.
 */
function checkRateThreshold(
  check: CheckJSON,
  min: number,
  per?: Readonly<Record<string, number>>,
): number {
  return per?.[check.kind] ?? min;
}

/**
 * The scored gate (Phase 4): throw if any check's measured rate is below its
 * threshold — the `measure` counterpart to `assertChecks` (strict). Reads the
 * rate, not a single run, so it never trips on one noisy trial.
 *
 * `min` is the default threshold for every check. `per` overrides it for a check
 * KIND (e.g. `{ min: 0.8, per: { skill: 1.0 } }` — "every check ≥ 80%, but the
 * skill must FIRE on every trial"), so a strict firing/safety check and a
 * lenient quality check gate in one call — the single-skill absolute oracle
 * (`measure({ checks: [skill(), judged()] }) + assertRates`) needs exactly this.
 */
export function assertRates(
  report: CheckReport,
  opts: { min: number; per?: Readonly<Record<string, number>> },
): void {
  // An empty report gates nothing — a green that tested NOTHING (the silent-pass
  // the no-silent-skips rule forbids). Fail loudly instead of vacuously passing.
  if (report.perCheck.length === 0) {
    throw new Error(
      "assertRates: the report has no checks to gate — did you call " +
        "`measure({ checks: [...] })` with an empty list? An empty gate is a silent pass.",
    );
  }
  const thresholdFor = (c: CheckRate): number =>
    checkRateThreshold(c.check, opts.min, opts.per);
  const below = report.perCheck.filter((c) => c.rate < thresholdFor(c));
  if (below.length > 0) {
    throw new Error(
      `${String(below.length)} check(s) below their min rate:\n` +
        below
          .map(
            (c) =>
              `  ✗ ${checkLabel(c.check)}: ${(c.rate * 100).toFixed(0)}% ± ${(c.se * 100).toFixed(0)}% (min ${(thresholdFor(c) * 100).toFixed(0)}%)`,
          )
          .join("\n"),
    );
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serialize a {@link CheckReport} to JUnit XML (Phase 4) — each check a
 * `<testcase>`, failing when its rate is below its threshold. `min` is the
 * default; `per` overrides it by check KIND, matching `assertRates` exactly (one
 * shared threshold helper) so the gate and the report can never disagree about
 * which checks failed. Because a check is *data*, this falls out for free: CI
 * test reporters, regression baselines, and a promptfoo bridge all consume it.
 */
export function checkReportToJUnit(
  report: CheckReport,
  opts: {
    min?: number;
    per?: Readonly<Record<string, number>>;
    name?: string;
  } = {},
): string {
  const min = opts.min ?? 0;
  const thr = (c: CheckRate): number =>
    checkRateThreshold(c.check, min, opts.per);
  const failures = report.perCheck.filter((c) => c.rate < thr(c)).length;
  const cases = report.perCheck
    .map((c) => {
      const name = escapeXml(checkLabel(c.check));
      const body =
        c.rate < thr(c)
          ? `\n    <failure message="rate ${(c.rate * 100).toFixed(0)}% below min ${(thr(c) * 100).toFixed(0)}% (n=${String(c.n)})"/>\n  `
          : "";
      return `  <testcase classname="vigiles.checks" name="${name}">${body}</testcase>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite name="${escapeXml(opts.name ?? "vigiles measure")}" tests="${String(report.perCheck.length)}" failures="${String(failures)}">\n` +
    `${cases}\n</testsuite>\n`
  );
}

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

/** Parse Claude Code's stream-json stdout into the common trace fields. */
export function parseClaudeRun(out: RunOut): ParsedModelRun {
  const result = parseResultEvent(out.stdout);
  return {
    turns: typeof result?.num_turns === "number" ? result.num_turns : 0,
    output: typeof result?.result === "string" ? result.result : "",
    toolCalls: parseToolCalls(out.stdout),
    hooks: parseHooks(out.stdout),
    subagents: parseSubagents(out.stdout),
    usage: usageFrom(result),
  };
}

function makeContext(
  cwd: string,
  out: RunOut,
  parse: ModelOutputParser = parseClaudeRun,
): RunContext {
  const p = parse(out);
  // The one place every real-model trial's trace is assembled — `runEval`,
  // `measureTriggerRate` and the selection runs all pass through here — so the
  // attribution is derived once, from what FIRED. A trigger-rate run installs
  // competing skills on purpose (`installSet`); crediting the install set would
  // credit a skill for LOSING selection. See coverage-probe.ts.
  probeTrace({ toolCalls: p.toolCalls, hooks: p.hooks });
  return {
    cwd,
    exitCode: out.code,
    stdout: out.stdout,
    turns: p.turns,
    toolCalls: p.toolCalls,
    hooks: p.hooks,
    output: p.output,
    subagents: p.subagents,
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
}

/**
 * The set of skills that RESOLVED (the `Skill` tool fired without error) in a run,
 * by their namespaced id (e.g. `superpowers:test-driven-development`). The
 * multi-skill generalization of {@link skillResolved}: where a trigger-rate run
 * asks "did skill X fire?", a SELECTION-collision run asks "which skills fired?" —
 * so a single pass over the plugin's prompts reveals whether one skill's prompt
 * wrongly activates a SIBLING (the behavioral confirmation of the deterministic
 * `description-overlap` proxy). Errored Skill calls are excluded, like
 * `skillResolved`.
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

/** Coerce a metric value to a number (booleans → 0/1), or null if absent. */
function numeric(v: number | boolean | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** Aggregate per-run metrics: mean for numbers, fraction-true (0..1) for booleans. */
export function aggregate(rows: readonly Metrics[]): Record<string, number> {
  const stats = aggregateStats(rows);
  const out: Record<string, number> = {};
  for (const [k, s] of Object.entries(stats)) out[k] = s.mean;
  return out;
}

/**
 * Aggregate per-run metrics with spread: mean, sample std, standard error, and
 * n. The se/std let you judge whether an A/B gap between arms is real or noise —
 * a difference smaller than the combined se is not yet significant.
 */
export function aggregateStats(
  rows: readonly Metrics[],
): Record<string, MetricStat> {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const out: Record<string, MetricStat> = {};
  for (const k of keys) {
    const values: number[] = [];
    for (const r of rows) {
      const v = numeric(r[k]);
      if (v !== null) values.push(v);
    }
    const n = values.length;
    const mean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : 0;
    const std =
      n > 1
        ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
        : 0;
    const passK = n > 0 && values.every((v) => v > 0) ? 1 : 0;
    out[k] = { mean, std, se: n > 0 ? std / Math.sqrt(n) : 0, n, passK };
  }
  return out;
}

/** Aggregate per-run usage into an arm's cost / latency / token totals + means. */
export function aggregateUsage(usages: readonly EvalUsage[]): ArmUsage {
  const n = usages.length;
  const sum = (f: (u: EvalUsage) => number): number =>
    usages.reduce((a, u) => a + f(u), 0);
  const totalCostUsd = sum((u) => u.costUsd);
  return {
    totalCostUsd,
    meanCostUsd: n > 0 ? totalCostUsd / n : 0,
    meanDurationMs: n > 0 ? sum((u) => u.durationMs) / n : 0,
    totalInputTokens: sum((u) => u.inputTokens),
    totalOutputTokens: sum((u) => u.outputTokens),
    totalCacheCreationTokens: sum((u) => u.cacheCreationTokens),
    totalCacheReadTokens: sum((u) => u.cacheReadTokens),
  };
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
  },
  runner: AgentRunner,
  cfg: RunConfig,
): Promise<RunOut> {
  if (cfg.cache === "off") return runner(runArgs);
  const key = cacheKey({
    task: runArgs.task,
    model: runArgs.model,
    effort: runArgs.effort,
    tools: runArgs.tools,
    files: keyParts.files,
    settings: keyParts.settings,
    env: runArgs.env,
    // A native --plugin-dir install isn't in `files`, so hash its CONTENTS into
    // the key — otherwise editing a skill in it would false-replay.
    pluginDirHash: runArgs.pluginDir ? hashDir(runArgs.pluginDir) : undefined,
    // The harness binary evolves fast; a CLI upgrade must invalidate (stale
    // replay otherwise serves a result from a different system prompt).
    harnessVersion: harnessVersion(),
    trialIndex: keyParts.trialIndex,
  });
  const hit = readCache(cfg.cacheDir, key);
  if (hit) {
    restoreDir(runArgs.cwd, hit.files);
    return hit.out;
  }
  const out = await runner(runArgs);
  if (cfg.cache === "readwrite") {
    writeCache(cfg.cacheDir, key, { out, files: snapshotDir(runArgs.cwd) });
  }
  return out;
}

/**
 * The `vigiles hook-runtime intercept-tool` command, as an absolute `node <cli> …`
 * invocation — the eval runs in a throwaway cwd where `npx vigiles` wouldn't
 * resolve, so the auto-wired PreToolUse hook must point at this CLI's own `cli.js`
 * (resolved from `__dirname`, the same way `run-hook.ts`/`sandbox.ts` locate their
 * entries).
 */
const INTERCEPT_TOOL_HOOK_CLI =
  [join(__dirname, "cli.js"), join(__dirname, "..", "dist", "cli.js")].find(
    (p) => existsSync(p),
  ) ?? join(__dirname, "cli.js");
const INTERCEPT_TOOL_HOOK_CMD = `"${process.execPath}" "${INTERCEPT_TOOL_HOOK_CLI}" hook-runtime intercept-tool`;

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
      cachedHarnessVersion = claudeCodeRuntime.versionKey(
        execSync(`${claudeCodeRuntime.agentBinary} --version`, {
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
 * The default allowlist `ephemeralRunEnv` passes through from the real
 * environment. Two groups, both load-bearing for a real-model `claude` run:
 *
 * - **Auth** — the harness's OWN credentials. The eval drives the real `claude`
 *   CLI, which authenticates via the user's subscription (`~/.claude`, reached
 *   through the fresh HOME's allowed config — see below) OR via these env vars.
 *   We mirror the auth surface the runtime port already names
 *   (`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`, see
 *   `adapters/claude-code/runtime.ts`) plus the OAuth/token + region variants the
 *   CLI accepts, so a token-authed user is not broken by a too-narrow list.
 * - **Runtime** — what any spawned process needs to *function*: `PATH` (resolve
 *   `node` / `claude`), the locale/terminal vars (`LANG` / `LC_*` / `TERM`), and
 *   `TMPDIR` (which we override to the fresh HOME). Mirrors what `bwrapArgs` /
 *   `setenvArgs` in `src/sandbox.ts` set back after `--clearenv`.
 *
 * Notably it does NOT pass through `GIT_*`, `GH_TOKEN`, `SSH_*`, `AWS_*`, or any
 * other non-allowlisted secret-shaped var — those are exactly what an ephemeral
 * run must not see. `CLAUDE_*` is allowlisted by prefix because the CLI reads
 * several `CLAUDE_*` knobs (config dir, etc.) and omitting one is the failure
 * mode this whole guard is conservative against.
 *
 * Conservative by design: a too-broad allowlist is safe (it just leaks a benign
 * var); a too-narrow one silently breaks auth — which is why the feature ships
 * default-OFF until validated against a real run.
 */
const EPHEMERAL_ALLOW: readonly string[] = [
  // Runtime essentials (mirror sandbox.ts setenv-after-clearenv).
  "PATH",
  "LANG",
  "TERM",
  // Anthropic / Claude Code auth + endpoint (mirror runtime.ts + CLI auth vars).
  claudeCodeRuntime.modelApiKeyEnv, // ANTHROPIC_API_KEY
  claudeCodeRuntime.modelBaseUrlEnv, // ANTHROPIC_BASE_URL
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Cloud-provider auth the CLI uses for Bedrock/Vertex backends (region/profile
  // only — NOT the secret-shaped AWS_* access keys, which stay dropped).
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "CLOUD_ML_REGION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

/** Prefixes passed through wholesale — the CLI reads several `CLAUDE_*` knobs and
 *  a `LC_*` locale family; allowlist by prefix so omitting one isn't the silent
 *  auth/locale break this guard exists to avoid. */
const EPHEMERAL_ALLOW_PREFIXES: readonly string[] = ["CLAUDE_", "LC_"];

/**
 * Build an **ephemeral run environment** for a model-driven run: a NEW env object
 * with a *fresh* `HOME` (and `TMPDIR`) pointed at the throwaway `opts.home`, only
 * an allowlist of auth + runtime vars passed through from `base`, and everything
 * else DROPPED. Pure — no fs, no spawn.
 *
 * The rationale is "fresh HOME + only the harness credential injected, **not** a
 * blanket wipe": running a model-driven skill/agent is itself a side effect (the
 * *model*, not the author, chose the actions), so it should not be able to read
 * the real `~/.gitconfig` / `~/.ssh` / `~/.aws` or write to the real `~`. But the
 * real `claude` CLI must still AUTHENTICATE, so the harness's own credentials
 * ({@link EPHEMERAL_ALLOW} — `ANTHROPIC_*`, `CLAUDE_*`, locale/PATH) are
 * re-injected; a blanket `--clearenv`-style wipe would break every eval. Because
 * this needs no kernel features, it is the cross-platform STATE-protection floor
 * (lands on macOS immediately), orthogonal to the Linux bubblewrap HOST
 * confinement in `src/sandbox.ts`.
 *
 * @param base  the source environment to filter (usually `process.env`).
 * @param opts.home  the throwaway dir to set as `HOME`/`TMPDIR`.
 * @param opts.allow  extra var NAMES to pass through (e.g. the `VIGILES_*` keys
 *   the eval already injects). Layered ON TOP of the default allowlist.
 */
export function ephemeralRunEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined>,
  opts: { home: string; allow?: readonly string[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  const allowExact = new Set<string>([
    ...EPHEMERAL_ALLOW,
    ...(opts.allow ?? []),
  ]);
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const allowed =
      allowExact.has(k) ||
      EPHEMERAL_ALLOW_PREFIXES.some((p) => k.startsWith(p));
    if (allowed) out[k] = v;
  }
  // Fresh HOME + TMPDIR last so they always win over anything passed through.
  out.HOME = opts.home;
  out.TMPDIR = opts.home;
  return out;
}

/**
 * Home-relative AUTH files to carry from the real HOME into the throwaway one.
 *
 * A local subscription credential (OAuth token) often lives in a FILE under HOME,
 * not an env var — so scrubbing HOME would lose it and break a local-authed run.
 * This is the file half of the auth allowlist; {@link EPHEMERAL_ALLOW} covers the
 * env-var / host-brokered half. Kept a named constant so it's easy to extend, and
 * deliberately NARROW — only the explicit auth files, never `.gitconfig` / `.ssh`
 * / `.aws`, which are exactly what an ephemeral run must not see.
 */
export const EPHEMERAL_HOME_KEEP: readonly string[] = [
  ".claude/.credentials.json", // the Claude Code OAuth token
];

/**
 * Seed the throwaway HOME with the harness's own auth FILE(s) — best-effort;
 * covers local file-based OAuth; the env-var/host-brokered path is covered by the
 * allowlist in `ephemeralRunEnv`.
 *
 * COPIES (never symlinks) each {@link EPHEMERAL_HOME_KEEP} path from `realHome`
 * into `throwawayHome`, creating parent dirs as needed; a symlink would let the
 * model-driven run write back to the real credential file, defeating ephemerality.
 * A path that doesn't exist in the real HOME is skipped silently (that user auths
 * via env-var / host broker instead). Pure fs — no env, no spawn.
 */
export function seedEphemeralHome(
  throwawayHome: string,
  realHome: string,
  keep: readonly string[] = EPHEMERAL_HOME_KEEP,
): void {
  for (const rel of keep) {
    const src = join(realHome, rel);
    if (!existsSync(src)) continue; // env-var / host-brokered auth covers this.
    const dest = join(throwawayHome, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest); // copy, not symlink — keep the real credential read-only.
  }
}

/** Execute one trial in a fresh sandbox; returns its metric row + usage. */
async function executeTrial<M extends Metrics>(
  spec: EvalSpec<M>,
  arm: EvalArm,
  trialIndex: number,
  runner: AgentRunner,
  cfg: RunConfig,
): Promise<{ row: M; usage: EvalUsage }> {
  const cwd = makeTmpDir("eval");
  try {
    const resolved = resolveHarness({
      plugin: arm.plugin,
      settings: arm.settings,
      files: { ...spec.fixture, ...arm.files },
    });
    const { files } = resolved;
    const intercepts = arm.interceptTools ?? [];
    const settings = withInterceptToolHook(resolved.settings, intercepts);
    // The eval-injected overlay (VIGILES_INTERCEPT_TOOLS), if any.
    const overlay =
      intercepts.length > 0
        ? { [INTERCEPT_TOOLS_ENV]: serializeIntercepts(intercepts) }
        : undefined;
    // Opt-in (default OFF): an ephemeral run env — a throwaway HOME under the
    // trial's own temp cwd + a scrubbed, auth-only allowlist. The eval's injected
    // keys (e.g. VIGILES_INTERCEPT_TOOLS) are allowlisted through so interception
    // still works. When OFF, `env`/`replaceEnv` are exactly as before.
    // Tool stubs on PATH (rung R2): write the fake binaries into a bin dir under
    // this trial's cwd; it is PREPENDED to whatever PATH the run uses below, so
    // the fakes win over the real binaries. Absent → no PATH change.
    const stubs = spec.stubs ?? [];
    const stubDir =
      stubs.length > 0
        ? stubBinDir(stubs, join(cwd, ".vigiles-stubs"))
        : undefined;
    const prependPath = (path: string | undefined): string =>
      stubDir === undefined
        ? (path ?? "")
        : path === undefined || path === ""
          ? stubDir
          : `${stubDir}${delimiter}${path}`;
    const ephemeral = spec.ephemeralEnv === true;
    let env: Record<string, string> | undefined;
    let replaceEnv = false;
    if (ephemeral) {
      const home = mkdtempSync(join(cwd, "home-"));
      // Carry the harness's own auth FILE (local OAuth) into the fresh HOME —
      // env-var/host-brokered auth is covered by ephemeralRunEnv's allowlist.
      seedEphemeralHome(home, process.env.HOME ?? homedir());
      env = ephemeralRunEnv(process.env, {
        home,
        allow: overlay ? Object.keys(overlay) : [],
      });
      if (overlay) Object.assign(env, overlay);
      // ephemeralRunEnv passes PATH through; prepend the stub dir over it.
      if (stubDir !== undefined) env.PATH = prependPath(env.PATH);
      replaceEnv = true;
    } else {
      // Legacy overlay path: `spawnAgent` spreads `{ ...process.env, ...env }`, so
      // set PATH in the overlay to the stub dir prepended over process.env.PATH.
      env =
        stubDir !== undefined
          ? { ...overlay, PATH: prependPath(process.env.PATH) }
          : overlay;
    }
    writeFiles(cwd, files);
    const hasSettings = settings !== undefined;
    if (hasSettings) {
      writeFileSync(
        join(cwd, "settings.json"),
        JSON.stringify(settings, null, 2).replaceAll("{cwd}", cwd),
      );
    }
    const out = await runWithCache(
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
        env,
        replaceEnv,
      },
      { files, settings, trialIndex },
      runner,
      cfg,
    );
    const ctx = makeContext(cwd, out);
    return { row: spec.measure(ctx), usage: ctx.usage };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

/** Call `runner`, retrying with exponential backoff while it looks rate-limited. */
async function runWithRetry(
  runArgs: AgentRunArgs,
  runner: AgentRunner,
  retries: number,
  baseMs: number,
): Promise<RunOut> {
  for (let attempt = 0; ; attempt++) {
    const out = await runner(runArgs);
    if (!isRateLimited(out) || attempt >= retries) return out;
    await sleep(baseMs * 2 ** attempt);
  }
}

/** Map `worker` over `items` with at most `concurrency` in flight, order preserved. */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const drain = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      results[i] = await worker(item);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workers }, drain));
  return results;
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
    const rows = done.map((d) => d.row);
    const usage = aggregateUsage(done.map((d) => d.usage));
    totalCostUsd += usage.totalCostUsd;
    arms[armName] = {
      runs: rows.length,
      metrics: aggregate(rows),
      stats: aggregateStats(rows),
      usage,
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
 * excluded by design (the script re-asserts against the replayed report).
 */
function evalArmsInputs<M extends Metrics>(
  spec: EvalSpec<M>,
  cfg: RunConfig,
): unknown {
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
  // Tool stubs (`spec.stubs`) are written onto PATH before each trial, so a
  // change to a canned CLI output IS a model-facing input change — fold a
  // canonical (name-sorted) view into the hash so `--check` catches it. Sorted
  // for a stable key regardless of declaration order; an empty list is the
  // byte-identical-to-before default. Each ToolStub is plain serializable data.
  const stubs = [...(spec.stubs ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  // `ephemeralEnv` swaps the trial's environment (scrubbed env + throwaway HOME
  // vs the inherited process env), which can move tool/hook/agent behavior — a
  // model-facing input, so it belongs in the hash. Normalize to a bool so a
  // record under one mode can't be replayed under the other with the same hash.
  return {
    task: spec.task,
    arms,
    stubs,
    ephemeralEnv: spec.ephemeralEnv === true,
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
  ephemeralEnv: true,
  stubs: true,
  lock: true,
} satisfies Record<keyof EvalSpec<Metrics>, true>;

const MEASURE_SPEC_KEYS = {
  fixture: true,
  settings: true,
  plugin: true,
  pluginDir: true,
  skillsDir: true,
  stubSkillBodies: true,
  interceptTools: true,
  task: true,
  checks: true,
  trials: true,
  model: true,
  effort: true,
  allowedTools: true,
  timeoutMs: true,
  spacingSec: true,
} satisfies Record<keyof MeasureSpec, true>;

const ARMS_MEASURE_SPEC_KEYS = {
  fixture: true,
  arms: true,
  task: true,
  checks: true,
  stubSkillBodies: true,
  trials: true,
  model: true,
  allowedTools: true,
  timeoutMs: true,
  effort: true,
  spacingSec: true,
} satisfies Record<keyof ArmsMeasureSpec, true>;

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
 * The closest declared field to an unknown one, or undefined when nothing is
 * close — a wrong suggestion is worse than none (it invites "fixing" a field the
 * author never meant). Same tight threshold as the CLI's unknown-flag hint.
 */
function nearestField(
  unknown: string,
  known: readonly string[],
): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of known) {
    const d = editDistance(unknown.toLowerCase(), name.toLowerCase());
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= Math.max(2, Math.floor(unknown.length / 4))
    ? best.name
    : undefined;
}

/**
 * Throw when `spec` carries a field outside `known` — every unknown one named,
 * with a did-you-mean where a declared field is one typo away. `at` says which
 * runner and spec type the message is about (`arm` labels a nested arm). Runs
 * before anything is packaged or spent.
 */
function assertKnownKeys(
  spec: object,
  known: Record<string, true>,
  at: { readonly caller: string; readonly type: string; readonly arm?: string },
): void {
  const declared = Object.keys(known);
  const where = at.arm === undefined ? "" : ` on arm "${at.arm}"`;
  const problems = Object.keys(spec)
    .filter((key) => !Object.hasOwn(known, key))
    .map((key) => {
      const near = nearestField(key, declared);
      const hint = near === undefined ? "" : ` — did you mean \`${near}\`?`;
      return `${at.caller}: unknown ${at.type} field "${key}"${where}${hint}`;
    });
  if (problems.length === 0) return;
  throw new Error(
    `${problems.join("\n")}\n  ${at.type} fields: ${declared.join(", ")}.\n` +
      "  An unknown field is refused rather than ignored: a dropped field would " +
      "make the run measure a setup you did not ask for.",
  );
}

export async function runEvalWith<M extends Metrics>(
  input: EvalSpec<M>,
  runner: AgentRunner,
): Promise<EvalReport> {
  // Refuse a stray field BEFORE spending a token: an eval file is plain JS, so a
  // typo'd or misplaced key would otherwise vanish and the run would report a
  // confident number about the wrong setup (issue #307).
  assertKnownKeys(input, EVAL_SPEC_KEYS, {
    caller: "runEval",
    type: "EvalSpec",
  });
  for (const [name, arm] of Object.entries(input.arms))
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
  // one place that decides what `--plugin-dir` receives, so measure / measureArms
  // / runEval cannot disagree about it. The throwaways are removed afterward.
  const { arms: resolvedArms, packaged } = resolveArmInstalls(
    input.arms,
    input.stubSkillBodies ?? false,
  );
  const spec: EvalSpec<M> = { ...input, arms: resolvedArms };
  try {
    return await runResolvedEval(spec, runner);
  } finally {
    for (const dir of packaged) rmSync(dir, { recursive: true, force: true });
  }
}

/** {@link runEvalWith} after its arms' install sources are concrete plugin dirs. */
async function runResolvedEval<M extends Metrics>(
  spec: EvalSpec<M>,
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
  const retrying: AgentRunner = (a) =>
    runWithRetry(a, runner, retries, backoffMs);

  const units = buildUnits(spec.arms, trials);
  let spent = 0;
  let aborted = false;
  const worker = async (unit: Unit): Promise<UnitResult<M>> => {
    if (aborted) return { armName: unit.armName, skipped: true };
    const { row, usage } = await executeTrial(
      spec,
      unit.arm,
      unit.trialIndex,
      retrying,
      cfg,
    );
    spent += usage.costUsd;
    if (spec.maxCostUsd !== undefined && spent >= spec.maxCostUsd) {
      aborted = true;
    }
    if (spacing > 0) await sleep(spacing);
    return { armName: unit.armName, skipped: false, row, usage };
  };

  const lock = resolveLock(spec.lock);
  // Resolve the lock inputs only when the lock is active (off skips the
  // resolveHarness/hashDir work). `check` replays the committed report below
  // without ever entering the run pool — so no model is driven in CI.
  const inputs = lock.mode === "off" ? undefined : evalArmsInputs(spec, cfg);
  return withEvalLock(
    { name: spec.name, inputs, model: cfg.model, effort: cfg.effort, lock },
    async () => {
      const results = await runPool(units, concurrency, worker);
      const { arms, totalCostUsd } = aggregateArms<M>(
        Object.keys(spec.arms),
        results,
      );
      return { name: spec.name ?? "eval", trials, arms, totalCostUsd, aborted };
    },
  );
}

/** Render one metric: `name=mean±se pass^k=…` (se/pass^k shown when measured). */
function formatMetric(
  name: string,
  mean: number,
  stat: MetricStat | undefined,
): string {
  const base =
    stat && stat.se > 0
      ? `${name}=${mean.toFixed(2)}±${stat.se.toFixed(2)}`
      : `${name}=${mean.toFixed(2)}`;
  return stat && stat.n > 0 ? `${base} pass^k=${String(stat.passK)}` : base;
}

/** Compact tokens like `3.4k`; whole numbers under 1000 stay as-is. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A `($0.0123 · 1.2s/run · 3.4k tok)` suffix, or "" when no usage was reported. */
function formatUsage(u: ArmUsage): string {
  if (u.totalCostUsd === 0 && u.totalInputTokens + u.totalOutputTokens === 0) {
    return "";
  }
  const tok = fmtTokens(u.totalInputTokens + u.totalOutputTokens);
  return `  ($${u.totalCostUsd.toFixed(4)} · ${(u.meanDurationMs / 1000).toFixed(1)}s/run · ${tok} tok)`;
}

/** Format an eval report as a compact table for the console (mean ± se, pass^k). */
export function formatEvalReport(report: EvalReport): string {
  const header =
    report.totalCostUsd > 0
      ? `${report.name} (${String(report.trials)} trials/arm) — $${report.totalCostUsd.toFixed(4)} total`
      : `${report.name} (${String(report.trials)} trials/arm)`;
  const lines = [header];
  for (const [arm, r] of Object.entries(report.arms)) {
    const parts = Object.entries(r.metrics)
      .map(([k, v]) => formatMetric(k, v, r.stats[k]))
      .join("  ");
    lines.push(`  ${arm.padEnd(10)} ${parts}${formatUsage(r.usage)}`);
  }
  return lines.join("\n");
}

// --- trigger-rate: does a skill/behaviour actually FIRE across varied prompts ---

/**
 * Measure how reliably a skill/behaviour *triggers*. A skill's value is its
 * description firing on the right task — the #1 documented skill-authoring pain —
 * and that's a property of the real model, not the wiring (which the
 * deterministic tier already proves). Install the plugin natively (`pluginDir`),
 * give a set of varied `prompts`, and a `fired` predicate over the run's `Trace`
 * (reuse the bare predicates, e.g. `(t) => skillResolved(t, "x:y")`).
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
  /** Did the behaviour fire on this run? e.g. `(t) => skillResolved(t, "x:y")`. */
  readonly fired: (trace: Trace) => boolean;
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
  /** Tools the agent may use. Default: Read Edit Write Bash Skill. */
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
   * `MeasureSpec.fixture`. See `research/plugin-behavioral-findings.md`.
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

/** Per-prompt trigger result: how many of its trials fired. */
export interface PromptTriggerStat {
  readonly prompt: string;
  readonly fired: number;
  readonly trials: number;
  /** `fired / trials` (0 when no trials). */
  readonly rate: number;
}

export interface TriggerRateReport {
  /** Overall fraction of relevant runs in which the behaviour fired (recall, 0..1). */
  readonly rate: number;
  /** Total relevant runs (prompts × trials). */
  readonly n: number;
  readonly perPrompt: readonly PromptTriggerStat[];
  /**
   * Fraction of *irrelevant* runs that wrongly fired (lower is better). Present
   * only when {@link TriggerRateSpec.irrelevantPrompts} was given.
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
   * Competitor skills co-installed via {@link TriggerRateSpec.installSet}. `0`
   * (the default) means the skill was measured **ISOLATED** — so `rate` is an
   * UPPER bound on real recall and `falsePositiveRate` a LOWER bound, because
   * selection is competitive (a populated harness can evict or out-compete the
   * description). A non-zero count is the whole-harness measurement.
   */
  readonly competitors: number;
  /**
   * The plugin namespace the skills actually installed under — the `<plugin>`
   * half of the `<plugin>:<skill>` id `skillResolved` matches.
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
   * basis (copied from {@link EvalDriver.experimental}) — the number is not
   * validated and can be wrong. `formatTriggerRateReport` prints it as a loud
   * caveat. Absent = a supported, trustworthy measurement (Claude Code).
   */
  readonly experimental?: string;
}

/**
 * The default (Claude Code) eval driver: real `claude` + stream-json parsing.
 *
 * This lives at the COMPOSITION ROOT (`src/eval.ts`) on purpose, not in
 * `src/adapters/claude-code/` — it is NOT a boundary leak. Claude Code is the
 * wired DEFAULT (`measureTriggerRate`/`runEval` fall back to it), so `eval.ts`
 * must reference it directly; wiring the default is precisely a composition
 * root's job. `codexEvalDriver` lives in its adapter dir instead because Codex
 * is caller-INJECTED (never a default), so `eval.ts` never imports it. Relocating
 * this into the adapter would make `eval.ts → adapters/claude-code → eval.ts` a
 * circular import (the shared `EvalDriver`/`ModelOutputParser` types live here).
 * The asymmetry reflects default-vs-injected, not a hexagonal violation.
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

/**
 * Rewrite a SKILL.md to keep its YAML frontmatter (the trigger surface — name +
 * description) but replace the body with a no-op stub. Trigger-rate is a property
 * of the frontmatter ONLY: the model picks a skill from its name + description
 * before the body is ever loaded, so the body is causally downstream of selection
 * and irrelevant to whether the skill fires. Stubbing it lets a trigger run stop
 * AT selection instead of executing an expensive multi-step procedure — cheaper,
 * faster, and side-effect-free, without changing what's measured. Pure.
 */
export function stubSkillBody(skillMd: string): string {
  const m = /^(---\n[\s\S]*?\n---\n)/.exec(skillMd);
  const frontmatter = m ? m[1] : "";
  return `${frontmatter}\nThis skill was selected (trigger-test stub). Acknowledge and stop — do not perform any actions.\n`;
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

// ---------------------------------------------------------------------------
// Prompt-set diversity (deterministic, pre-eval) — a trigger rate is only
// meaningful over ENOUGH and DIFFERENT prompts. Catch a too-small or
// near-duplicate set before spending a single model token. We measure
// "different" with Normalized Compression Distance (gzip) — the SAME engine
// `findSimilarRules` uses for near-duplicate rule detection — not edit
// distance: NCD scores shared structure/redundancy (a templated prompt with one
// word swapped compresses together), which is exactly the lazy-copy-paste set
// we want to reject, and it's the project's house algorithm for "are these two
// texts basically the same".
// ---------------------------------------------------------------------------

/** Normalize for comparison: lowercase, trim, collapse whitespace. */
function normalizePrompt(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Distance between two prompts in ~0..1 (0 = identical, higher = more
 * different) via Normalized Compression Distance over the normalized text.
 * Reuses {@link ncd} from the proof engine.
 */
export function promptDistance(a: string, b: string): number {
  return ncd(normalizePrompt(a), normalizePrompt(b));
}

export interface PromptDiversityIssue {
  readonly kind: "too-few" | "too-similar";
  readonly message: string;
}

/**
 * Deterministically check a prompt set is big and varied enough to measure a
 * trigger rate: at least `minPrompts` entries, and no two closer than
 * `minDistance` in NCD. Pure — no model. `label` names the set in messages.
 */
export function checkPromptDiversity(
  prompts: readonly string[],
  opts: { minPrompts?: number; minDistance?: number; label?: string } = {},
): PromptDiversityIssue[] {
  const minPrompts = opts.minPrompts ?? 10;
  const minDistance = opts.minDistance ?? 0.3;
  const label = opts.label ?? "prompts";
  const issues: PromptDiversityIssue[] = [];
  if (prompts.length < minPrompts) {
    issues.push({
      kind: "too-few",
      message: `${label}: ${String(prompts.length)} prompt(s), need at least ${String(minPrompts)} to measure a rate (set minPrompts to override).`,
    });
  }
  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      const dist = promptDistance(prompts[i], prompts[j]);
      if (dist < minDistance) {
        issues.push({
          kind: "too-similar",
          message: `${label}: prompts #${String(i + 1)} and #${String(j + 1)} are near-duplicates (NCD ${dist.toFixed(2)} < ${String(minDistance)}) — vary the phrasing:\n    - ${prompts[i]}\n    - ${prompts[j]}`,
        });
      }
    }
  }
  return issues;
}

/** Throw if a prompt set isn't big/varied enough. See {@link checkPromptDiversity}. */
export function assertPromptDiversity(
  prompts: readonly string[],
  opts: { minPrompts?: number; minDistance?: number; label?: string } = {},
): void {
  const issues = checkPromptDiversity(prompts, opts);
  if (issues.length > 0) {
    throw new Error(
      `Prompt set is not eval-ready:\n  ${issues.map((i) => i.message).join("\n  ")}`,
    );
  }
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
// Every runner that installs skills (runEval / measure / measureArms via an
// EvalArm, measureTriggerRate via its spec) accepts the same two fields —
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
 * the `<plugin>:<skill>` id `skill()` / `skillResolved` match. A loose dir gets
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
    fired: spec.fired,
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
 * second harness — e.g. `measureTriggerRate(spec, { evalDriver: codexEvalDriver })`
 * from `vigiles/codex` (the eval-tier analog of `runHarnessTest`'s `{ adapter }`).
 * Requires that harness's binary + auth.
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

/** Format a trigger-rate report: overall %, then each prompt's rate. */
export function formatTriggerRateReport(report: TriggerRateReport): string {
  const pct = (report.rate * 100).toFixed(0);
  const lines: string[] = [];
  if (report.experimental) {
    lines.push(`⚠ EXPERIMENTAL — ${report.experimental}`);
  }
  lines.push(`trigger-rate: ${pct}% (${String(report.n)} runs)`);
  for (const p of report.perPrompt) {
    lines.push(`  ${p.rate.toFixed(2)}  ${p.prompt.slice(0, 60)}`);
  }
  if (report.falsePositiveRate !== undefined) {
    const fpr = (report.falsePositiveRate * 100).toFixed(0);
    const prec =
      report.precision === undefined
        ? "n/a"
        : `${(report.precision * 100).toFixed(0)}%`;
    lines.push(`false-positive: ${fpr}%  precision: ${prec}`);
    for (const p of report.perIrrelevant ?? []) {
      lines.push(
        `  ${p.rate.toFixed(2)}  [irrelevant] ${p.prompt.slice(0, 48)}`,
      );
    }
  }
  // Honest labelling: an isolated run measures the skill alone, with no competing
  // skills to evict or out-compete its description — so recall is an UPPER bound
  // and false-positive a LOWER bound. Say so, or point at the whole-harness count.
  lines.push(
    report.competitors > 0
      ? `whole-harness: measured against ${String(report.competitors)} competing skill(s)`
      : "isolated: no competing skills — recall is an upper bound, false-positive a lower bound (populate `installSet` for a release-gate measurement)",
  );
  // A TOTAL zero is far more often a wiring mistake than a finding, and it does
  // not look like one: the report is well-formed, the runs executed, and every
  // line reads 0.00 — which parses as "this description never fires". Measured
  // the hard way while building a consumer's trigger suite (2026-08-11): three
  // separate setup errors each produced a confident, plausible 0%, and two of
  // them were briefly written up as findings about the skills before being
  // caught. So when nothing fired at all, say what usually causes that.
  //
  // Deliberately only on the TOTAL zero. A partial rate is a real measurement and
  // must not be second-guessed; a checker that hedges on good data gets ignored.
  if (report.n > 0 && report.rate === 0)
    lines.push(
      "⚠ nothing fired on ANY prompt. That is usually SETUP, not the description — check, in order:\n" +
        // The runtime RESOLVED the namespace before spending a token, so it
        // prints the id that should have matched instead of telling the reader
        // to go work it out. With `skillsDir` the name is not even the user's
        // choice — the packager picks it — so "check the id" was advice about a
        // value they had never seen.
        (report.namespace !== undefined
          ? "  1. the id in `fired` — your skills installed under " +
            `\`${report.namespace}\`, so \`skillResolved\` matches ` +
            `\`${report.namespace}:<skill>\`; a bare name silently never matches;\n`
          : "  1. the id in `fired` — `skillResolved` matches the NAMESPACED id " +
            "(`<plugin>:<skill>`); a bare name silently never matches;\n") +
        "  2. the install field — a loose `.claude/skills` dir needs `skillsDir`, " +
        "not `pluginDir` (which wants a full plugin manifest);\n" +
        "  3. the `fixture` — a run starts in an EMPTY cwd, so a prompt about a " +
        "file that does not exist is one the model is right to decline.\n" +
        "  Rule out all three before recording this as a fact about the skill.",
    );
  return lines.join("\n");
}
