/**
 * `vigiles` (the package root) — the **free** testing surface: everything you can
 * run without a model call, and therefore without a bill.
 *
 * This is the front door. There is no `vigiles/test` subpath: the bare package
 * name IS the testing surface, because a second name for the same door is the
 * duplication this reorganisation removed (the old `.` + `./spec` pair pointed at
 * one module under two names). A subpath is warranted when something genuinely
 * DIFFERENT lives behind it — another runtime, another driver, another protocol.
 * Here the one real difference is whether a call can spend money, so there are
 * exactly two doors: this one, and [`vigiles/eval`](./eval-surface.ts).
 *
 * ## What replaced what
 *
 * The old split was by TEST TIER — `vigiles/unit`, `vigiles/integration`,
 * `vigiles/e2e`, `vigiles/testing`. Tiers are a property of test-file layout and
 * runner config, not of a module graph: this repo already expresses them as
 * vitest projects (`test:unit`, `test:integration`, `test:e2e`), so the exports
 * map was a second, competing implementation of the same idea. `src/e2e.ts` had
 * degenerated to `export * from "./integration.js"` — a barrel adding zero
 * symbols, which its own docstring called "the definition of a non-tier".
 *
 * ## Two honest costs of the new split
 *
 * **1. The type coupling crosses the boundary and cannot be removed.** About two
 * dozen helpers here — `assertImproves`, `assertNoRegression`, `assertReliable`,
 * `assertSignificant`, `assertTriggerRate`, `reliable`, `improvement`,
 * `significantlyBeats`, `compareArms`, `diffReports`, `diffToJUnit`,
 * `formatBaselineDiff`, `parseBaselineFile`, `readBaseline`, `toBaselineFile`,
 * `writeBaseline`, `cost`, `latency`, `tokens`, `inputTokens`, `outputTokens`,
 * `cacheTokens`, plus `formatEvalReport` / `formatCheckReport` /
 * `formatTriggerRateReport` / `checkReportToJUnit` / `assertRates` — operate on
 * eval RESULTS while spending nothing themselves. They belong on the free path.
 * Their TYPES (`EvalReport`, `CheckReport`, `TriggerRateReport`, `Metrics`, …)
 * are defined on the paid side. So those types are re-exported from BOTH barrels:
 * a user of the free surface must never import `vigiles/eval` for a type alone.
 * The duplication is deliberate and is the price of splitting on cost.
 *
 * **2. Free is not the same as fast.** The old "real CLI, no API key" tier
 * (`vigiles/integration`) collapses into this barrel, so the import path no longer
 * warns you that `runHarnessTest` spawns a real `claude` binary under bubblewrap
 * and can take ~40 seconds. Nothing here bills you; plenty here is slow. Duration
 * now lives where duration always lived in practice — in the runner config
 * (`--project integration`), not in the import.
 *
 * **What was lost, stated plainly:** the symmetry with the CLI verbs is now
 * one-sided. `vigiles/eval` rhymes with `vigiles eval`, but the free half answers
 * to the plain package name rather than to `vigiles test`. That is accepted, not
 * overlooked. `@playwright/test` — an end-to-end tool by definition — ships no
 * subpath naming a test type at all, and keeps the whole fast/slow/expensive
 * distinction in its config rather than in its imports.
 */

// --- reporting: how much did this script actually do? ---
// `vigiles test` can otherwise see only an exit code, so a file that runs NOTHING
// prints the same `✓` as one that ran and passed (measured 2026-08-08 on a file
// exporting an object of tests nobody calls). Call `recordCheck()` yourself when
// you assert some OTHER way — `node:assert`, vitest's `expect` — so those are
// visible to the runner too. See check-count.ts.
export { recordCheck } from "./check-count.js";

// --- the process primitives: runScript (any program) + runHook (plus a decision) ---
// `runScript` runs any program and reports what it DID (exit, both streams,
// writes, egress). `runHook` is that plus the hook protocol: event to stdin,
// exit code to allow/deny. Testing a plain helper script? Reach for runScript —
// its result carries no `decision`, because a script does not have one.
export { runScript } from "./run-script.js";
export type { RunScriptOptions, ScriptRunResult } from "./run-script.js";
export {
  runHook,
  parseHookOutput,
  decideHook,
  propertyHook,
  fileToolEvents,
  egressRoutes,
} from "./run-hook.js";
export type {
  HookRunResult,
  // Named in HookRunResult.blockedBy, so a consumer must be able to name it too
  // — a type that appears in a public signature and cannot be imported is a
  // surface you can read but not write against.
  BlockMechanism,
  RunHookOptions,
  HookInput,
  HookOutput,
  HookPropertyResult,
  FileToolEventOptions,
} from "./run-hook.js";

// --- assertions and the eval-RESULT analysis helpers (free; see cost #1 above) ---
export * from "./harness-assert.js";

