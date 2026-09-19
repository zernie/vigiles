/**
 * vigiles — deterministic Claude Code harness testing.
 *
 * Test what your *harness* does — hooks, settings, skills, instruction files —
 * without paying for or depending on a real model. `runHarnessTest` spins up the
 * real `claude` CLI (so your real hooks and settings fire exactly as in
 * production) but points it at a scripted mock model (`src/mock-model.ts`), so
 * the agent's turns are fixed and the outcome is reproducible. No API key, no
 * cost, CI-friendly.
 *
 *   const r = await runHarnessTest({
 *     settings: { hooks: { Stop: [{ hooks: [{ type: "command",
 *       command: "test -f DONE || { echo 'not done' >&2; exit 2; }" }] }] } },
 *     model: scriptModel([
 *       { text: "I'm done" },                              // tries to stop → blocked
 *       { tool: "Bash", input: { command: "touch DONE" } },
 *       { text: "now done" },
 *     ]),
 *   });
 *   assert(JSON.parse(r.stdout).num_turns > 1);            // the Stop hook fired
 *
 * The "steps" are the scripted model turns — their real home is deterministic
 * harness testing, not production enforcement.
 *
 * Note: the mock drives Bash and Stop hooks, and — verified on claude 2.1.169 —
 * the Edit/Write tools too (allowlisted past the permission prompt), so their
 * PreToolUse/PostToolUse hooks fire in this tier. The events the mock can't
 * trigger (PreCompact / Notification / SessionEnd / SubagentStop) belong to the
 * `runHook` unit tier.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";

import type { HarnessAdapter } from "./core/adapter.js";
import type {
  HarnessTestDriver,
  HarnessDriverContext,
  HarnessMockHandle,
  ToolCall,
  HookFire,
  ParsedRun,
  ModelTurn,
  ModelRequest,
} from "./core/harness-driver.js";
import { assertHarnessTestable } from "./adapter-conformance.js";
import { recordCheck } from "./check-count.js";
import { probeTrace } from "./coverage-probe.js";

import { claudeCodeRuntime } from "./adapters/claude-code/runtime.js";

import {
  startMock,
  scriptUnconsumedWarning,
  splitRequestCounts,
} from "./mock-model.js";
import { resolveHarness } from "./adapters/claude-code/plugin-loader.js";
import {
  decideSandbox,
  specTrusted,
  sandboxAvailable,
  runSandboxed,
  type SandboxMode,
} from "./sandbox.js";

export { scriptModel } from "./mock-model.js";
export type {
  ModelTurn,
  ModelRequest,
  ToolCall,
  HookFire,
  HarnessTestDriver,
} from "./core/harness-driver.js";
export {
  loadPlugin,
  resolveHarness,
} from "./adapters/claude-code/plugin-loader.js";
export {
  decideSandbox,
  specTrusted,
  sandboxAvailable,
  type SandboxMode,
} from "./sandbox.js";
import { makeTmpDir } from "./core/tmp-root.js";

export interface HarnessTestSpec {
  /** Fixture files to write in a fresh temp working dir (path → contents). */
  readonly files?: Record<string, string>;
  /** `.claude/settings.json` contents — the hooks/permissions under test. */
  readonly settings?: unknown;
  /**
   * Path to a real plugin/repo whose harness (hooks + CLAUDE.md + skills) is
   * loaded into the sandbox, so you test the assembled machine, not a retyped
   * subset. Inline `settings`/`files` layer on top. See src/plugin-loader.ts.
   */
  readonly plugin?: string;
  /**
   * Path to a plugin dir to install NATIVELY via `claude --plugin-dir`, so its
   * skills / commands / agents / hooks register and ACTIVATE the real way — a
   * scripted `Skill` tool_use resolves, and the real model can trigger them.
   * Unlike `plugin` (which materializes a file subset that does NOT register
   * skills for the `Skill` tool), this is the real install path, so point it at a
   * COMPLETE plugin (internal references resolve). Inline `settings`/`files` and
   * `plugin` still layer on top. Resolved to an absolute path.
   */
  readonly pluginDir?: string;
  // TODO(R2): wire `stubs?: readonly ToolStub[]` here too — write the fake
  // binaries into a bin dir under the temp cwd and PREPEND it to the spawned
  // agent's PATH. Deferred from the eval tier because the harness-test spawn goes
  // through the per-harness `HarnessTestDriver` seam (buildArgs/startMock/wireMock,
  // env built per-driver as `{ ...process.env, ...wired.env }`), so threading a
  // PATH overlay cleanly means touching that port — out of scope for the MVP,
  // which lands the helper on the eval tier. See `src/tool-stub.ts`.
  /** The scripted model turns the agent will take. */
  readonly model: readonly ModelTurn[];
  /** The user prompt. Default: "go". */
  readonly prompt?: string;
  /** Tools the agent may use. Default: Read Edit Write Bash. */
  readonly allowedTools?: readonly string[];
  /**
   * Capture the full event transcript (`--output-format stream-json`) into
   * `stdout`, instead of just the final result object, so you can assert on what
   * the agent's tools returned — e.g. the body a `Skill` tool_use resolved. With
   * this on, `stdout` is newline-delimited JSON events, not a single object.
   */
  readonly transcript?: boolean;
  /** Per-run wall-clock timeout in ms. Default 60000. */
  readonly timeoutMs?: number;
  /**
   * Confinement policy for the code this run executes (`src/sandbox.ts`).
   * Default `"auto"` is safe-by-default: an inline-only spec (you authored it)
   * runs directly, but an external `plugin` / `pluginDir` brings in untrusted
   * third-party hooks and is run under bubblewrap — or, if no sandbox is
   * available, the run REFUSES rather than executing unconfined. Pass `false` to
   * opt out and run unconfined (you audited the code, or trust the outer
   * container); `"strict"` to force confinement even for trusted code.
   *
   * NOTE: confined execution is **Linux only** (bubblewrap is a Linux tool). On
   * macOS / Windows no sandbox is available, so an untrusted run will REFUSE
   * under `"auto"`/`"strict"` — use `sandbox: false` there if you trust the code.
   */
  readonly sandbox?: SandboxMode;
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

