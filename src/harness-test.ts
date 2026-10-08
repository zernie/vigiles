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
  mkdtempSync,
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
import type { Trace, SubagentTrace } from "./core/eval-driver.js";
// `Trace`/`SubagentTrace` moved to `core/eval-driver.ts` so a core PORT
// (`HarnessLiveDriver.firedFor`) can take a trace — the core may not import
// this module. Re-exported here unchanged.
export type { Trace, SubagentTrace } from "./core/eval-driver.js";
import { assertHarnessTestable } from "./adapter-conformance.js";
import { recordCheck } from "./check-count.js";
import { overrunMessageFor } from "./core/script-overrun.js";
import { probeTrace } from "./coverage-probe.js";

import { claudeCodeRuntime } from "./adapters/claude-code/runtime.js";

import {
  startMock,
  scriptUnconsumedWarning,
  splitRequestCounts,
} from "./mock-model.js";
import { parseReplies, reachedModel } from "./adapters/claude-code/replies.js";

/** Re-exported for the eval tier's parser, which reads the same stream. */
export { parseReplies, reachedModel };
import { defaultAdapter } from "./adapter-registry.js";
import { planStyleRun, styleReached } from "./core/output-style.js";
import type { HarnessRuntime } from "./core/runtime.js";
import { scrubbedRunEnv, withoutSessionIdentity } from "./core/run-env.js";
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
import {
  loadPlugin,
  resolveHarness,
} from "./adapters/claude-code/plugin-loader.js";
export { loadPlugin, resolveHarness };
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
  /**
   * Path to an OUTPUT STYLE file to switch on for this run. The style is
   * written where the harness keeps styles, and selected by the name the
   * harness reads from the file — never by a name you type, because a setting
   * that misses the name loads no style and raises no error.
   *
   * The run is then checked: if no model request carried the style,
   * `runHarnessTest` THROWS instead of returning a trace, so a style that never
   * loaded cannot pass a test. Refused up front on a harness without output
   * styles, or when the fixture's files or settings already decide.
   *
   * What it proves is delivery. A scripted model does not read the style, so
   * nothing in this tier shows that a model FOLLOWS it.
   */
  readonly outputStyle?: string;
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
  /**
   * The ONLY tools the agent has, when you list them: a tool left out is not
   * offered (`claude --tools`, Claude Code 2.0.31+), `[]` is refused, and a
   * scripted call to a tool the list leaves out throws before the run starts.
   * Omitted, nothing is withheld: every tool is offered and Read, Edit, Write and
   * Bash are pre-approved. Each listed tool is also pre-approved
   * (`--allowedTools`), so it does not stop on a permission prompt; a permission
   * rule such as `Bash(git *)` keeps its specifier for the approval and is
   * offered as plain `Bash`. An MCP tool is not a built-in: left out, it is still
   * offered but not approved, so a call to it is refused for permission rather
   * than as "No such tool".
   */
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
 * The first `claude` that has `--tools` (print mode). Found by diffing the
 * published `@anthropic-ai/claude-code` tarballs: 2.0.30 has no such option,
 * 2.0.31 does (the changelog does not list it; its 2.1.0 entry only extends the
 * flag to interactive mode).
 */
const TOOLS_FLAG_MIN_CLAUDE = "2.0.31";

/**
 * The names `--tools` should offer for an `allowedTools` list. `--allowedTools`
 * takes permission rules (`Bash(git *)`); `--tools` takes tool NAMES, and a rule
 * with a specifier there makes the CLI offer no tools at all. So the specifier is
 * dropped (`Bash(git *)` → `Bash`) and repeats collapse. Pure.
 */
