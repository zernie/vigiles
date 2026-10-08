/**
 * HarnessTestDriver — the seam that makes the pillar-2 deterministic runner
 * (`runHarnessTest`) adapter-driven instead of hard-wired to Claude Code.
 *
 * Each harness (Claude Code, Codex, …) brings a driver that knows how to: build
 * the non-interactive argv for its binary, start its scripted mock model, and
 * parse its stdout into the unified `Trace` fields. The runner stays
 * harness-agnostic — it spawns `driver.runtime.agentBinary`, points it at the
 * mock via `driver.runtime.wireMock(url)`, and assembles the result through
 * `driver.parseRun`. A `HarnessAdapter` carries its driver as
 * `harnessTestDriver`, so the runner never imports a sibling adapter.
 *
 * The shared trace shapes (`ModelTurn`/`ModelRequest`/`ToolCall`/`HookFire`)
 * live here in core so BOTH the adapters and the runner can reference them
 * without a cross-adapter import. `vigiles/claude-code` re-exports
 * `ModelTurn`/`ModelRequest` for back-compat.
 */
import type { HarnessRuntime } from "./runtime.js";

/**
 * One scripted assistant turn: a final text answer, or a tool call. The common
 * shape both harness mocks consume — the Anthropic Messages mock
 * (`src/mock-model.ts`) and the OpenAI Responses mock
 * (`src/adapters/codex/mock-model.ts`, which uses only `text`).
 */
export interface ModelTurn {
  /** Final text answer (stops the turn). */
  readonly text?: string;
  /** A tool to invoke, e.g. "Bash" | "Write" | "Edit". */
  readonly tool?: string;
  /** The tool input, e.g. `{ file_path, content }` or `{ command }`. */
  readonly input?: Record<string, unknown>;
}

/**
 * One model request the scripted mock received, flattened to text for
 * assertions — the seam that lets a harness test prove what reached the model
 * (a SessionStart hook's injected context, a slash command's expansion), not
 * just that a hook fired.
 */
export interface ModelRequest {
  /** The system prompt, flattened to text (string or text-block array). */
  readonly system: string;
  /** The conversation messages, each flattened to `{ role, text }`. */
  readonly messages: readonly {
    readonly role: string;
    readonly text: string;
  }[];
  /**
   * `true` when the agent CLI made this call for its OWN bookkeeping rather than
   * to advance the agent loop — a SIDE-CHANNEL call.
   *
   * MEASURED on Claude Code 2.1.228: a `post_turn_summary` classifier (it decides
   * whether to push the user a phone notification) runs on every turn, on the
   * user's own credential, and it declares NO tools. The mock does not let such a
   * request consume a script entry — see `isMainLoopRequest` in `mock-model.ts`.
   */
  readonly sideChannel?: boolean;
}

/** A tool the agent invoked, paired with its result (transcript mode only). */
export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
  /** The tool_result text ("" if none / not captured). */
  readonly resultText: string;
  /** Whether the tool_result came back flagged as an error. */
  readonly isError: boolean;
}

/**
 * A hook invocation observed during the run, recorded (not inferred) from the
 * harness's stream events — so a test can assert which hook fired and whether
 * it blocked.
 */
export interface HookFire {
  /** The hook label, e.g. `"PreToolUse:Edit"` (`Event:Matcher`). */
  readonly name: string;
  /** The hook event, e.g. `"PreToolUse"`, `"PostToolUse"`, `"Stop"`. */
  readonly event: string;
  /** The hook process exit code (2 = block), or undefined if not reported. */
  readonly exitCode: number | undefined;
  /** Whether the hook blocked / errored (exit ≠ 0 or outcome "error"). */
  readonly blocked: boolean;
  /** What the hook printed (its block reason / diagnostic), or "". */
  readonly output: string;
}

/** A running scripted mock model: the URL to point the binary at + the record. */
export interface HarnessMockHandle {
  /** Base URL the spawned binary is pointed at. */
  readonly url: string;
  /** Every request the mock received, flattened for assertions, in order. */
  readonly requests: readonly ModelRequest[];
  /**
   * Number of SCRIPT turns served so far — i.e. main-loop requests. A
   * side-channel request ({@link ModelRequest.sideChannel}) is answered without
   * touching the script and is NOT counted here, so this stays the agent's turn
   * count rather than the CLI's HTTP-call count.
   */
  readonly count: number;
  /** Side-channel requests answered so far (never script-consuming). */
  readonly sideChannelCount?: number;
  /** Stop the mock server. */
  close(): void | Promise<void>;
}

/** The facts a driver needs to build the non-interactive argv for one run. */
export interface HarnessDriverContext {
  /** The user prompt. */
  readonly prompt: string;
  /** The temp working dir the binary runs in. */
  readonly cwd: string;
  /** Whether a settings file was written (CC: pass `--settings`). */
  readonly hasSettings: boolean;
  /**
   * Which tools EXIST in the session, when the spec lists them (CC: `--tools`);
   * undefined = every tool exists. A driver whose harness has no such concept
   * (Codex) throws on one rather than ignore it.
   */
  readonly tools?: readonly string[];
  /**
   * Which tools are PRE-APPROVED (CC: `--allowedTools`); undefined = the
   * default four. It never removes a tool. A driver with no such concept
   * ignores it.
   */
  readonly allowedTools?: readonly string[];
  /** Capture the full event transcript instead of just the final result. */
  readonly transcript: boolean;
  /** Path to a plugin dir to install natively, if any. */
  readonly pluginDir?: string;
  /**
   * The mock-wiring args from `runtime.wireMock(url).args` — the flags that
   * point the binary at the mock model. The DRIVER inserts them at the correct
   * argv position (for Codex they MUST follow `exec`; for env-only harnesses
   * like Claude Code this is empty). Passed in (not prepended by the runner)
   * because only the driver knows its argv structure.
   */
  readonly mockArgs: readonly string[];
}

/** A harness's stdout parsed into the unified `Trace` fields. */
export interface ParsedRun {
  /** Number of model turns, if the stdout reports it (else taken from the mock). */
  readonly turns?: number;
  readonly toolCalls: readonly ToolCall[];
  readonly hooks: readonly HookFire[];
  /** The agent's final answer text, or "". */
  readonly output: string;
  /** Every reply the agent ended a turn with; absent when the output is not a stream. */
  readonly replies?: readonly string[];
}

/**
 * What a harness brings so `runHarnessTest` can drive it. Implemented in each
 * adapter (`claudeCodeDriver`, `codexDriver`) and carried on the
 * `HarnessAdapter` as `harnessTestDriver`.
 */
export interface HarnessTestDriver {
  /** The transport (binary to spawn + how to reach the mock via `wireMock`). */
  readonly runtime: HarnessRuntime;
  /** The non-interactive argv for one run. Pure, so it's unit-tested. */
  buildArgs(ctx: HarnessDriverContext): readonly string[];
  /** Start this harness's scripted mock for the given turn script. */
  startMock(script: readonly ModelTurn[]): Promise<HarnessMockHandle>;
  /** Parse the harness's stdout into the unified trace fields. */
  parseRun(stdout: string): ParsedRun;
  /** Whether the agent binary is available on PATH. */
  available(): boolean;
}