export interface HarnessTestResult extends Trace {
  readonly exitCode: number;
  readonly stdout: string;
  /** Hook block messages and diagnostics land here. */
  readonly stderr: string;
  /** The temp working dir (inspect or clean it up). */
  readonly cwd: string;
  /** Number of model turns the agent took (mock turns served). */
  readonly turns: number;
  /** Remove the temp working dir. */
  cleanup(): void;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      const t = (b as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    })
    .join("");
}

/**
 * Parse `--output-format stream-json` (the `transcript: true` output) into the
 * tools the agent invoked, each joined to its result by id. Returns [] for the
 * non-stream `json` output. The seam that lets a test assert on the agent's
 * actions, not a brittle stdout substring.
 */
export function parseToolCalls(streamJson: string): ToolCall[] {
  const uses: { id: string; name: string; input: unknown }[] = [];
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const line of streamJson.split("\n")) {
    if (!line.trim()) continue;
    let evt: { message?: { content?: unknown } };
    try {
      evt = JSON.parse(line) as { message?: { content?: unknown } };
    } catch {
      continue;
    }
    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use" && typeof b.name === "string") {
        const id = typeof b.id === "string" ? b.id : "";
        uses.push({ id, name: b.name, input: b.input });
      } else if (b.type === "tool_result") {
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
        results.set(id, {
          text: contentText(b.content),
          isError: b.is_error === true,
        });
      }
    }
  }
  return uses.map((u) => ({
    name: u.name,
    input: u.input,
    resultText: results.get(u.id)?.text ?? "",
    isError: results.get(u.id)?.isError ?? false,
  }));
}

/**
 * Recover sub-agent runs as nested traces. A subagent-dispatch tool call (the
 * `Agent` tool on the live CLI — older docs say `Task` — carrying an
 * `input.subagent_type`) spawns a subagent whose own events the CLI tags with a
 * top-level `parent_tool_use_id` = the dispatch tool-use id. We group those
 * tagged tool calls under their dispatch, keyed by `subagent_type`. **Schema
 * verified against real claude output** (`parent_tool_use_id` sibling of
 * `message`, `subagent_type` in the dispatch input; tool named `Agent`) — the
 * same `message.content` line shape `parseToolCalls` consumes, and we match the
 * input field NOT the tool name so a future rename can't break it. Pure; empty
 * for a harness that doesn't emit `parent_tool_use_id` (e.g. Codex).
 */