// --- the EMIT delivery for a typed result (⚠️ EXPERIMENTAL) ---
// Moved here 2026-08-21 from the `vigiles/experimental` subpath, which is gone
// (the `experimental_` prefix already marks every call site; the subpath only
// marked the import line). It belongs BESIDE the assertions above rather than in
// a drawer of its own: `experimental_parseEmitted` / `experimental_assertEmittedOk`
// are the emit-channel twins of `parseAgentResult` / `assertAgentOk`, and a reader
// comparing the two delivery shapes should not have to change doors to see both.
// Read src/experimental-emit.ts's header before using it — it lists, by number,
// what is unproven and what would have to be true to drop the prefix.
export {
  experimental_emitTool,
  experimental_parseEmitted,
  experimental_assertEmittedOk,
  type EmitFieldSchema,
  type EmitObjectSchema,
  type EmitPropertySchema,
  type EmitTrackSchema,
  type EmitToolDefinition,
  type ExperimentalEmitTool,
} from "./experimental-emit.js";

// The compiled-hook LOADER. The in-process assertions above take the hook
// OBJECT, but a `.harness.mjs` test only has its PATH — without this the
// intended in-process test path is unreachable from the file format
// `vigiles test` actually runs, and authors fall back to spawning the runtime as
// a subprocess (the very plumbing compiled hooks exist to remove). Same loader
// the CLI runtime uses, so a hook that loads in a test loads identically in prod.
export { loadHook } from "./load-hook.js";

// Seed + read a compiled hook's NAMED STATE from a test. A throttled hook only
// does anything interesting against an OLD fact, and "old" is not something a
// test can produce by waiting — so without this a consumer testing a throttle
// had to reconstruct the store's private path by hand (the dogfood repo did,
// and it broke when the facts were renamed). It is on THIS barrel and not on
// `vigiles/hook` on purpose: `vigiles/hook` is the only import a compiled hook
// may have, and its guarantee is that it hands out no writer.
export { experimental_hookState } from "./hook-state-store.js";
export type { HookStateHandle, SeedStateOptions } from "./hook-state-store.js";
// Named in those signatures, so a consumer must be able to import them too — a
// type you can read in a signature but not name is a surface you cannot write
// against. (`StateFact` is what `read`/`seed` return; `Duration` is what `ago`
// takes.) They are the SAME declarations `vigiles/hook` exports.
export type { StateFact, Duration } from "./core/hook-state.js";

// --- the declarative check vocabulary ---
// Enumerated rather than `export *` ON PURPOSE: `judged` also lives in check.ts
// and its default judge is a real model call, so it is the one member of this
// module that belongs on the paid barrel (as `paid_judged`). Listing the members
// makes "a free import that can bill you" unrepresentable here rather than merely
// documented — the previous barrel carried a paragraph apologising for exactly
// that. `hookFired` is re-exported explicitly so this `Check<Trace>` wins over the
// legacy boolean predicate of the same name from harness-assert.
export {
  evalChecks,
  assertChecks,
  tool,
  toolWith,
  notTool,
  onlyTools,
  skill,
  output,
  hookFired,
  received,
  turns,
  wrote,
  didNotWrite,
  subagent,
  blocked,
  allowed,
  mcp,
  cost,
  latency,
  tokens,
  inputTokens,
  outputTokens,
  cacheTokens,
} from "./check.js";
export type {
  ArgMatcher,
  Check,
  CheckJSON,
  CheckResult,
  JudgeFn,
} from "./check.js";

// Guardrail verification — "prove your safety hook actually blocks" (over runHook).
export {
  DISASTER_CATALOG,
  verifyGuardrail,
  unblockedDisasters,
  assertBlocksDisasters,
  formatGuardrailReport,
  experimental_alternateSpellings,
} from "./guardrail-check.js";
export type {
  DisasterEvent,
  DisasterCategory,
  GuardrailResult,
  VerifyGuardrailOptions,
} from "./guardrail-check.js";

// The same battery, pointed at a DIRECTORY instead of one command string. It
// reads each hook's event, matcher, command and condition off the same
// registration, so the pairing mistake `verifyGuardrail`'s own comment has to ask
// callers to avoid ("pass the hook's declared `if` here") cannot be made. It
// belongs on THIS barrel and beside the battery for the same reason the battery
// does: nothing here calls a model.
// The report + its renderer ship together: the sweep's one motivating use is
// "point the battery at YOUR hooks", and without the formatter that is a
// hand-written fold over a discriminated union at every call site.
export {
  experimental_verifyPluginGuards,
  experimental_formatPluginGuardReport,
} from "./verify-plugin-guards.js";
export type {
  PluginGuardReport,
  SweptHook,
  SweptHookOutcome,
  // What the sweep found DECLARED but cannot drive — a `prompt`/`http`/
  // `mcp_tool`/`agent` action. Named here so `report.unmeasurable` is foldable.
  NonCommandHookAction,
  VerifyPluginGuardsOptions,
} from "./verify-plugin-guards.js";

// Tool stubs on PATH (rung R2): shadow a CLI tool with a recorded canned result.
export * from "./tool-stub.js";

