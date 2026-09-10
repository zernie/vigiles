/**
 * vigiles — runner-agnostic helpers for harness tests / evals.
 *
 * `runHarnessTest` and `runEval` are plain async functions that return data, so
 * they already work inside any runner (node:test, vitest, jest, mocha). These
 * helpers remove the last bit of boilerplate without coupling to a runner:
 *
 *   - `withHarness` — run a harness test and auto-clean the sandbox (try/finally),
 *     so you don't leak temp dirs in `afterEach`.
 *   - plain `assert*` helpers that throw — usable in every runner, including
 *     node:test which has no `expect.extend`.
 *   - `vigilesMatchers` — register with `expect.extend(vigilesMatchers)` for
 *     `expect(...).toHaveCreated(...)` sugar. The signature is identical for
 *     vitest and jest, so the same object supports both.
 */
import {
  runHarnessTest,
  type HarnessTestSpec,
  type HarnessTestResult,
  type ToolCall,
  type Trace,
} from "./harness-test.js";
import type { EvalReport, TriggerRateReport } from "./eval.js";
import type { HookRunResult, EgressAttempt } from "./run-hook.js";
import { hookSource, runHookProgram } from "./core/hook-program.js";
import type {
  AnyHook,
  RawHookEvent,
  HookProgramOutcome,
} from "./core/hook-program.js";
import { evalChecks, type Check } from "./check.js";
import { recordCheck, recordSurfaceProbe } from "./check-count.js";
import type { OutputContract } from "./core/spec.js";
import {
  parseAgentResult,
  type ParsedAgentResult,
} from "./adapters/claude-code/agent-result.js";
import { compareArms } from "./stats.js";
import {
  diffReports,
  type BaselineFile,
  type DiffOptions,
} from "./eval-baseline.js";

// Re-export the significance primitives so the whole eval-analysis surface lives
// re-exported from the `vigiles` root (there is no `vigiles/harness-assert` entry
// point — it was advertised in this very comment and never existed).
export { compareArms } from "./stats.js";
export type { Comparison } from "./stats.js";
export {
  diffReports,
  toBaselineFile,
  parseBaselineFile,
  readBaseline,
  writeBaseline,
  formatBaselineDiff,
  diffToJUnit,
} from "./eval-baseline.js";
export type {
  BaselineFile,
  BaselineDiff,
  MetricDiff,
  DiffStatus,
  DiffOptions,
} from "./eval-baseline.js";

/**
 * Run a harness test, hand the result to `fn`, and always clean up the sandbox.
 * Returns whatever `fn` returns. Use this instead of calling `cleanup()` by
 * hand — it survives assertion failures.
 */
/* v8 ignore start -- thin wrapper over runHarnessTest (spawns the real CLI) */
export async function withHarness<T>(
  spec: HarnessTestSpec,
  fn: (r: HarnessTestResult) => T | Promise<T>,
): Promise<T> {
  const r = await runHarnessTest(spec);
  try {
    return await fn(r);
  } finally {
    r.cleanup();
  }
}
/* v8 ignore stop */

// --- Plain throwing assertions (any runner) --------------------------------

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Mark the current `*.harness.*` / `*.eval.*` SCRIPT as SKIPPED and exit, so
 * `vigiles test` / `vigiles eval` report a loud `⊘ SKIPPED` instead of a silent
 * `✓` — e.g. the deterministic tier when the `claude` CLI isn't installed. A skip
 * never fails the run. Exit 77 is the runner's `SKIP_EXIT_CODE` (run-scripts.ts).
 *
 * For standalone CLI-fallback scripts only — inside a runner (vitest / jest /
 * node:test) use that runner's own skip, not a process exit.
 */
/* v8 ignore start -- process.exit can't be exercised in-process (tested via a child in cli.test.ts / run-scripts.test.ts) */
export function skip(reason?: string): never {
  console.log(`SKIPPED${reason ? `: ${reason}` : ""}`);
  process.exit(77);
}
/* v8 ignore stop */

/** Assert the sandbox contains `path` (a hook/agent side-effect file). */
export function assertCreated(r: HarnessTestResult, path: string): void {
  if (r.file(path) === null) fail(`expected the run to create ${path}`);
}

/** Assert the sandbox does NOT contain `path` (e.g. a blocked action's output). */
export function assertNotCreated(r: HarnessTestResult, path: string): void {
  if (r.file(path) !== null) fail(`expected the run NOT to create ${path}`);
}

/** Assert the scripted model served at least `n` turns (e.g. a Stop hook forced more). */
export function assertServedTurns(r: HarnessTestResult, n: number): void {
  if (r.turns < n) {
    fail(`expected ≥ ${String(n)} model turns, got ${String(r.turns)}`);
  }
}