export function toolAvailabilityList(
  allowed: readonly string[],
): readonly string[] {
  const names = allowed.map((rule) => rule.replace(/\(.*$/, "").trim());
  return [...new Set(names.filter((n) => n !== ""))];
}

/**
 * A scripted call to a tool an EXPLICIT `allowedTools` does not offer. The CLI
 * answers it with "No such tool available" and the run goes on, so a test that
 * scripts the call and then asserts on something else passes over a step that
 * never happened. Returns the message to throw, or undefined. MCP tools are not
 * built-ins, so `--tools` does not withhold them and they are skipped. Pure.
 */
export function unofferedScriptedTool(
  model: readonly ModelTurn[],
  allowed: readonly string[] | undefined,
): string | undefined {
  if (allowed === undefined) return undefined;
  const offered = toolAvailabilityList(allowed);
  const at = model.findIndex(
    (t) =>
      t.tool !== undefined &&
      !t.tool.startsWith("mcp__") &&
      !offered.includes(t.tool),
  );
  return at < 0
    ? undefined
    : `scripted call to "${model[at]?.tool ?? ""}" on turn ${String(at + 1)}, but this run offers only: ${offered.join(", ")} — add it to allowedTools`;
}

/**
 * A run on a `claude` that predates `--tools` exits at argument parsing, and
 * commander's "unknown option" says nothing about WHY vigiles passed it. Returns
 * the message to throw, or undefined when the run did not die that way. Pure.
 */
export function unsupportedToolsFlag(stderr: string): string | undefined {
  return /unknown option '--tools'/.test(stderr)
    ? `this \`claude\` does not know \`--tools\`, which runHarnessTest uses to withhold every tool not in \`allowedTools\` (#252). Update Claude Code to ${TOOLS_FLAG_MIN_CLAUDE} or newer. Running without it would hand the agent every tool while the test reads as if it were fenced.`
    : undefined;
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
    // An EXPLICIT list restricts: `--tools` is the AVAILABILITY list, a tool left
    // out is not offered at all. `--allowedTools` only PRE-APPROVES (it never
    // restricts), so on its own it left every unnamed tool runnable (#252). An
    // empty list is `--tools ""` = no tools. With no list, nothing is withheld:
    // the default four are pre-approved and every other tool stays available.
    ...(spec.allowedTools === undefined
      ? []
      : ["--tools", toolAvailabilityList(spec.allowedTools).join(",")]),
    // Pre-approval for the offered tools, so none stops on a permission prompt
    // (headless). An empty one approves nothing, so the flag is left out (a bare
    // `--allowedTools` exits before any model turn).
    ...(tools.length === 0 ? [] : ["--allowedTools", ...tools]),
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
    replies: parseReplies(stdout),
  };
}

/**
 * Where a harness-tier run's agent gets HOME and the rest of its environment.
 *
 * - `inherit` — the caller's env (real HOME), minus the harness's declared
 *   session identity. The default of `runHarnessTest`: a test that reads the
 *   machine's config keeps doing so, but no run executes AS the caller's live
 *   session.
 * - `throwaway` — a fresh HOME/TMPDIR at `dir`, the OS essentials, and nothing
 *   else from the caller: no harness auth (the scripted mock needs none, and a
 *   config-dir variable would point the run back at the real config), no
 *   identity, no secrets. The same scrubbed shape as the eval tier's
 *   `ephemeralEnv` (`scrubbedRunEnv`), without the auth.
 */
export type HarnessRunHome =
  | { readonly home: "inherit" }
  | { readonly home: "throwaway"; readonly dir: string };

/**
 * The spawn env of one harness-tier run: {@link HarnessRunHome} applied to
 * `base`, with the runtime's mock wiring on top. Pure — the testable seam of
 * the un-coverable spawn.
 */