// The assembled machine — AGNOSTIC SURFACE ONLY. The Claude-Code transport
// (`scriptModel`, `claudeCodeDriver`, `buildClaudeArgs`, `claudeAvailable`,
// `loadPlugin`, `resolveHarness`) is deliberately NOT re-exported here, so this
// surface stays harness-agnostic — import those from `vigiles/claude-code` (or
// your harness's package). See `research/code-adapter-architecture.md`.
// Slow but free: see cost #2 in the module doc.
export {
  runHarnessTest,
  runHarness,
  parseToolCalls,
  parseSubagents,
  parseResultEvent,
  parseOutput,
  parseHooks,
  decideSandbox,
  specTrusted,
  sandboxAvailable,
} from "./harness-test.js";
export type {
  HarnessTestSpec,
  Trace,
  SubagentTrace,
  HarnessTestResult,
  RunHarnessTestOptions,
  ModelTurn,
  ModelRequest,
  ToolCall,
  HookFire,
  HarnessTestDriver,
  SandboxMode,
} from "./harness-test.js";

// A document's own rule about its own COMMANDS, made checkable. vigiles cannot
// infer "always pass -g" from prose; what was missing was a cheap way to declare
// it — measured at ~95 lines of markdown parsing around ~5 lines of rule, which
// is why nobody wrote the check and the rule stayed prose.
export { commandsIn, mustInclude, mustNotInclude } from "./doc-commands.js";
export type { DocCommand } from "./doc-commands.js";

// A skill's own `allowed-tools:` frontmatter, read back as checks — the wiring
// from a declaration to the existing check vocabulary, not new machinery.
export { skillContract } from "./skill-contract.js";
export type { SkillContract, SkillContractOptions } from "./skill-contract.js";

// Is a WEAKER model a valid lower bound for trigger-rate? Pure comparison of two
// runs; the open question the model floor makes people ask.
export {
  compareContainment,
  formatContainment,
} from "./trigger-containment.js";
export type {
  ContainmentInput,
  ContainmentVerdict,
} from "./trigger-containment.js";

// --- declaring an eval (free: a description cannot spend) ---
// `defineEval` is on the FREE barrel and not on `vigiles/eval`, and that is the
// point rather than an oversight: after this shape an eval file needs nothing
// that bills. It describes the run; `vigiles eval` performs it. The paid runners
// moved out of an eval author's vocabulary entirely.
export { defineEval } from "./eval-define.js";
export type {
  EvalDefinition,
  EvalDefinitionInput,
  EvalHooks,
  EvalKind,
  EvalMeasurements,
  EvalReports,
  SelectionMatrixSpec,
} from "./eval-define.js";

// --- free analysis OVER eval results (the coupling from cost #1) ---
// These read a report that `vigiles/eval` produced. They spend nothing, so they
// live here and carry no `paid_` prefix; their argument types are defined over
// there, so those types are re-exported below from this barrel too.
export {
  assertRates,
  assertPromptDiversity,
  checkPromptDiversity,
  checkReportToJUnit,
  formatCheckReport,
  formatEvalReport,
  formatTriggerRateReport,
  parseClaudeRun,
  stubSkillBody,
} from "./eval.js";
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

// --- R3: the disposable-service tier (⚠️ EXPERIMENTAL, and it has REAL EFFECTS) ---
// Moved off the `vigiles/experimental` subpath 2026-08-21, when that subpath was
// deleted: it marked the IMPORT LINE, which is out of view by the time anyone
// reads the call, while `experimental_` marks every call site.
//
// 🔴 IT LANDED ON `vigiles/eval` FIRST, AND THE EXPORT-PREFIX GATE REJECTED IT —
// correctly, and the reasoning is worth keeping. `./eval` has a naming contract:
// every runtime export there is `paid_*`, meaning THIS CALL CAN BILL YOU. R3 felt
// like it belonged because the docs frame it as measuring skills for real. But
// `experimental_startServices` takes a `ContainerRuntime` and starts containers;
// it calls no model. Naming it `paid_experimental_startServices` to satisfy the
// gate would have made `paid_` mean "expensive in some sense", which is exactly
// the erosion that turns a prefix back into decoration. The model spend is in
// `paid_measureArms`, which is already over there. So R3 is free-of-model-cost
// and belongs on this door — where "free" keeps its narrow meaning.
//
// ⚠️ FREE OF MODEL COST IS NOT FREE OF CONSEQUENCE, and this is the one place the
// root barrel carries something with real side effects. The disposable container
// is the ONLY isolation vigiles provides — it does NOT confine the skill's
// filesystem or network. Run it somewhere disposable with no production access
// and keep real credentials out of the run. See the SAFETY note in src/services.ts.
export {
  experimental_startServices,
  experimental_withServices,
  type ServiceSpec,
  type ServiceReady,
  type ServiceReset,
  type ServiceHandle,
  type ServiceSession,
  type ContainerRuntime,
} from "./services.js";

export {
  experimental_dockerRuntime,
  experimental_makeDockerRuntime,
  type DockerExec,
  type NetProbe,
} from "./services-docker.js";