/** Assert a `runHook` result blocked (exit 2 / decision:block / permission:deny). */
export function assertHookBlocked(r: HookRunResult): void {
  if (!r.blocked) {
    fail(
      `expected the hook to block, but it allowed (exit ${String(r.exitCode)})`,
    );
  }
}

/** Assert a `runHook` result allowed (did not block). */
export function assertHookAllowed(r: HookRunResult): void {
  if (r.blocked) {
    fail(
      `expected the hook to allow, but it blocked (exit ${String(r.exitCode)}, decision ${String(r.decision)})`,
    );
  }
}

/**
 * `runHookProgram`, counted AND attributed. An in-process hook decision is an
 * observation the CLI runner can see — without it, a `*.harness.*` file that only
 * tests compiled hooks would look like it did nothing at all. See check-count.ts.
 *
 * 🔴 THE PROBE BELONGS HERE, AND NOWHERE EARLIER OR LATER. The documented
 * in-process path — `loadHook(file)` then `assertHookDenies(hook, event)` — used
 * to record a check and no SURFACE, so the child exited a non-vacuous pass with
 * an empty `surfaces` list, `runsFromResults` discarded it, and a harness that
 * genuinely executed a compiled hook produced NO execution record. The hook then
 * showed as untested unless filename colocation happened to cover it. Unlike
 * every other coverage finding in this review that is a false NEGATIVE — real
 * execution going unrecorded — which is why the bar for what gets recorded here
 * is the high one, not the cheap one.
 *
 * Not at LOAD: `loadHook` only remembers the path. Someone loading a hook to
 * inspect its shape has not run it, and crediting that would be the "an empty
 * file counts" substitution the execution tier exists to remove.
 *
 * Not in `runHookProgram`: that is the PURE evaluator, and it is what the CLI's
 * `hook-runtime run-program` calls on every live event in production. Recording
 * there would make the pure decision impure and would fire outside any test.
 *
 * This function is the only place that has both facts — the hook is about to be
 * evaluated, and (when it came from `loadHook`) we know its file. Four public
 * assertions funnel through it, so none of them can be added without inheriting
 * the attribution.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT ATTRIBUTE — run, not asserted. A hook built
 * in-process rather than loaded from disk has no file to name, so nothing is
 * recorded and nothing is invented:
 *
 *     const h = experimental_defineHook({…}); assertHookDenies(h, e);  → surfacesRecorded() === []
 *
 * …and a direct `runHookProgram(hook, event)` call (the pure evaluator, public
 * via `vigiles/hook`) records nothing either, for the reason above. Both cost a
 * missed record, never a false one.
 */
function runCountedHookProgram(
  hook: AnyHook,
  event: RawHookEvent,
): HookProgramOutcome {
  recordCheck();
  // `command`, the same shape a parsed hook ref gets — but note the provenance
  // differs: that one is inferred from a command string and is best-effort; this
  // one is the path `loadHook` resolved, so it is exact by construction.
  const source = hookSource(hook);
  if (source !== undefined) recordSurfaceProbe("command", source);
  return runHookProgram(hook, event);
}

/** Render a {@link HookProgramOutcome} for an assertion message. */
function describeOutcome(o: HookProgramOutcome): string {
  if (o.kind === "decision") return `${o.decision.kind} (a gate decision)`;
  if (o.kind === "injection") return `an injection`;
  return `${o.reaction.kind} (a reaction)`;
}

/**
 * Assert a COMPILED hook (a `vigiles/hook` program) denies an event — evaluated
 * in-process, no subprocess, no model. The cheapest way to test a gate's logic:
 * pass the hook's default export and a raw event. (For the wired-into-the-real-CLI
 * check, use {@link assertHookBlocked} over `runHook`.)
 */
export function assertHookDenies(hook: AnyHook, event: RawHookEvent): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "decision" || o.decision.kind !== "deny") {
    fail(`expected the hook to deny, got ${describeOutcome(o)}`);
  }
}

/** Assert a COMPILED hook allows an event (in-process). The twin of {@link assertHookDenies}. */
export function assertHookAllows(hook: AnyHook, event: RawHookEvent): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "decision" || o.decision.kind !== "allow") {
    fail(`expected the hook to allow, got ${describeOutcome(o)}`);
  }
}

/**
 * Assert a COMPILED **react** hook emits a `notice(…)` for an event, optionally
 * matching its message — the react-tier twin of {@link assertHookDenies}.
 *
 * A react hook can't block, so the gate assertions don't apply to it, and there
 * was no assertion that did. That left `notice()` a live trap: a probe built on
 * `execFileSync` (which returns stdout only) reported a perfectly healthy react
 * hook as DEAD — measured against three real hooks on 2026-08-03. Reading the
 * reaction in-process means no stream enters into it, which is why this
 * assertion did not change when delivery did: since 2026-09-07 a notice also
 * goes to stdout as `additionalContext` on an event the harness injects (see
 * `noticeDelivery`), so WHICH stream carries it now depends on the event — a
 * stream probe is even less answerable than before, and this one is unaffected.
 */
