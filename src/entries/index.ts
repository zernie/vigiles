// 🔴 PUBLIC ENTRY POINT `vigiles` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles.api.md`, which
// `npm run api:check` fails on.
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
 * exactly two doors: this one, and [`vigiles/eval`](./eval.ts).
 *
 * ## What replaced what
 *
 * The old split was by TEST TIER — `vigiles/unit`, `vigiles/integration`,
 * `vigiles/e2e`, `vigiles/testing`. Tiers are a property of test-file layout and
 * runner config, not of a module graph: this repo already expresses them as
 * vitest projects (`test:unit`, `test:integration`, `test:e2e`), so the exports
 * map was a second, competing implementation of the same idea. `src/e2e.ts` had
 * degenerated to `export * from "../integration.js"` — a barrel adding zero
 * symbols, which its own docstring called "the definition of a non-tier".
 *
 * ## One home per name (v50)
 *
 * Every public name lives behind exactly one door, the door of the reader who
 * uses it. What left this barrel, and where it went:
 *
 *   - reading an eval REPORT (`compare`, `assertRates`, `assertImproves`,
 *     `assertNoRegression`) → `vigiles/eval`, beside the `paid_*` runners that produce the report.
 *     `paid_`, not the door, marks a call that can bill you.
 *   - the guard battery (`runGuardrail`, `guardrailHolds`, …) →
 *     `vigiles/hook/testing`.
 *   - testing a compiled hook in-process (`experimental_loadHook`, `experimental_assertHookDenies`, …) →
 *     `vigiles/hook/testing` (never `vigiles/hook`, a compiled hook's only import).
 *   - a subagent's outcome as a value (`experimental_assertAgentOk`, which
 *     throws so the result narrows) → `vigiles/spec`; as a check,
 *     `check.experimental_agentResult` stays here (v52).
 *   - Claude Code's stream parsers (`parseToolCalls`, `parseClaudeRun`) →
 *     `vigiles/harness/claude-code`; the driver PORT types (`HarnessTestDriver`,
 *     `EvalDriver`, …) → `vigiles/harness/kit`.
 *
 * The report TYPES stay here: `defineEval` and `vigilesMatchers` speak them. They
 * are declared in core, which this barrel and `vigiles/eval` both import; no
 * module imports this barrel (src/export-surface.test.ts holds that).
 *
 * ## An honest cost of the split
 *
 * **Free is not the same as fast.** The old "real CLI, no API key" tier
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
export { recordCheck } from "../check-count.js";

// --- fixture roots: a temp directory whose two spellings agree ---
// 🔴 DO NOT hand-roll `mkdtempSync(join(tmpdir(), …))` in a harness. On macOS
// `/var` is a symlink to `/private/var`, so that shape hands you a directory with
// TWO spellings: Node resolves a module's own URL to the realpath but leaves
// `process.argv[1]` and any path you composed as typed. Every assertion that
// compares them is then red on macOS and green on Linux, for a reason that
// belongs to neither the test nor the code under test — measured three times in
// one consumer suite (#241, zernie/research-paper-pipeline#9).
//
// `makeTmpDir` resolves the root once, at creation. The trap is unreachable from
// anything built under it, including a symlink the harness creates ITSELF to test
// symlink handling — that stays a genuine test, because it is explicit.
export { makeTmpDir, cleanupTmpDir } from "../core/tmp-root.js";

// --- the process primitives: runScript (any program) + runHook (plus a decision) ---
// `runScript` runs any program and reports what it DID (exit, both streams,
// writes, egress). `runHook` is that plus the hook protocol: event to stdin,
// exit code to allow/deny. Testing a plain helper script? Reach for runScript —
// its result carries no `decision`, because a script does not have one.
export { runScript } from "../run-script.js";
export type { RunScriptOptions, ScriptRunResult } from "../run-script.js";
export { runHook } from "../run-hook.js";
export type {
  HookRunResult,
  // Named in HookRunResult.blockedBy, so a consumer must be able to name it too
  // — a type that appears in a public signature and cannot be imported is a
  // surface you can read but not write against.
  BlockMechanism,
  // Named in HookRunResult.delivery — same reason as BlockMechanism above.
  HookDelivery,
  DeliveryChannel,
  StrandedOutput,
  RunHookOptions,
  HookInput,
  HookOutput,
} from "../run-hook.js";

// --- runner glue: `skip` a script loudly, `vigilesMatchers` for expect.extend ---
export { skip, vigilesMatchers } from "../harness-assert.js";

// --- the EMIT delivery for a typed result (⚠️ EXPERIMENTAL) ---
// Moved here 2026-08-21 from the `vigiles/experimental` subpath, which is gone
// (the `experimental_` prefix already marks every call site; the subpath only
// marked the import line). It belongs BESIDE the assertions above rather than in
// a drawer of its own: `experimental_parseEmitted` / `experimental_assertEmittedOk`
// are the emit-channel twins of `parseAgentResult` / `experimental_assertAgentOk`, and a reader
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
  // eslint-disable-next-line local/no-group-names -- the type of the experimental_emitTool export, not a rule group
  type ExperimentalEmitTool,
} from "../experimental-emit.js";

