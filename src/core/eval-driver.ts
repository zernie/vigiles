/**
 * The EXECUTING tiers' shared shapes — the eval-tier transport (`EvalDriver`
 * and the runner/parser types it is built from) and the unified run record
 * (`Trace`) both tiers produce.
 *
 * WHY THEY LIVE IN CORE, exactly as `harness-driver.ts` says of the mock tier's
 * trace shapes: a core PORT has to be able to reference them, and the core may
 * not import `src/eval.ts` or `src/harness-test.ts` (those are composition-root
 * runners that wire the Claude Code defaults, and `boundaries/dependencies`
 * classifies everything they reach). `HarnessLiveDriver` (`./live-driver.js`)
 * is the port that needed them; before it existed the types could sit beside
 * their runners, and nothing forced the split.
 *
 * NOTHING MOVED BUT THE TYPES. `claudeEvalDriver`, `spawnAgent`,
 * `parseClaudeRun`, `parseToolCalls`, `parseHooks` and `parseSubagents` stay in
 * their runners — they are the wired Claude Code DEFAULT, and wiring the default
 * is a composition root's job (`eval.ts:2336-2348` argues this at length). Both
 * runners re-export these names, so every existing import keeps resolving.
 */
import type { ToolCall, HookFire, ModelRequest } from "./harness-driver.js";

/** Per-run resource use, parsed from the terminal `result` event (0 when absent). */
export interface EvalUsage {
  /** `total_cost_usd` reported by the harness binary. */
  readonly costUsd: number;
  /** Wall-clock `duration_ms` of the run. */
  readonly durationMs: number;
  /** Fresh (uncached) input tokens, billed at full input price. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens written to the prompt cache this run (~1.25× input price). */
  readonly cacheCreationTokens: number;
  /** Tokens served from the prompt cache this run (~0.1× input price). */
  readonly cacheReadTokens: number;
}

/** A sub-agent (`Task`) run as a nested trace: its name + the tools it used. */
export interface SubagentTrace {
  /** The `subagent_type` from the `Task` tool input. */
  readonly name: string;
  /** The tools the subagent invoked (events tagged with the Task's id). */
  readonly toolCalls: readonly ToolCall[];
  /**
   * The subagent's RETURNED text — the dispatch tool_result the orchestrator
   * receives back. This is where a `result()` contract's `vigiles:ok`/`vigiles:err`
   * block lands, so `subagent(name, [output(/vigiles:ok/)])` can assert the typed
   * outcome. "" if not captured.
   */
  readonly output: string;
}

/**
 * The observable record of ONE run — the unified shape produced by BOTH testing
 * tiers: `runHarnessTest`'s result and `runEval`'s `measure` ctx (`eval.ts`)
 * both satisfy it. That's what lets the bare predicates in `harness-assert.ts`
 * (`usedTool` / `skillResolved` / `toolCount` / `toolUsedWith` / `hookFired` /
 * `outputContains`) run over either, with the testing helpers asserting and eval
 * measuring over the same vocabulary.
 */
export interface Trace {
  /**
   * The tools the agent invoked, each paired with its result — parsed from the
   * transcript. Empty unless the run captured the stream (`transcript: true` on
   * the harness tier; always on the eval tier). Lets a test assert on the
   * agent's *actions* (skills, MCP tools, subagents) instead of grepping stdout.
   */
  readonly toolCalls: readonly ToolCall[];
  /**
   * The hooks that fired during the run, each with its decision — parsed from
   * the CLI's `hook_response` stream events. Same capture requirement as
   * `toolCalls` (empty without the stream). Lets a test assert hook firing
   * honestly instead of via a marker file.
   */
  readonly hooks: readonly HookFire[];
  /** The agent's final answer text (the terminal `result` event), or "". */
  readonly output: string;
  /**
   * The requests the model received, captured by the scripted mock — each with
   * its `system` prompt and `messages`, flattened to text. Lets a test assert
   * what actually reached the model (a SessionStart hook's injected context, a
   * slash command's expansion), not just that a hook fired. **Harness tier
   * only**: the mock sees the requests, so this is populated by `runHarnessTest`
   * (with or without `transcript`); the eval tier drives the real API, so its
   * `modelRequests` is always empty.
   */
  readonly modelRequests: readonly ModelRequest[];
  /** Number of model turns. */
  readonly turns: number;
  /**
   * Sub-agent (`Task`) runs as nested traces, keyed by `subagent_type`. A
   * subagent runs its own session; CC tags its events with `parent_tool_use_id`
   * (= the `Task` tool call) so its tool calls are recovered into a sub-trace
   * here, lettng a test assert what the subagent DID (not just that `Task` fired).
   * Empty unless the stream was captured / the harness emits subagent events.
   */
  readonly subagents?: readonly SubagentTrace[];
  /** Final contents of a file under the working dir, or null if absent. */
  file(path: string): string | null;
}