export function assertHookNotices(
  hook: AnyHook,
  event: RawHookEvent,
  matcher?: string | RegExp,
): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "reaction" || o.reaction.kind !== "notice") {
    fail(`expected the hook to notice, got ${describeOutcome(o)}`);
  }
  if (matcher === undefined) return;
  const { message } = o.reaction;
  const matched =
    typeof matcher === "string"
      ? message.includes(matcher)
      : matcher.test(message);
  if (!matched) {
    fail(
      `expected the notice to match ${String(matcher)}, got ${JSON.stringify(message)}`,
    );
  }
}

/**
 * Assert a COMPILED **react** hook stays silent for an event — it returns
 * `nothing()` (a `"none"` reaction). The twin of {@link assertHookNotices}: together they pin both
 * halves of a react hook's behaviour — it fires when it should, and (the half
 * that actually regresses) it does NOT fire when it shouldn't.
 *
 * A `run(…)` reaction is not silent for this purpose: the hook still reacted.
 */
export function assertHookSilent(hook: AnyHook, event: RawHookEvent): void {
  const o = runCountedHookProgram(hook, event);
  if (o.kind !== "reaction") {
    fail(`expected a react hook, got ${describeOutcome(o)}`);
  }
  if (o.reaction.kind !== "none") {
    fail(`expected the hook to stay silent, got ${describeOutcome(o)}`);
  }
}

// --- egress (network) — recordEgress runs ----------------------------------
//
// A `runHook(..., { recordEgress: true })` confines the hook AND records every
// host:port a proxy-honoring tool tried to reach (then blocks it). These assert
// over that record: a hook should phone home to nothing, or only to an allowlist.

/** Anything carrying recorded egress attempts (a runHook recordEgress result). */
interface HasEgress {
  readonly egress: readonly EgressAttempt[];
}

const hostPort = (e: EgressAttempt): string => `${e.host}:${String(e.port)}`;

/** The `host:port` strings a run attempted, e.g. `["registry.npmjs.org:443"]`. */
export function egressHosts(r: HasEgress): string[] {
  return r.egress.map(hostPort);
}

/** Assert the confined run made NO network egress attempt at all. */
export function assertNoEgress(r: HasEgress): void {
  if (r.egress.length > 0) {
    fail(
      `expected no egress, but it tried to reach: ${egressHosts(r).join(", ")}`,
    );
  }
}

/**
 * Assert every egress attempt went to an allowed host. `allowed` matches a host
 * (exact string or regex), or a specific `host:port`. Any attempt outside the
 * allowlist fails, naming the offender — exfil / unexpected-registry detection.
 */
export function assertEgressOnly(
  r: HasEgress,
  allowed: ReadonlyArray<string | RegExp>,
): void {
  const ok = (e: EgressAttempt): boolean =>
    allowed.some((a) =>
      typeof a === "string"
        ? a === e.host || a === hostPort(e)
        : a.test(e.host) || a.test(hostPort(e)),
    );
  const bad = r.egress.filter((e) => !ok(e));
  if (bad.length > 0) {
    fail(`egress to non-allowlisted host(s): ${bad.map(hostPort).join(", ")}`);
  }
}

// --- file writes (IO) — confined runs --------------------------------------
//
// A confined `runHook` records what the hook wrote to its work dir
// (`r.filesWritten`, relative paths). These assert a hook touched only the files
// it should — e.g. "wrote nothing but its own state cache".

/**
 * Anything carrying recorded file writes (a confined `runHook`/`runScript`
 * result). `filesWritten` is OPTIONAL on purpose: `undefined` means the run
 * never recorded writes at all, which is a different fact from `[]` ("recorded,
 * and it wrote nothing"). See {@link requireWrites}.
 */
interface HasWrites {
  readonly filesWritten?: readonly string[];
}

const matches = (f: string, p: string | RegExp): boolean =>
  typeof p === "string" ? f.includes(p) : p.test(f);

/**
 * The recorded write list, or a THROW when the run never recorded one.
 *
 * Writes are captured by diffing the work dir, which only happens on a confined
 * run. An unconfined run therefore knows nothing about what the program wrote —
 * and an assertion that silently treats "nobody looked" as "nothing happened"
 * reports success while inspecting no evidence. That is the failure mode this
 * whole library exists to catch in other people's harnesses, so it must not be
 * this library's own default. Refuse instead, and name the fix.
 */
function requireWrites(r: HasWrites, assertion: string): readonly string[] {
  if (r.filesWritten !== undefined) return r.filesWritten;
  return fail(
    `${assertion} cannot run: this result never recorded file writes, so ` +
      `passing it would assert nothing. Writes are captured by diffing the work ` +
      `dir, which only a CONFINED run does — pass \`{ sandbox: "auto" }\` (or ` +
      `\`"strict"\`) to record them. Note confinement needs Linux + bubblewrap.`,
  );
}