export function parseSubagents(streamJson: string): SubagentTrace[] {
  const tasks = new Map<string, string>(); // dispatch id → subagent name
  const dispatchOutput = new Map<string, string>(); // dispatch id → returned text
  const byParent = new Map<
    string,
    {
      uses: { id: string; name: string; input: unknown }[];
      results: Map<string, { text: string; isError: boolean }>;
    }
  >();
  const groupFor = (
    parent: string,
  ): {
    uses: { id: string; name: string; input: unknown }[];
    results: Map<string, { text: string; isError: boolean }>;
  } => {
    let g = byParent.get(parent);
    if (!g) {
      g = { uses: [], results: new Map() };
      byParent.set(parent, g);
    }
    return g;
  };

  for (const line of streamJson.split("\n")) {
    if (!line.trim()) continue;
    let evt: { message?: { content?: unknown }; parent_tool_use_id?: unknown };
    try {
      evt = JSON.parse(line) as typeof evt;
    } catch {
      continue;
    }
    const content = evt.message?.content;
    if (!Array.isArray(content)) continue;
    const parent =
      typeof evt.parent_tool_use_id === "string"
        ? evt.parent_tool_use_id
        : undefined;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use" && typeof b.name === "string") {
        const id = typeof b.id === "string" ? b.id : "";
        if (!parent) {
          // A subagent dispatch is any top-level tool_use whose input carries a
          // `subagent_type` — the dispatch tool is named "Agent" on the live CLI
          // (older docs say "Task"), so match the input field, NOT the tool name,
          // to survive the rename. Confirmed against real claude output. CC NOTE:
          // under `--plugin-dir` the value is NAMESPACED `plugin:agent` (captured
          // "reviewer-spec:code-reviewer"); the bare agent name is matched in the
          // `subagent()` check (src/check.ts), so the full id is preserved here.
          const sub = (b.input as { subagent_type?: string })?.subagent_type;
          if (typeof sub === "string") tasks.set(id, sub);
        }
        if (parent)
          groupFor(parent).uses.push({ id, name: b.name, input: b.input });
      } else if (b.type === "tool_result") {
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
        if (parent) {
          groupFor(parent).results.set(id, {
            text: contentText(b.content),
            isError: b.is_error === true,
          });
        } else if (id) {
          // A top-level tool_result whose id is a subagent dispatch is the SUB's
          // RETURN to the orchestrator (where a result() vigiles:ok/err block
          // lands). Record it; matched to its dispatch by id below.
          dispatchOutput.set(id, contentText(b.content));
        }
      }
    }
  }

  const out: SubagentTrace[] = [];
  for (const [taskId, name] of tasks) {
    const g = byParent.get(taskId);
    const toolCalls = (g?.uses ?? []).map((u) => ({
      name: u.name,
      input: u.input,
      resultText: g?.results.get(u.id)?.text ?? "",
      isError: g?.results.get(u.id)?.isError ?? false,
    }));
    out.push({ name, toolCalls, output: dispatchOutput.get(taskId) ?? "" });
  }
  return out;
}

/**
 * The terminal `result` event — present in BOTH `--output-format` shapes (a
 * `{type:"result", …}` line in stream-json, the single object in `json`), or
 * null. The seam for the final answer + turn count without parsing twice.
 */
export function parseResultEvent(
  stdout: string,
): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type === "result") return evt;
  }
  return null;
}

/** The agent's final answer text from a transcript / result object, or "". */
export function parseOutput(stdout: string): string {
  const result = parseResultEvent(stdout)?.result;
  return typeof result === "string" ? result : "";
}

/**
 * The hooks that fired, recorded from the CLI's `hook_response` stream events
 * (`--output-format stream-json`). Each carries the hook name/event, its exit
 * code, and whether it blocked — the honest record vs. inferring from marker
 * files. Returns [] for the non-stream `json` output (no per-hook events).
 */
function toHookFire(evt: Record<string, unknown>): HookFire {
  const exitCode =
    typeof evt.exit_code === "number" ? evt.exit_code : undefined;
  return {
    name: typeof evt.hook_name === "string" ? evt.hook_name : "",
    event: typeof evt.hook_event === "string" ? evt.hook_event : "",
    exitCode,
    blocked:
      evt.outcome === "error" || (exitCode !== undefined && exitCode !== 0),
    output: typeof evt.output === "string" ? evt.output : "",
  };
}