export function harnessSpawnEnv(
  runtime: HarnessRuntime,
  wiredEnv: Readonly<Record<string, string>>,
  home: HarnessRunHome,
  base: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  switch (home.home) {
    case "inherit":
      return { ...withoutSessionIdentity(base, runtime.runEnv), ...wiredEnv };
    case "throwaway":
      return { ...scrubbedRunEnv(base, { home: home.dir }), ...wiredEnv };
  }
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
  files: Readonly<Record<string, string>>,
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

/**
 * The {@link HarnessRunHome} for a run in `cwd`. A throwaway HOME lives under
 * the run's own temp dir, as the eval tier's does, so `cleanup()` removes it
 * with everything else.
 */
function runHomeIn(cwd: string, home: HarnessRunHome["home"]): HarnessRunHome {
  return home === "throwaway"
    ? { home, dir: mkdtempSync(join(cwd, "home-")) }
    : { home };
}

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the agent binary against the mock. The mock-wiring *args* are already in
 * `args` (the driver placed `wireMock(url).args` at the correct argv position
 * via `ctx.mockArgs`); here the env is {@link harnessSpawnEnv} of the caller's,
 * with `wireMock(url).env` on top. Driver-agnostic at the transport seam.
 */
function spawnAgent(
  runtime: HarnessTestDriver["runtime"],
  args: readonly string[],
  run: {
    readonly cwd: string;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly home: HarnessRunHome;
  },
): Promise<RunOut> {
  const { cwd, baseUrl, timeoutMs, home } = run;
  const wired = runtime.wireMock(baseUrl);
  return new Promise((resolvePromise) => {
    // vigiles:free-tier — the deterministic harness tier. `runtime.wireMock`
    // points the binary at the LOCAL scripted mock (base-URL env + dummy key),
    // so no real model is reached and nothing is billed. That is the whole
    // reason this tier is free and runs on every push.
    const child = spawn(runtime.agentBinary, [...args], {
      cwd,
      // Any key works — the mock ignores auth. wireMock supplies the overlay
      // env (base-URL var + dummy key for CC; the dummy key for Codex).
      env: harnessSpawnEnv(runtime, wired.env, home),
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

/** Say so on stderr when side-channel calls arrived and no script turn was served. */
export function warnUnconsumed(count: number, sideChannelCount: number): void {
  const unconsumed = scriptUnconsumedWarning(count, sideChannelCount);
  if (unconsumed !== undefined) console.error(unconsumed);
}

/**
 * A run that proves nothing about the script fails the test instead of coming
 * back as a result: the `claude` on PATH predates `--tools` (#252), or the agent
 * asked for a model turn the script did not have and the mock answered with an
 * error rather than an invented turn (#340). Removes the run's directory, since
 * no result is handed back to clean it up.
 */
function assertRunSound(
  cwd: string,
  stderr: string,
  scripted: number,
  modelRequests: readonly ModelRequest[],
): void {
  const problem =
    unsupportedToolsFlag(stderr) ?? overrunMessageFor(scripted, modelRequests);
  if (problem === undefined) return;
  rmSync(cwd, { recursive: true, force: true });
  throw new Error(problem);
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
    ...(parsed.replies === undefined ? {} : { replies: parsed.replies }),
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
  refuseUnrunnableSpec(spec);
  return runHarnessTestIn(spec, opts, "inherit");
}

/**
 * The scripted model tells an agent turn from the CLI's own bookkeeping calls by
 * the tools the request declares (`isMainLoopRequest`). An agent with none is
 * never served a script turn, and the run would decide on nothing.
 */
function refuseUnrunnableSpec(spec: HarnessTestSpec): void {
  if (spec.allowedTools?.length === 0) {
    throw new Error(
      "allowedTools: [] leaves the agent with no tools, and the scripted model only serves a turn to a request that declares tools — no script turn would be consumed. Name the tools the agent has.",
    );
  }
  const unoffered = unofferedScriptedTool(spec.model, spec.allowedTools);
  if (unoffered !== undefined) throw new Error(unoffered);
}

/**
 * {@link runHarnessTest} with the run's HOME chosen by the caller — see
 * {@link HarnessRunHome}. Not on a public entry point: the one caller that needs
 * a throwaway HOME is vigiles's own preflight (`output-style-arms.ts`), whose
 * run must not depend on, or act as, the machine it happens to run on. The
 * confined (bubblewrap) path ignores `home`: it already runs with its own HOME
 * and a cleared env.
 */
export async function runHarnessTestIn(
  spec: HarnessTestSpec,
  opts: RunHarnessTestOptions,
  home: HarnessRunHome["home"],
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

  const { files, settings, check } = fixtureFor(spec, opts.adapter);
  const cwd = makeTmpDir("harness");
  writeFixture(cwd, files, settings);
  const timeoutMs = spec.timeoutMs ?? 60000;
  const buildArgs = (mockArgs: readonly string[]): readonly string[] =>
    driver.buildArgs({
      prompt: spec.prompt ?? "go",
      cwd,
      hasSettings: settings !== undefined,
      tools: spec.allowedTools,
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
    warnUnconsumed(count, sideChannelCount);
    assertRunSound(cwd, "", spec.model.length, out.requests);
    return check(
      makeResult(cwd, out, parseClaudeRun(out.stdout), count, out.requests),
    );
  }

  // Direct path: mock runs in this process; the agent reaches it over localhost.
  // Start the mock first so its URL feeds the driver's mock-wiring args.
  const mock = await driver.startMock(spec.model);
  try {
    const args = buildArgs(driver.runtime.wireMock(mock.url).args);
    const out = await spawnAgent(driver.runtime, args, {
      cwd,
      baseUrl: mock.url,
      timeoutMs,
      home: runHomeIn(cwd, home),
    });
    // A script that was never consumed is otherwise invisible — the run just
    // looks empty. `scriptUnconsumedWarning` names the one shape that produces
    // it (every request arriving without tool declarations, so nothing looked
    // like an agent turn) instead of leaving it to be rediscovered.
    warnUnconsumed(mock.count, mock.sideChannelCount ?? 0);
    assertRunSound(cwd, out.stderr, spec.model.length, mock.requests);
    return check(
      makeResult(cwd, out, driver.parseRun(out.stdout), mock.count, [
        ...mock.requests,
      ]),
    );
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

/**
 * The fixture to write, and the check its result must pass. Without
 * `outputStyle` the check returns the result as it is.
 */
function fixtureFor(
  spec: HarnessTestSpec,
  adapter: HarnessAdapter | undefined,
): {
  readonly files: Readonly<Record<string, string>>;
  readonly settings: unknown;
  readonly check: (result: HarnessTestResult) => HarnessTestResult;
} {
  // One layout for both phases: the plugin is loaded the way the selected
  // harness lays it out, the same layout the style is then planned against.
  const { layout } = adapter ?? defaultAdapter;
  const resolved = resolveHarness(
    { plugin: spec.plugin, settings: spec.settings, files: spec.files },
    layout,
  );
  if (spec.outputStyle === undefined)
    return { ...resolved, check: (result) => result };
  const rules = layout.outputStyles;
  if (rules === undefined)
    throw new Error("outputStyle: this harness has no output styles");
  const plan = planStyleRun(
    layout,
    { path: spec.outputStyle, text: readStyleFile(spec.outputStyle) },
    resolved,
  );
  if (plan.kind === "refused") throw new Error(`outputStyle: ${plan.reason}`);
  return {
    files: plan.files,
    settings: plan.settings,
    check: (result) => {
      if (styleReached(rules, plan.style, result.modelRequests)) return result;
      throw new Error(
        `outputStyle: "${plan.style.name ?? ""}" never reached the model — ` +
          `no request carried it, so the harness did not load it. ` +
          `Work dir kept for inspection: ${result.cwd}`,
      );
    },
  };
}

/**
 * The files and settings a run with `outputStyle` writes — the style at its
 * place, selected by the name the harness reads from it. The same fixture
 * `runHarnessTest({ outputStyle })` runs, so an eval arm built from it gets
 * exactly what that run proved reaches the model.
 */
export function outputStyleFixture(
  outputStyle: string,
  adapter?: HarnessAdapter,
): {
  readonly files: Readonly<Record<string, string>>;
  readonly settings: unknown;
} {
  const { files, settings } = fixtureFor({ outputStyle, model: [] }, adapter);
  return { files, settings };
}

/** The style file's text, or a clear error naming the path. */
function readStyleFile(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`outputStyle: no such file: ${path}`);
  return readFileSync(abs, "utf-8");
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