/** Assert the run wrote NO file matching `pattern` (substring or regex). */
export function assertNoWrite(r: HasWrites, pattern: string | RegExp): void {
  const bad = requireWrites(r, "assertNoWrite").filter((f) =>
    matches(f, pattern),
  );
  if (bad.length > 0) {
    fail(
      `expected no write matching ${String(pattern)}, but wrote: ${bad.join(", ")}`,
    );
  }
}

/** Assert every file the run wrote matches one of `allowed` (substring or regex). */
export function assertWroteOnly(
  r: HasWrites,
  allowed: ReadonlyArray<string | RegExp>,
): void {
  const bad = requireWrites(r, "assertWroteOnly").filter(
    (f) => !allowed.some((a) => matches(f, a)),
  );
  if (bad.length > 0) {
    fail(`run wrote file(s) outside the allowlist: ${bad.join(", ")}`);
  }
}

// --- subagent railway outcome (parse the worker's result block) ------------
//
// A subagent with a result() contract ends its turn with a vigiles:ok/err block.
// These wrap parseAgentResult so a test can assert the worker's *outcome* the
// same way it asserts a hook decision — the testing-framework payoff of the
// railway contract: `assertAgentOk(r.output)` instead of substring-matching prose.

/**
 * Assert the worker's output is a success result, and return its `value`. With a
 * `contract`, the value is validated against the success shape (a wrong/missing
 * field fails the assertion). A malformed or error result throws.
 */
export function assertAgentOk(
  output: string,
  contract?: OutputContract,
): Record<string, unknown> {
  const r = parseAgentResult(output, contract);
  if (r.kind === "ok") return r.value;
  const why = r.kind === "err" ? "returned an error result" : r.reason;
  return fail(`expected a success result from the subagent, but ${why}`);
}

/**
 * Assert the worker's output is an error result, and return its `error`. The
 * railway's error track — proves the worker reported failure with rich detail
 * (not that it crashed or returned prose). A malformed or success result throws.
 */
export function assertAgentErr(
  output: string,
  contract?: OutputContract,
): Record<string, unknown> {
  const r = parseAgentResult(output, contract);
  if (r.kind === "err") return r.error;
  const why = r.kind === "ok" ? "returned a success result" : r.reason;
  return fail(`expected an error result from the subagent, but ${why}`);
}

/**
 * Assert the parsed result satisfies `predicate` — the general form, for
 * checking rich detail (e.g. `(r) => r.kind === "ok" && r.value.files.length > 0`).
 */
export function assertAgentResult(
  output: string,
  predicate: (r: ParsedAgentResult) => boolean,
  contract?: OutputContract,
): void {
  const r = parseAgentResult(output, contract);
  if (!predicate(r)) {
    const detail = r.kind === "malformed" ? ` (${r.reason})` : "";
    fail(`subagent result did not satisfy the predicate: ${r.kind}${detail}`);
  }
}

function nameMatches(name: string, pat: string | RegExp): boolean {
  return typeof pat === "string" ? name === pat : pat.test(name);
}

function toolNames(trace: Trace): string {
  return trace.toolCalls.map((c) => c.name).join(", ") || "none";
}

// --- bare predicates over a Trace (the shared vocabulary, no throw) ---------
//
// Pure fns returning a value, so the SAME vocabulary runs in both consumers:
// the throwing `assert*` helpers below wrap them for the testing tier, and an
// eval `measure` reuses them directly as metrics (`measure: (t) => ({ safe:
// !usedTool(t, /merge|delete/) })`). Never one dual-purpose function.

/**
 * Did the agent invoke a tool whose name matches `name` (string = exact,
 * RegExp = test)? The predicate behind `assertToolUsed` / `assertToolNotUsed`.
 */
export function usedTool(trace: Trace, name: string | RegExp): boolean {
  return trace.toolCalls.some((c) => nameMatches(c.name, name));
}

/** How many tools matching `name` the agent invoked. Behind `assertToolCount`. */
export function toolCount(trace: Trace, name: string | RegExp): number {
  return trace.toolCalls.filter((c) => nameMatches(c.name, name)).length;
}

/**
 * Did the `Skill` tool resolve `skill` (e.g. `"superpowers:test-driven-development"`)
 * without error? The skill-activation predicate behind `assertSkillResolved`.
 */
export function skillResolved(trace: Trace, skill: string): boolean {
  const call = trace.toolCalls.find(
    (c) =>
      c.name === "Skill" && (c.input as { skill?: string })?.skill === skill,
  );
  return call !== undefined && !call.isError;
}

/**
 * Did the agent invoke a tool matching `name` whose INPUT satisfies
 * `inputMatcher` — a tool-ARGUMENT predicate (DeepEval-style), e.g. an `Edit`
 * that targeted the right file. The predicate behind `assertToolUsedWith`.
 */