export function parseHooks(stdout: string): HookFire[] {
  const hooks: HookFire[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type === "system" && evt.subtype === "hook_response") {
      hooks.push(toHookFire(evt));
    }
  }
  return hooks;
}

/**
 * The `claude` CLI argv for a harness run (shared by the direct and sandboxed
 * paths). `ANTHROPIC_BASE_URL` is set by the caller's environment / wrapper, not
 * here. Pure, so the arg shape is unit-tested.
 */
export function buildClaudeArgs(
  spec: HarnessTestSpec,
  hasSettings: boolean,
): string[] {
  const tools = spec.allowedTools ?? ["Read", "Edit", "Write", "Bash"];
  return [
    "-p",
    spec.prompt ?? "go",
    ...(spec.transcript
      ? ["--output-format", "stream-json", "--verbose"]
      : ["--output-format", "json"]),
    "--model",
    "claude-sonnet-4-5",
    ...(spec.pluginDir !== undefined
      ? ["--plugin-dir", resolve(spec.pluginDir)]
      : []),
    ...(hasSettings ? ["--settings", "settings.json"] : []),
    "--allowedTools",
    ...tools,
  ];
}

/** Build the `claude` argv from the driver context — wraps `buildClaudeArgs`. */
function buildClaudeArgsFromCtx(ctx: HarnessDriverContext): string[] {
  return buildClaudeArgs(
    {
      model: [],
      prompt: ctx.prompt,
      transcript: ctx.transcript,
      pluginDir: ctx.pluginDir,
      allowedTools: ctx.tools,
    },
    ctx.hasSettings,
  );
}

/** Parse the `claude` stdout/stream into the unified trace fields. */
export function parseClaudeRun(stdout: string): ParsedRun {
  return {
    toolCalls: parseToolCalls(stdout),
    hooks: parseHooks(stdout),
    output: parseOutput(stdout),
  };
}

/* v8 ignore start -- spawns the real claude CLI + filesystem; exercised by the
   claude-backed suite, excluded from the deterministic coverage gate (the parse
   helpers above carry the testable logic). */
/** Whether the agent CLI is available — harness tests need it. */
export function claudeAvailable(): boolean {
  try {
    return (
      // vigiles:free-tier — `--version` asks the binary to print and exit; it
      // never reaches a model backend, so it spends nothing.
      spawnSync(claudeCodeRuntime.agentBinary, ["--version"], {
        stdio: "ignore",
      }).status === 0
    );
  } catch {
    return false;
  }
}