/** The raw output of one trial: the agent's exit code + captured streams. */
export interface RunOut {
  code: number;
  stdout: string;
  /** Captured stderr, when the runner provides it (used for rate-limit detection). */
  stderr?: string;
}

/** The per-trial arguments handed to an {@link AgentRunner}. */
export interface AgentRunArgs {
  readonly task: string;
  readonly cwd: string;
  readonly model: string;
  /**
   * Reasoning-budget level for the run (`claude --effort`). Part of the
   * MEASUREMENT, not a run knob: it changes the model's output distribution, not
   * the sample size — so it lives on the spec next to `model` (never an env),
   * and it is hashed into both the cache key and the eval lock. Deliberately
   * `string | number` rather than a literal union: the binary accepts an alias
   * map, is case-insensitive, and takes an integer budget, and its own valid set
   * MOVED between builds (2.1.42 had no `xhigh`, 2.1.257 does) — a hard-coded
   * union would reject a valid level after any upstream addition. A wrong value
   * is caught at RUNTIME instead, by `effortRejection`, which is what the
   * binary actually tells us. Omit for the harness default.
   */
  readonly effort?: string | number;
  readonly tools: readonly string[];
  readonly hasSettings: boolean;
  readonly pluginDir: string | undefined;
  readonly timeoutMs: number;
  /** Extra env layered over `process.env` for this run (e.g. `VIGILES_INTERCEPT_TOOLS`). */
  readonly env?: Record<string, string>;
  /**
   * When true, `env` is the COMPLETE spawn environment (an ephemeral run env from
   * `ephemeralRunEnv`) — the runner does NOT prepend `process.env`, so the
   * real `$HOME` / secrets are scrubbed. Default false: `env` is an overlay over
   * `process.env` (the byte-identical-to-today path). Set only by `ephemeralEnv`.
   */
  readonly replaceEnv?: boolean;
}

/**
 * Runs one trial and returns its raw output. The default (`spawnAgent`)
 * drives the real `claude` CLI; `runEvalWith` takes one explicitly, so the eval
 * orchestration is testable without a model (pass a fake returning canned
 * stream-json) and a custom runtime can be plugged in.
 */
export type AgentRunner = (args: AgentRunArgs) => Promise<RunOut>;

/**
 * The harness-specific half of a run trace: how a real model's raw stdout maps
 * to the common fields. Claude Code's `parseClaudeRun` reads its stream-json; a
 * second harness (Codex) supplies its own parser of `codex exec --json` JSONL, so
 * the eval tier (`measureTriggerRate`/`runEval`) isn't bound to Claude's format.
 * The non-harness fields (cwd/exitCode/stdout/file/sh) stay in `makeContext`.
 */
export interface ParsedModelRun {
  readonly turns: number;
  readonly output: string;
  readonly toolCalls: ToolCall[];
  readonly hooks: HookFire[];
  readonly subagents: SubagentTrace[];
  readonly usage: EvalUsage;
}
export type ModelOutputParser = (out: RunOut) => ParsedModelRun;

/**
 * An eval-tier transport: how to RUN a real harness turn and PARSE its output.
 * The default is Claude Code (`claudeEvalDriver`); a second harness supplies its
 * own (e.g. `codexEvalDriver` from `vigiles/codex`) and passes it as
 * `measureTriggerRate(spec, { evalDriver })` — the eval-tier analog of
 * `runHarnessTest`'s `{ adapter }`. `runError` lets the loop drop an
 * errored/rate-limited turn instead of scoring it as a miss.
 */
export interface EvalDriver {
  readonly runner: AgentRunner;
  readonly parse: ModelOutputParser;
  readonly runError?: (out: RunOut) => string | null;
  /**
   * The harness this driver runs (e.g. the adapter's `name`). Folded into a
   * trigger-rate eval's LOCK hash so a report recorded on one harness is marked
   * STALE if the eval is later switched to another (a different harness can fire a
   * skill differently). Optional for back-compat — absent defaults to the
   * default harness, so an existing single-harness lock is unaffected.
   */
  readonly harness?: string;
  /**
   * When set, this driver's trigger-rate number is EXPERIMENTAL and not
   * validated — the string is the human caveat explaining why (e.g. Codex has no
   * skill-selection event, so firing is inferred from a SKILL.md read, which can
   * be wrong in both directions). Absent = supported/trustworthy (the default).
   * `measureTriggerRate` copies it onto the report and warns; the formatter
   * prints it. Precision-first: never let a possibly-wrong number read as a
   * measurement.
   *
   * The same fact as `HarnessLiveDriver.firing` (`./live-driver.js`), which is
   * the typed form the measurement tiers branch on; `adapter-contract.test.ts`
   * asserts the two agree on every adapter.
   */
  readonly experimental?: string;
}