export function toolUsedWith(
  trace: Trace,
  name: string | RegExp,
  inputMatcher: (input: unknown) => boolean,
): boolean {
  return trace.toolCalls.some(
    (c) => nameMatches(c.name, name) && inputMatcher(c.input),
  );
}

/**
 * Does the agent's final answer (`trace.output`) contain `needle` (string =
 * substring, RegExp = test)? The output predicate behind `assertOutputContains`
 * — the DeepEval-style "what did the agent actually say" check.
 */
export function outputContains(trace: Trace, needle: string | RegExp): boolean {
  return typeof needle === "string"
    ? trace.output.includes(needle)
    : needle.test(trace.output);
}

/** All text the model received across every request (system + every message). */
function requestText(trace: Trace): string {
  return trace.modelRequests
    .map((r) => [r.system, ...r.messages.map((m) => m.text)].join("\n"))
    .join("\n");
}

/**
 * Did ANY request the model received contain `needle` — searching the system
 * prompt and every message across all requests? The predicate that proves
 * injected context *reached the model*: a SessionStart hook's `additionalContext`
 * or a slash command's expansion.
 *
 * THIS IS A PROJECTION OF THE REQUEST, NOT THE REQUEST — state what it omits
 * before building a claim on it. Until 2026-09-10 this sentence was false: the
 * flattener read only `.text`, so the eight `ContentBlockParam` variants that
 * carry `content` were invisible, and a payload Claude Code had delivered inside
 * a `tool_result` read as "never arrived" (zernie/vigiles#231, a false finding).
 * It now covers every block type the pinned SDK union names, and serialises any
 * it does not. STILL OMITTED BY DESIGN: `tool_use` / `server_tool_use` inputs —
 * those are what the model SAID, not what it was TOLD, so a needle in a tool
 * argument must not read as delivery. See `flattenBlock` in mock-model.ts. Harness tier only — the eval tier drives the
 * real API, so its `modelRequests` (and this) is empty. Behind `assertRequestContains`.
 */
export function requestContains(
  trace: Trace,
  needle: string | RegExp,
): boolean {
  const text = requestText(trace);
  return typeof needle === "string" ? text.includes(needle) : needle.test(text);
}

/**
 * Did a hook matching `name` fire? Matches against both the hook label
 * (`"PreToolUse:Edit"`) and the bare event (`"PreToolUse"`), so `/PreToolUse/`
 * or `"PreToolUse:Edit"` both work. The predicate behind `assertHookFired`.
 */
export function hookFired(trace: Trace, name: string | RegExp): boolean {
  return trace.hooks.some(
    (h) => nameMatches(h.name, name) || nameMatches(h.event, name),
  );
}

/** Did a hook matching `name` fire AND block (exit ≠ 0 / outcome "error")? */
export function hookBlocked(trace: Trace, name: string | RegExp): boolean {
  return trace.hooks.some(
    (h) =>
      (nameMatches(h.name, name) || nameMatches(h.event, name)) && h.blocked,
  );
}

/**
 * Assert the agent invoked a tool whose name matches `name` (string = exact,
 * RegExp = test) — e.g. a skill (`"Skill"`), an MCP tool (`/^mcp__github__/`), or
 * a subagent (`"Task"`). Needs `transcript: true`. The action invariant the
 * skill/MCP/command surfaces are really about.
 */
export function assertToolUsed(trace: Trace, name: string | RegExp): void {
  if (!usedTool(trace, name)) {
    fail(
      `expected a tool matching ${String(name)} to be used; tools used: [${toolNames(trace)}] (did you set transcript:true?)`,
    );
  }
}

/**
 * Assert the agent did NOT invoke any tool matching `name` — the safety negative
 * (e.g. a destructive MCP tool was never called). "File unchanged" can pass by
 * accident; "the tool was never used" is the real invariant. Needs `transcript`.
 */
export function assertToolNotUsed(trace: Trace, name: string | RegExp): void {
  // `find` is the negative of `usedTool` and narrows the hit for the message.
  const hit = trace.toolCalls.find((c) => nameMatches(c.name, name));
  if (hit) {
    fail(
      `expected no tool matching ${String(name)} to be used, but ${hit.name} was`,
    );
  }
}

/**
 * Assert the `Skill` tool resolved `skill` (e.g. `"superpowers:test-driven-development"`)
 * without error — the correct skill-activation invariant, vs. grepping the body.
 */