function writeFixture(
  cwd: string,
  files: Record<string, string>,
  settings: unknown,
): void {
  for (const [p, content] of Object.entries(files)) {
    const full = resolve(cwd, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (settings !== undefined) {
    // `{cwd}` in any hook command is substituted with the working dir, so a
    // hook can reference an absolute path inside it (hooks don't run with the
    // project dir as cwd).
    const json = JSON.stringify(settings, null, 2).replaceAll("{cwd}", cwd);
    writeFileSync(join(cwd, "settings.json"), json);
  }
}

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the agent binary against the mock. The mock-wiring *args* are already in
 * `args` (the driver placed `wireMock(url).args` at the correct argv position
 * via `ctx.mockArgs`); here we only layer `wireMock(url).env` over the caller's
 * env. Driver-agnostic at the transport seam.
 */
function spawnAgent(
  runtime: HarnessTestDriver["runtime"],
  args: readonly string[],
  cwd: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<RunOut> {
  const wired = runtime.wireMock(baseUrl);
  return new Promise((resolvePromise) => {
    // vigiles:free-tier — the deterministic harness tier. `runtime.wireMock`
    // points the binary at the LOCAL scripted mock (base-URL env + dummy key),
    // so no real model is reached and nothing is billed. That is the whole
    // reason this tier is free and runs on every push.
    const child = spawn(runtime.agentBinary, [...args], {
      cwd,
      // Any key works — the mock ignores auth. wireMock supplies the overlay
      // env (base-URL var + dummy key for CC; the dummy key for Codex); layer it
      // over the caller's env.
      env: { ...process.env, ...wired.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * The Claude Code `HarnessTestDriver`: the existing argv/mock/parse seams bundled
 * behind the port the adapter-driven runner dispatches through. Behaviourally
 * identical to the previous hard-wired path.
 */
export const claudeCodeDriver: HarnessTestDriver = {
  runtime: claudeCodeRuntime,
  buildArgs: buildClaudeArgsFromCtx,
  startMock: (script): Promise<HarnessMockHandle> => startMock(script),
  parseRun: parseClaudeRun,
  available: claudeAvailable,
};
/* v8 ignore stop */

/** Options for {@link runHarnessTest}. */
export interface RunHarnessTestOptions {
  /**
   * Which harness to drive. Defaults to Claude Code. Pass `codexAdapter`
   * (`vigiles/codex`) to drive real `codex exec` against its Responses mock.
   * The adapter must support pillar 2 (`capabilities.harnessTesting`) and carry
   * a `harnessTestDriver`.
   */
  readonly adapter?: HarnessAdapter;
}

/* v8 ignore start -- spawns the real agent CLI + filesystem; exercised by the
   claude-backed + gated codex suites, excluded from the deterministic coverage
   gate (the parse helpers above carry the testable logic). */
function makeResult(
  cwd: string,
  out: { code: number; stdout: string; stderr?: string },
  parsed: ParsedRun,
  turns: number,
  modelRequests: readonly ModelRequest[],
): HarnessTestResult {
  // WHAT this run exercised, read off the transcript rather than the fixture: a
  // harness test installs a whole plugin, and what was INSTALLED is a set while
  // what RAN is one thing. See coverage-probe.ts.
  probeTrace({ toolCalls: parsed.toolCalls, hooks: parsed.hooks });
  return {
    exitCode: out.code,
    stdout: out.stdout,
    stderr: out.stderr ?? "",
    cwd,
    turns,
    toolCalls: parsed.toolCalls,
    hooks: parsed.hooks,
    output: parsed.output,
    modelRequests,
    subagents: parseSubagents(out.stdout),
    file: (p: string): string | null => {
      const f = resolve(cwd, p);
      return existsSync(f) ? readFileSync(f, "utf-8") : null;
    },
    cleanup: (): void => {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/**
 * Run the real agent CLI against a scripted mock model, with the given fixture
 * and settings (hooks). Deterministic — same script, same result. Adapter-driven
 * (`opts.adapter`, default Claude Code): the Claude Code path is unchanged
 * (incl. the safe-by-default sandbox); pass `codexAdapter` to drive real codex.
 *
 * Safe by default (Claude Code): an external `plugin` / `pluginDir` brings in
 * untrusted third-party hooks and is confined under bubblewrap (`spec.sandbox`,
 * default `"auto"`); if no sandbox is available the run REFUSES rather than
 * executing unconfined. See `src/sandbox.ts`. The sandbox path is Claude Code
 * only — requesting confinement for another harness throws.
 */
export async function runHarnessTest(
  spec: HarnessTestSpec,
  opts: RunHarnessTestOptions = {},
): Promise<HarnessTestResult> {
  // Tell the CLI runner this script exercised the harness, so a file that runs
  // NOTHING can be told apart from one that ran and passed. See check-count.ts.
  recordCheck();
  const adapter = opts.adapter;
  // Default (no adapter): the unchanged Claude Code driver — keeps the
  // sandbox/confined path and behaviour byte-for-byte identical.
  const driver: HarnessTestDriver = adapter
    ? await requireDriver(adapter)
    : claudeCodeDriver;
  const isClaudeCode = driver.runtime.name === claudeCodeRuntime.name;

  const decision = decideSandbox({
    trusted: specTrusted(spec),
    mode: spec.sandbox ?? "auto",
    available: sandboxAvailable(),
  });
  if (decision.action === "throw") throw new Error(decision.reason);
  if (decision.action === "sandbox" && !isClaudeCode) {
    throw new Error(
      `sandbox not supported for ${driver.runtime.name}: confined execution is Claude Code only. Pass sandbox: false to run ${driver.runtime.name} unconfined (you audited the code, or trust the outer container).`,
    );
  }

  const cwd = makeTmpDir("harness");
  const { files, settings } = resolveHarness({
    plugin: spec.plugin,
    settings: spec.settings,
    files: spec.files,
  });
  writeFixture(cwd, files, settings);
  const tools = spec.allowedTools ?? ["Read", "Edit", "Write", "Bash"];
  const timeoutMs = spec.timeoutMs ?? 60000;
  const buildArgs = (mockArgs: readonly string[]): readonly string[] =>
    driver.buildArgs({
      prompt: spec.prompt ?? "go",
      cwd,
      hasSettings: settings !== undefined,
      tools,
      transcript: spec.transcript ?? false,
      pluginDir: spec.pluginDir,
      mockArgs,
    });

  // Confined path (Claude Code only): the mock is co-launched in the netns, so
  // the agent reaches it over the loopback URL the sandbox sets — Claude Code is
  // env-only (empty mockArgs), so the argv needs no mock-wiring flags.
  if (decision.action === "sandbox") {
    const out = await runSandboxed({
      cwd,
      claudeArgs: [...buildArgs([])],
      script: spec.model,
      timeoutMs,
    });
    // `turns` is the AGENT's turns on both paths. In-process the handle counts
    // them (`mock.count`); here only the tagged request log crosses the process
    // boundary, so the same split is recovered from the tags — otherwise every
    // side-channel call the CLI makes inflates the sandboxed run's count while
    // the direct one stays right. Same recovery feeds the unconsumed-script
    // warning, which the sandbox path could not emit at all before.
    const { count, sideChannelCount } = splitRequestCounts(out.requests);
    const unconsumed = scriptUnconsumedWarning(count, sideChannelCount);
    if (unconsumed !== undefined) console.error(unconsumed);
    return makeResult(
      cwd,
      out,
      parseClaudeRun(out.stdout),
      count,
      out.requests,
    );
  }

  // Direct path: mock runs in this process; the agent reaches it over localhost.
  // Start the mock first so its URL feeds the driver's mock-wiring args.
  const mock = await driver.startMock(spec.model);
  try {
    const args = buildArgs(driver.runtime.wireMock(mock.url).args);
    const out = await spawnAgent(
      driver.runtime,
      args,
      cwd,
      mock.url,
      timeoutMs,
    );
    // A script that was never consumed is otherwise invisible — the run just
    // looks empty. `scriptUnconsumedWarning` names the one shape that produces
    // it (every request arriving without tool declarations, so nothing looked
    // like an agent turn) instead of leaving it to be rediscovered.
    const unconsumed = scriptUnconsumedWarning(
      mock.count,
      mock.sideChannelCount ?? 0,
    );
    if (unconsumed !== undefined) console.error(unconsumed);
    return makeResult(cwd, out, driver.parseRun(out.stdout), mock.count, [
      ...mock.requests,
    ]);
  } finally {
    await mock.close();
  }
}

/**
 * `runHarness` — the harness-scope entry of the revamped API (Phase 2 of
 * `research/testing-api-design.md`). The harness has two execution scopes, `hook`
 * (`runHook`) and `harness` (the whole assembled agent); today's `integration` /
 * `e2e` / `eval` are all the **harness** scope under realness flags. This entry is
 * the **deterministic** harness run (`model: "mock"`, the default) — the
 * workhorse you gate every commit, with no key. A **real-model** harness run is
 * non-deterministic by definition, so you don't *assert* a single one — you
 * `measure()` it across trials (the eval scope). `egress` is a capability of this
 * scope (the e2e tier), not a separate tier.
 *
 * Behaviour is identical to `runHarnessTest` (which it wraps); the new name +
 * `model` flag make the scope/realness explicit and steer real-model runs to the
 * right tool.
 */
export async function runHarness(
  spec: HarnessTestSpec,
  opts: RunHarnessTestOptions & { model?: "mock" | "real" } = {},
): Promise<HarnessTestResult> {
  if (opts.model === "real") {
    throw new Error(
      "runHarness runs the harness DETERMINISTICALLY (model: 'mock'). A real-model " +
        "harness run is non-deterministic, so a single one can't be asserted — " +
        "measure it across trials with `measure()` / `runEval` (the eval scope) instead.",
    );
  }
  return runHarnessTest(spec, opts);
}

/** Pull the pillar-2 driver off an adapter, asserting it supports testing. */
async function requireDriver(
  adapter: HarnessAdapter,
): Promise<HarnessTestDriver> {
  assertHarnessTestable(adapter);
  if (!adapter.harnessTestDriver) {
    throw new Error(
      `Adapter "${adapter.name}" declares harnessTesting but carries no harnessTestDriver — it cannot drive runHarnessTest.`,
    );
  }
  return await adapter.harnessTestDriver();
}
/* v8 ignore stop */