// --- the declarative check vocabulary: ONE callable object ---
// Every assertion about a run is a member of `check` — `check.tool("Bash")`,
// `check.hookFired("PreToolUse", { blocked: true })`, `check.delivered()`,
// `check("name", fn)` — and `assertChecks` throws listing every one that
// failed. There are no flat check functions here (v50): one name for the whole
// vocabulary keeps the root to its verbs, and an editor completes `check.` to
// the full list. `judged` is the one check that bills, so it lives on the paid
// door as `paid_judged`. A member takes OPTIONS rather than spawning a sibling
// (v52): `check.tool(name, { with, max: 0 })`, `check.writes({ only, none })`,
// `check.turns({ matching })`, `check.output(m, { eachReply: true })`.
export { assertChecks, check } from "../check.js";
export type {
  AgentResultExpectation,
  ArgMatcher,
  Check,
  CheckJSON,
  CheckResult,
  HookFiredOptions,
  JudgeFn,
  OutputOptions,
  PathWritesOptions,
  TokenBudget,
  ToolOptions,
  TurnsOptions,
  WritePath,
  WritesOptions,
} from "../check.js";
// The parsed vigiles:ok / vigiles:err block `check.experimental_agentResult`'s
// predicate receives.
export type { ParsedAgentResult } from "../core/agent-result.js";

// The guard battery ("does my guard block every disaster and let the same text
// through as data?") is its own door, `vigiles/hook/testing`: it has its own reader —
// someone proving a guard — and its own vocabulary.

// Tool stubs on PATH (rung R2): `experimental_stub` builds them and lives on
// `vigiles/fixtures` with the other test infrastructure. The rule shapes stay
// here because `EvalSpec.stubs` speaks them; they are plain data, since a `.mjs`
// literal of the same shape is accepted at the spec boundary.
// The element type of `ArmReport.context` (vigiles#416).
export type {
  ContextEvidence,
  UnobservableWhy,
} from "../core/context-evidence.js";
export type {
  ArgvPattern,
  ArgvRest,
  ArgvToken,
  StubAnswer,
  StubCall,
  StubOutcome,
  StubReply,
  StubRule,
  ToolStub,
} from "../core/stub-rules.js";
// Where an eval trial runs (`EvalSpec.env`).
export type { HomeFiles, HomeSeed, RunEnv } from "../core/run-env.js";

// The assembled machine — AGNOSTIC SURFACE ONLY. The Claude-Code transport
// (`scriptModel`, `claudeCodeDriver`, `buildClaudeArgs`, `claudeAvailable`,
// `loadPlugin`, `resolveHarness`) is deliberately NOT re-exported here, so this
// surface stays harness-agnostic — import those from `vigiles/harness/claude-code` (or
// your harness's package). See `research/code-adapter-architecture.md`.
// Slow but free: see the module doc.
export { runHarnessTest, sandboxAvailable } from "../harness-test.js";
// The two arms of an output-style eval (`experimental_outputStyleArms`) are on
// `vigiles/eval`: what they build is eval arms.
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
  SandboxMode,
} from "../harness-test.js";
// Named in `Trace.skills`: which skills fired, as the harness's adapter tells.
export type { SkillFire, SkillFacts } from "../core/harness-driver.js";

// A skill's own `allowed-tools:` frontmatter, read back as checks: reached as
// `check.skillContract(dir)`, since what it builds is checks.
export type { SkillContract, SkillContractOptions } from "../skill-contract.js";

// --- declaring an eval (free: a description cannot spend) ---
// `defineEval` is on the FREE barrel and not on `vigiles/eval`, and that is the
// point rather than an oversight: after this shape an eval file needs nothing
// that bills. It describes the run; `vigiles eval` performs it. The paid runners
// moved out of an eval author's vocabulary entirely.
export { defineEval } from "../eval-define.js";
export type {
  EvalDefinition,
  EvalDefinitionInput,
  EvalHooks,
  EvalKind,
  EvalMeasurements,
  EvalReports,
  SelectionMatrixSpec,
} from "../eval-define.js";

// --- the shapes an eval speaks ---
// The paid runners and the report readers are on `vigiles/eval`; the TYPES are
// here, because `defineEval` and `vigilesMatchers` speak them too and a type
// cannot bill anyone. The report shapes come from core (`src/core/eval-report.ts`),
// which both doors import — neither imports the other's barrel.
export type {
  ArmReport,
  ArmUsage,
  EvalReport,
  MetricStat,
  PromptTriggerStat,
  TriggerRateReport,
} from "../core/eval-report.js";
export type {
  EvalArm,
  EvalSpec,
  EvalUsage,
  MeasureSpec,
  ArmsMeasureSpec,
  ArmsCheckReport,
  CheckRate,
  CheckReport,
  Metrics,
  RunContext,
  TriggerRateSpec,
} from "../eval.js";

// --- R3: the disposable-service tier ---
// `experimental_startServices` and `experimental_dockerRuntime` live on
// `vigiles/fixtures`: they set up what a run talks to, which is test
// infrastructure, not a verb over a run. They first landed on `vigiles/eval` and
// the export-prefix gate rejected them there, rightly: every runtime export on
// `./eval` is `paid_*` (this call can bill you), and starting a container calls
// no model.