export function assertSkillResolved(trace: Trace, skill: string): void {
  if (skillResolved(trace, skill)) return;
  // skillResolved is false → either no matching Skill call, or it errored.
  // Reconstruct which, for a useful message.
  const call = trace.toolCalls.find(
    (c) =>
      c.name === "Skill" && (c.input as { skill?: string })?.skill === skill,
  );
  if (!call) {
    const seen = trace.toolCalls
      .filter((c) => c.name === "Skill")
      .map((c) => (c.input as { skill?: string })?.skill ?? "?")
      .join(", ");
    fail(
      `expected the Skill tool to resolve "${skill}"; Skill calls: [${seen || "none"}]`,
    );
  }
  fail(
    `the Skill "${skill}" was invoked but errored: ${call.resultText.slice(0, 200)}`,
  );
}

/**
 * Assert the agent invoked a tool matching `name` whose INPUT satisfies
 * `inputMatcher` — a tool-ARGUMENT invariant (DeepEval-style). Asserts not just
 * *that* a tool ran but *with what args*, e.g. an `Edit` that targeted the right
 * file: `assertToolUsedWith(r, "Edit", (i) => (i as { file_path?: string })
 * .file_path === "src/x.ts")`. Needs `transcript`.
 */
export function assertToolUsedWith(
  trace: Trace,
  name: string | RegExp,
  inputMatcher: (input: unknown) => boolean,
  message?: string,
): void {
  if (!toolUsedWith(trace, name, inputMatcher)) {
    const seen = trace.toolCalls
      .filter((c) => nameMatches(c.name, name))
      .map((c) => JSON.stringify(c.input))
      .join(", ");
    fail(
      message ??
        `expected a ${String(name)} call whose input matches; ${String(name)} inputs: [${seen || "none"}]`,
    );
  }
}

/** Assert the agent's final answer contains `needle` (string substring / RegExp). */
export function assertOutputContains(
  trace: Trace,
  needle: string | RegExp,
): void {
  if (!outputContains(trace, needle)) {
    const shown = trace.output.slice(0, 200) || "(empty)";
    fail(
      `expected the agent's final answer to contain ${String(needle)}; got: ${shown}`,
    );
  }
}

/**
 * Assert some request the model received contained `needle` — the "did the
 * injected context land" invariant (SessionStart `additionalContext`, slash
 * command expansion). Harness tier only; a zero-request trace fails with a hint
 * that the eval tier can't capture requests.
 */
export function assertRequestContains(
  trace: Trace,
  needle: string | RegExp,
): void {
  if (!requestContains(trace, needle)) {
    const n = trace.modelRequests.length;
    const hint =
      n === 0
        ? " (no requests captured — modelRequests is harness-tier only)"
        : "";
    fail(
      `expected a model request to contain ${String(needle)}; ${String(n)} request(s) captured${hint}`,
    );
  }
}

function hookNames(trace: Trace): string {
  return trace.hooks.map((h) => h.name).join(", ") || "none";
}

/**
 * Assert a hook matching `name` fired (and, with `{ blocked: true }`, that it
 * blocked) — the honest hook-firing check, recorded from the run's stream rather
 * than inferred from a marker file the hook had to write. Needs `transcript`.
 */
export function assertHookFired(
  trace: Trace,
  name: string | RegExp,
  opts: { blocked?: boolean } = {},
): void {
  if (!hookFired(trace, name)) {
    fail(
      `expected a hook matching ${String(name)} to fire; hooks fired: [${hookNames(trace)}] (did you set transcript:true?)`,
    );
  }
  if (opts.blocked === true && !hookBlocked(trace, name)) {
    fail(
      `expected a hook matching ${String(name)} to block, but none did; hooks fired: [${hookNames(trace)}]`,
    );
  }
}

// --- sequence / budget invariants over the agent's actions -----------------

/**
 * Assert how many tools matching `name` the agent invoked is within bounds — a
 * budget invariant (e.g. `{ max: 1 }` = "at most one Write", `{ exactly: 0 }` =
 * "never touched it"). Catches runaway loops and wasted work. Needs `transcript`.
 */
export function assertToolCount(
  trace: Trace,
  name: string | RegExp,
  bounds: { min?: number; max?: number; exactly?: number },
): void {
  const n = toolCount(trace, name);
  const ok =
    (bounds.exactly === undefined || n === bounds.exactly) &&
    (bounds.min === undefined || n >= bounds.min) &&
    (bounds.max === undefined || n <= bounds.max);
  if (!ok) {
    fail(
      `expected count of ${String(name)} to satisfy ${JSON.stringify(bounds)}, got ${String(n)} (tools: [${toolNames(trace)}])`,
    );
  }
}

/**
 * Assert the named tools occurred in this order (as a subsequence — gaps allowed)
 * — an ordering invariant. e.g. `["Read", "Edit"]` checks a Read came before an
 * Edit. For a stricter rule (every Edit preceded by a Read), use `assertToolCalls`.
 * Needs `transcript`.
 */
export function assertToolSequence(
  trace: Trace,
  names: ReadonlyArray<string | RegExp>,
): void {
  let i = 0;
  for (const c of trace.toolCalls) {
    const want = names[i];
    if (want !== undefined && nameMatches(c.name, want)) i++;
  }
  if (i < names.length) {
    fail(
      `expected tools in order [${names.map((n) => String(n)).join(" → ")}]; got [${toolNames(trace)}]`,
    );
  }
}

/**
 * The escape hatch: assert any custom invariant over the full list of tool calls
 * the agent made — for rules the helpers above don't express, e.g. "every Edit
 * was preceded by a Read of that file". Needs `transcript`.
 */
export function assertToolCalls(
  trace: Trace,
  predicate: (calls: readonly ToolCall[]) => boolean,
  message = "tool-call invariant failed",
): void {
  if (!predicate(trace.toolCalls)) {
    fail(`${message}; tools used: [${toolNames(trace)}]`);
  }
}

/**
 * Did `arm` succeed on EVERY trial for `metric` — τ-bench pass^k = 1? The
 * reliability predicate over an eval report (vs. `improvement`, which reads the
 * mean gap). Reads `report.arms[arm].stats[metric].passK`.
 */
export function reliable(
  report: EvalReport,
  arm: string,
  metric: string,
): boolean {
  return report.arms[arm]?.stats[metric]?.passK === 1;
}

/**
 * Assert `arm` passed `metric` on every trial (pass^k = 1) — the reliability
 * gate for a non-deterministic harness ("worked every time", not "on average").
 */
export function assertReliable(
  report: EvalReport,
  opts: { arm: string; metric: string },
): void {
  if (!reliable(report, opts.arm, opts.metric)) {
    const pk = report.arms[opts.arm]?.stats[opts.metric]?.passK;
    fail(
      `expected ${opts.arm} to pass ${opts.metric} on every trial (pass^k=1), got pass^k=${String(pk ?? "n/a")}`,
    );
  }
}

/** The gap on `metric` between two arms (arm − baseline). */
export function improvement(
  report: EvalReport,
  baseline: string,
  arm: string,
  metric: string,
): number {
  const a = report.arms[arm]?.metrics[metric] ?? 0;
  const b = report.arms[baseline]?.metrics[metric] ?? 0;
  return a - b;
}

/**
 * Did `arm` *significantly* beat `baseline` on `metric` — a positive gap whose
 * two-sided Welch t-test p-value is below `alpha` (default 0.05)? The grounded
 * upgrade over `improvement`: the noise floor is computed from the arms' spread,
 * not hand-fed. False when either arm/metric is missing. See `src/stats.ts`.
 */
// eslint-disable-next-line max-params -- positional predicate mirrors `improvement` + alpha
export function significantlyBeats(
  report: EvalReport,
  baseline: string,
  arm: string,
  metric: string,
  alpha = 0.05,
): boolean {
  const c = compareArms(report, baseline, arm, metric, alpha);
  return c !== null && c.delta > 0 && c.significant;
}

/**
 * Assert `arm` significantly beats `baseline` on `metric` (positive gap, p < α).
 * The statistical gate for a non-deterministic A/B — "the gap clears the noise",
 * with the noise floor computed, not supplied. The honest version of
 * `assertImproves(..., { by: se })`.
 */
export function assertSignificant(
  report: EvalReport,
  opts: { baseline: string; arm: string; metric: string; alpha?: number },
): void {
  const c = compareArms(
    report,
    opts.baseline,
    opts.arm,
    opts.metric,
    opts.alpha,
  );
  if (c === null) {
    fail(
      `no data to compare ${opts.arm} vs ${opts.baseline} on ${opts.metric}`,
    );
  }
  const alpha = opts.alpha ?? 0.05;
  if (!(c.delta > 0 && c.significant)) {
    fail(
      `expected ${opts.arm} to significantly beat ${opts.baseline} on ${opts.metric} (α=${String(alpha)}); Δ=${c.delta.toFixed(3)}, p=${c.pValue.toFixed(3)}`,
    );
  }
}

/**
 * Assert `arm` beats `baseline` on `metric`. By default just a positive gap > `by`
 * (pass the combined se to clear the noise floor by hand). Pass `{ significant:
 * true }` to demand a Welch t-test at `alpha` instead — the computed noise floor.
 */
export function assertImproves(
  report: EvalReport,
  opts: {
    baseline: string;
    arm: string;
    metric: string;
    by?: number;
    significant?: boolean;
    alpha?: number;
  },
): void {
  if (opts.significant === true) {
    assertSignificant(report, opts);
    return;
  }
  const by = opts.by ?? 0;
  const delta = improvement(report, opts.baseline, opts.arm, opts.metric);
  if (delta <= by) {
    fail(
      `expected ${opts.arm} to beat ${opts.baseline} on ${opts.metric} by > ${String(by)}, got ${delta.toFixed(3)}`,
    );
  }
}

/**
 * Assert the current run has not *regressed* against a committed baseline — the
 * CI gate (Phase C). A regression is an arm×metric that moved **significantly in
 * the bad direction** vs. `baseline` (Welch t-test, so sampling noise doesn't
 * trip it; see `src/eval-baseline.ts`). Higher is better by default; list
 * `lowerIsBetter` metrics (cost/latency) to flip them. Load the baseline with
 * `readBaseline(path)` and record a fresh one with `writeBaseline(path, reports)`.
 */
export function assertNoRegression(
  current: EvalReport | readonly EvalReport[],
  baseline: BaselineFile,
  opts?: DiffOptions,
): void {
  const reports = Array.isArray(current)
    ? (current as readonly EvalReport[])
    : [current as EvalReport];
  const diff = diffReports(baseline, reports, opts);
  if (!diff.passed) {
    const detail = diff.regressions
      .map(
        (r) =>
          `${r.report}/${r.arm}/${r.metric} Δ=${r.comparison.delta.toFixed(3)} p=${r.comparison.pValue.toFixed(3)}`,
      )
      .join("; ");
    fail(`regression vs baseline: ${detail}`);
  }
}

/**
 * Assert a skill/behaviour triggered reliably — the gate for a skill's
 * *activation*, over a {@link TriggerRateReport} from `measureTriggerRate`.
 * `min` gates recall (fires when it should). With irrelevant prompts measured,
 * `maxFalsePositive` gates the precision side (does NOT fire when it shouldn't)
 * and `minPrecision` gates `firedRight / firedTotal` — so a too-broad
 * description that hijacks unrelated work fails, not just a too-narrow one.
 */
export function assertTriggerRate(
  report: TriggerRateReport,
  opts: { min?: number; maxFalsePositive?: number; minPrecision?: number },
): void {
  if (opts.min !== undefined && report.rate < opts.min) {
    fail(
      `expected a trigger rate ≥ ${String(opts.min)}, got ${report.rate.toFixed(2)} (${String(report.n)} runs)`,
    );
  }
  if (
    opts.maxFalsePositive !== undefined &&
    (report.falsePositiveRate ?? 0) > opts.maxFalsePositive
  ) {
    fail(
      `expected a false-positive rate ≤ ${String(opts.maxFalsePositive)}, got ${(report.falsePositiveRate ?? 0).toFixed(2)}`,
    );
  }
  if (
    opts.minPrecision !== undefined &&
    (report.precision ?? 0) < opts.minPrecision
  ) {
    fail(
      `expected precision ≥ ${String(opts.minPrecision)}, got ${report.precision === undefined ? "n/a (nothing fired)" : report.precision.toFixed(2)}`,
    );
  }
}

// --- jest / vitest matchers (expect.extend) --------------------------------

interface MatcherOutput {
  pass: boolean;
  message: () => string;
}

/**
 * Custom matchers compatible with both vitest and jest. Register once:
 *
 *   import { expect } from "vitest"; // or "@jest/globals"
 *   import { vigilesMatchers } from "vigiles";
 *   expect.extend(vigilesMatchers);
 *
 *   expect(result).toHaveCreated("RESULT");
 *   expect(report).toBeatBaseline("vanilla", "gated", "caught");
 */
export const vigilesMatchers = {
  toHaveCreated(received: HarnessTestResult, path: string): MatcherOutput {
    const pass = received.file(path) !== null;
    return {
      pass,
      message: () => `expected the run ${pass ? "not " : ""}to create ${path}`,
    };
  },
  toBlock(received: HookRunResult): MatcherOutput {
    const pass = received.blocked;
    return {
      pass,
      message: () =>
        `expected the hook ${pass ? "not " : ""}to block (exit ${String(received.exitCode)}, decision ${String(received.decision)})`,
    };
  },
  // eslint-disable-next-line max-params -- jest/vitest matchers take positional args
  toBeatBaseline(
    received: EvalReport,
    baseline: string,
    arm: string,
    metric: string,
    by = 0,
  ): MatcherOutput {
    const delta = improvement(received, baseline, arm, metric);
    const pass = delta > by;
    return {
      pass,
      message: () =>
        `expected ${arm} ${pass ? "not " : ""}to beat ${baseline} on ${metric} by > ${String(by)} (got ${delta.toFixed(3)})`,
    };
  },
  // The check-vocabulary veneer (Phase 1): ONE matcher works for EVERY check,
  // carrying the check's own failure message. `expect(r).toPass(tool("Bash"))`.
  toPass<T>(received: T, check: Check<T>): MatcherOutput {
    const r = check.eval(received);
    return { pass: r.pass, message: () => r.message };
  },
  toPassAll<T>(received: T, checks: readonly Check<T>[]): MatcherOutput {
    const failed = evalChecks(received, checks).filter((x) => !x.pass);
    return {
      pass: failed.length === 0,
      message: () =>
        failed.length === 0
          ? "all checks passed"
          : failed.map((f) => `  ✗ ${f.message}`).join("\n"),
    };
  },
};
