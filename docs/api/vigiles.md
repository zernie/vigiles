# `vigiles` — the free testing entry

```ts
import { runHook, runHarnessTest, check, assertChecks } from "vigiles";
```

**Who it is for:** anyone who tests an agent harness — hooks, skills, settings, instruction files, the assembled agent — and wants it to run on every commit. Nothing on this entry calls a model, so nothing on it bills you. (Free is not the same as fast: `runHarnessTest` starts the real harness binary and can take tens of seconds.)

The paid half lives on [`vigiles/eval`](eval.md). Writing a spec is [`vigiles/spec`](spec.md). Testing a compiled hook in process is [`vigiles/hook/testing`](hook-testing.md). The index of every entry is [the API index](README.md).

Signatures, option fields and return types are not repeated here — see the [API reference](https://zernie.github.io/vigiles/api/) (generated from the source, one section per entry). This page tells you which name to reach for and shows the shape of the call.

## Typical tasks

Every task has the same three steps: run something, read it with `check.*`, and throw with `assertChecks`.

### Check that a hook blocks an event

`runHook` pipes a JSON event to your hook command as a real subprocess and reports the exit code and decision. No harness binary, no model.

```ts
import { runHook, check, assertChecks } from "vigiles";

const r = runHook(
  '"$GUARD"',
  {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit --no-verify" },
  },
  { env: { GUARD: guardPath } },
);

assertChecks(r, [check.hook("PreToolUse", { blocked: true })]);
```

### Check that a helper script does what it claims

`runScript` runs any program and reports what it did: exit code, both streams, files written, egress attempts.

```ts
import { runScript, check, assertChecks } from "vigiles";

const r = runScript("node scripts/release-notes.mjs", { timeoutMs: 10_000 });

assertChecks(r, [
  check("exits 0", (run) => run.exitCode === 0),
  check("prints a heading", (run) => run.stdout.startsWith("# ")),
]);
```

### Check the assembled harness

`runHarnessTest` drives the real harness binary against a **scripted** model, so hooks, settings and skills are loaded exactly as they ship, and what the "model" does is fixed by your script.

```ts
import { runHarnessTest, check, assertChecks } from "vigiles";

const r = await runHarnessTest({
  pluginDir: "./my-plugin",
  prompt: "tidy the repo",
  // A tool call ends its turn, so the script needs a final answer after it.
  model: [
    { tool: "Bash", input: { command: "git push --force" } },
    { text: "done" },
  ],
  transcript: true,
});

assertChecks(r, [
  check.hook("PreToolUse", { blocked: true }),
  check.tool("Bash", { with: { command: /git push/ } }),
]);
r.cleanup();
```

### Check a skill against its own `allowed-tools:`

`readSkillContract` reads a skill's `SKILL.md` frontmatter and returns ready checks, so the tools the skill claims are verified instead of restated. A skill with no `allowed-tools:` line, or with frontmatter that is not valid YAML, gets a `surface` check that fails.

```ts
import { readSkillContract, runHarnessTest, assertChecks } from "vigiles";

const c = readSkillContract("skills/my-skill"); // a plugin skill; c.id is "<plugin>:my-skill"
const trace = await runHarnessTest({
  pluginDir: ".",
  prompt: "/my-skill",
  transcript: true, // tool calls are only captured from the stream
  allowedTools: [`Skill(${c.id})`, "Read"], // headless runs ask before a skill runs
  // The scripted model loads the skill (by its full id), uses a tool, then answers.
  // An empty script would overrun on the first request and never reach the checks.
  model: [
    { tool: "Skill", input: { skill: c.id } },
    { tool: "Read", input: { file_path: "README.md" } },
    { text: "done" },
  ],
});
assertChecks(trace, [c.activation, ...c.surface]);
```

### Use checks inside vitest or jest

Import [`vigiles/vitest` or `vigiles/jest`](matchers.md) once and `expect(r).toPass(check)` carries the check's own failure message. Without them, `assertChecks` works in any runner, including `node:test`.

### Declare an eval

`defineEval` describes what a `*.eval.mjs` file measures; `npx vigiles eval` runs it. The file imports nothing that bills.

```ts
import { defineEval, check } from "vigiles";

export default defineEval({
  runEval: {
    env: { kind: "ephemeral" },
    task: "Write hello.txt containing 'hi'",
    trials: 3,
    checks: [check.writes({ include: ["hello.txt"] })],
  },
});
```

The model-calling runners and report readers are on [`vigiles/eval`](eval.md).

### Count what a script asserted

`vigiles test` sees only an exit code. If you assert some other way (`node:assert`, `expect`), call `recordCheck()` so a file that checks nothing is not reported as a pass; call `skip(reason)` to mark a script loudly skipped.

## How checks work

**One form.** Everything you assert about a run is a **check** — a value that
evaluates to pass/fail with an actionable message — and `assertChecks` throws,
listing every check that failed. It works in `node:test`, vitest, jest, or any
runner. Beyond a single tool you can assert on sequence, budget and arguments,
and `check(name, fn)` names anything else:

```ts
import { runHarnessTest, check, assertChecks } from "vigiles";

assertChecks(r, [
  check.toolSequence(["Read", "Edit"]), // ordering — Read before Edit
  check.tool("Write", { max: 1 }), // budget — no runaway writes
  check.tool("Edit", { with: { file_path: "src/billing.ts" } }), // argument
  check.tool("Bash", { with: { command: /git push/ }, max: 0 }), // never pushed
  check.hook("UserPromptSubmit"),
  check.output(/on it/),
  check.writes({ include: ["DONE"] }), // a file was created
  check(
    "every Edit follows a Read",
    (t) => /* any rule over t.toolCalls */ true,
  ),
]);

assertChecks(hookResult, [check.hook("PreToolUse", { blocked: true })]); // exit 2 / decision:"block" / permissionDecision:"deny"
```

Want a boolean instead of a throw — in a `measure`, say? A check's verdict is
`check.skill("demo:greet").eval(trace).pass`; `fired:` takes the check itself.

What a hook or script run did beyond its decision is a check too:
`check.delivered()` (its text REACHED the model, not just stderr — see
[harness-testing.md](../harness-testing.md#assert-a-nudge-reaches-the-model-checkdelivered)),
`check.egress({ only: [...] })` over a confined run's egress, and
`check.writes({ only, none, include })` over its file writes.

**`check.writes` reads both kinds of run, and refuses what one cannot answer.**
A hook or script run records `filesWritten`, the full list, so it takes
`only` ("nothing but these"), `none` and `include`, each a list of exact paths
or RegExps. An agent run can only look a path up in its work dir, so it takes
`include` / `none` with exact paths: `only`, or a RegExp, against a `Trace` is a
TypeScript error, and a JavaScript caller gets a failing check naming why —
never a pass that inspected nothing.

The flat check functions (`tool`, `skill`, `wrote`, …), the `assertToolUsed`-style
functions and the boolean predicates (`usedTool`, `skillResolved`, …) were removed
in v50 — each is one `check.*` member; the
[migration table](../testing-api.md#migrating-to-the-v50-assertion-form) lists them.

A `runHarnessTest` result owns its temp directory. Remove it in a `finally` with
`r.cleanup()`, or let TypeScript (5.2+) or Node 24+ do it for you:
`await using r = await runHarnessTest(spec)` disposes the result when it leaves
scope, even when an assertion throws.

To prove a guard blocks every disaster and allows the same text as data, use
the guard battery on [`vigiles/hook/testing`](hook-testing.md):
`assertChecks(runGuardrail("bash hooks/guard.sh"), [guardrail()])`.

### Strict and scored

A **check** is data, not a throwing assert: `check.tool("Bash")` is an object that knows
how to `eval` itself against a `Trace` (or a hook decision) and `toJSON`. The same
check is evaluated two ways — write the assertion once:

```ts
import { assertChecks, check } from "vigiles";

// STRICT (deterministic tiers): throws, collecting ALL failures with messages.
assertChecks(await runHarnessTest(spec), [
  check.tool("Bash"),
  check.output(/done/),
]);
assertChecks(runHook(cmd, event), [
  check.hook("PreToolUse", { blocked: true }),
]);

// SCORED (eval): the SAME checks, as a rate ± se across trials. An eval file
// describes the run; `npx vigiles eval <file>` spends the money.
// reading the report (assertRates) is free
import { defineEval } from "vigiles";
import { assertRates } from "vigiles/eval";
export default defineEval({
  runEval: {
    env: { kind: "ephemeral" },
    pluginDir: "./my-plugin", // or skillsDir: ".claude/skills" (loose, auto-packaged)
    task: "…",
    checks: [check.skill("vigiles:test-harness")],
    stubSkillBodies: true, // firing check: stub bodies → a fraction of the tokens
    trials: 10,
    model: "sonnet",
  },
  assert: (report) => {
    assertRates(report, { min: 0.8 }); // gate the rate, not one noisy run
    assertRates(report, { passK: 1 }); // or: every check passed on EVERY trial
  },
});
```

A check's **failure message is the product** (`expected the agent to use tool
"Bash", but it used [Read, Edit]`), and because it serializes, CI reports and
regression baselines fall out for free.

**The vocabulary** — every check is a member of the one callable `check` object
from `vigiles` (type `check.` and the editor lists them; the table is under
[the members of `check`](#the-members-of-check)), and `check(name, fn)` names
your own. The exception is `paid_judged`, which calls a model and so lives on
[`vigiles/eval`](eval.md).

With `arms`, a `runEval` of `{ arms, checks }` scores the same checks per arm (a
hook/skill/rule **on vs off**): each check is one metric keyed by its label, so
`report.arms[name].metrics["tool(Bash)"]` lines up across arms and
`compare(report, "off", "on")` reads each one. It takes `stubSkillBodies` too.

## Every export

Names in `code` are the exact export names. Every name below is exported from `vigiles`.

### Run something

| Name               | What it is                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `runHook`          | Run a hook command on a synthesized event as a subprocess; returns a `HookRunResult`.              |
| `runScript`        | Run any program and report exit code, streams, files written and egress.                           |
| `runHarnessTest`   | Drive the real harness binary against a scripted model; returns a `HarnessTestResult` (a `Trace`). |
| `sandboxAvailable` | `true` when this machine can confine a run (the bubblewrap backend).                               |
| `makeTmpDir`       | A temp directory whose two path spellings agree (macOS `/var` vs `/private/var`).                  |
| `cleanupTmpDir`    | Remove a directory made by `makeTmpDir`.                                                           |

### Assert

| Name              | What it is                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `check`           | The one callable object holding every assertion about a run; `check(name, fn)` names your own. |
| `assertChecks`    | Evaluate a list of checks against a result and throw, listing every one that failed.           |
| `recordCheck`     | Tell `vigiles test` that your script asserted something by other means.                        |
| `skip`            | Mark the current harness or eval script as skipped (exit 77) so it is not reported as a pass.  |
| `vigilesMatchers` | The matcher table for `expect.extend`; the [matcher entries](matchers.md) register it for you. |

### Read a declaration

| Name                | What it is                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `readSkillContract` | Read a skill's `allowed-tools:` frontmatter and return a `SkillContract`: an `activation` check and `surface` checks. |

### The members of `check`

| Check                                                  | Holds when…                                                                               | Over                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------- |
| `check.tool(name)`                                     | the agent used that tool                                                                  | Trace                     |
| `check.tool(name, { min, max })`                       | that tool was used a number of times in bounds (`{ max: 0 }`: never)                      | Trace                     |
| `check.tool(name, { with: args })`                     | a call's input matched `args` (with `max: 0`, no call did)                                | Trace                     |
| `check.onlyTools([a, b])`                              | the agent used only tools from that allow-list (names, not arguments)                     | Trace                     |
| `check.toolSequence([a, b])`                           | those tools ran in that order (gaps allowed)                                              | Trace                     |
| `check.runs(program, { force? })`                      | a shell command ran `program` — read by the compiled-hook parser, any spelling            | Trace                     |
| `check(name, fn)`                                      | your own predicate holds — named, serialized and scored like the rest                     | anything                  |
| `check.skill(id)`                                      | the skill `id` resolved (no error), as the harness's adapter reports it                   | Trace                     |
| `check.mcp(server, tool)`                              | the agent used `mcp__server__tool`                                                        | Trace                     |
| `check.subagent(name, [checks])`                       | the `Task` subagent ran + passed nested checks                                            | Trace (nested)            |
| `check.output(str \| /re/)`                            | the final answer contains/matches (`{ eachReply: true }`: every reply does)               | Trace                     |
| `check.received(str \| /re/)`                          | text reached the model (slash-command / injected)                                         | Trace (mock)              |
| `check.hook(event \| /re/, { blocked? })`              | a hook fired for that event or label (and blocked / allowed)                              | Trace or `runHook` result |
| `check.turns({ min, max, matching? })`                 | the agent took N turns (with `matching`: N replies matched)                               | Trace                     |
| `check.writes({ include, none })`                      | a file is / is not at each exact path in the work dir                                     | Trace or confined run     |
| `check.experimental_agentResult(expect, contract?)`    | the output ends with a result block on the `"ok"` / `"err"` track, or meets a predicate   | Trace                     |
| `paid_judged(rubric, {…})`                             | a model grades the output ≥ `min` (LLM rubric)                                            | Trace (eval)              |
| `check.cost({ maxUsd })` / `check.latency({ maxMs })`  | the run stayed under budget                                                               | run usage (eval)          |
| `check.tokens({ max, maxInput, maxOutput, maxCache })` | each given token class stayed under its cap (total, fresh input, output, prompt cache)    | run usage (eval)          |
| `check.delivered()`                                    | the hook's text reached the model (not just stderr)                                       | `runHook` result          |
| `check.egress({ only: [...] })` / `({ none: true })`   | every egress attempt went to an allowed host; `none` = no egress at all                   | confined run              |
| `check.writes({ only, none, include })`                | every write is in `only`; none in `none`; each of `include` written (fails if unrecorded) | confined run              |

### Declare an eval

| Name         | What it is                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineEval` | Declare what an eval file measures: exactly one of `runEval`, `measureTriggerRate`, `measureSelectionMatrix` (the keys keep their names; the runners they call are `paid_*`). |

### Typed results, emit channel (experimental)

| Name                           | What it is                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `experimental_emitTool`        | Build the tool definition a subagent calls to deliver a typed result.      |
| `experimental_parseEmitted`    | Read a typed result out of a run's tool calls.                             |
| `experimental_assertEmittedOk` | Throw unless the emitted result is on the `ok` track, narrowing the value. |

The types below describe these: `EmitFieldSchema`, `EmitObjectSchema`, `EmitPropertySchema`, `EmitTrackSchema`, `EmitToolDefinition`, `ExperimentalEmitTool`.

### Types: results of a run

| Type                  | What it describes                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScriptRunResult`     | What `runScript` returns.                                                                                                                               |
| `HookRunResult`       | What `runHook` returns: a script result plus decision, `blocked`, delivery.                                                                             |
| `HarnessTestResult`   | What `runHarnessTest` returns; a `Trace` that owns its temp directory.                                                                                  |
| `Trace`               | The record of one agent run: tool calls, hooks, skills, output, turns.                                                                                  |
| `SubagentTrace`       | The part of a trace belonging to one subagent.                                                                                                          |
| `ToolCall`            | One tool call with its input and result.                                                                                                                |
| `HookFire`            | One hook invocation seen in a run.                                                                                                                      |
| `SkillFire`           | One skill activation.                                                                                                                                   |
| `SkillFacts`          | Which skills fired, or why the harness cannot tell.                                                                                                     |
| `ModelRequest`        | What the harness sent to the scripted model.                                                                                                            |
| `ModelTurn`           | One scripted model turn: text, or a tool call.                                                                                                          |
| `ContextEvidence`     | Whether expected context files reached the model's first request.                                                                                       |
| `UnobservableWhy`     | Why context delivery could not be observed.                                                                                                             |
| `RunContext`          | What an eval `measure` or check callback receives for each trial.                                                                                       |
| `RepoWorkspace`       | A commit of your own repo as every trial's world ([`experimental_workspace`](eval.md#run-the-trials-in-your-own-repository-experimental_workspace)).    |
| `TrialWorkspaceView`  | A workspace trial's tree from before the agent ran, for diffing its edits (same section).                                                               |
| `RegressionCaseEntry` | One fix of your own repo as a scored case ([`experimental_regressionCases`](eval.md#measure-the-agent-on-your-own-fixes-experimental_regressioncases)). |
| `RegressionCaseSpec`  | The fields of a case besides its `id` (same section).                                                                                                   |
| `CaseResult`          | One case in the report: its commits, paths, controls and each arm's result (same section).                                                              |
| `CaseArmResult`       | One arm on one case: `solved`, `scored`, `unscored` (same section).                                                                                     |

### Types: inputs and options

| Type                    | What it describes                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `HarnessTestSpec`       | The input of `runHarnessTest`.                                                     |
| `RunHarnessTestOptions` | Its second argument; selects the harness adapter.                                  |
| `RunScriptOptions`      | Options of `runScript` (cwd, env, stdin, sandbox, egress).                         |
| `RunHookOptions`        | Options of `runHook`.                                                              |
| `HookInput`             | The event object piped to a hook.                                                  |
| `HookOutput`            | The JSON a hook may print.                                                         |
| `SandboxMode`           | `"auto"`, `"strict"` or `false`.                                                   |
| `RunEnv`                | Where an eval trial runs: an ephemeral directory, or a stated inherit.             |
| `HomeSeed`              | Files seeded into an ephemeral HOME.                                               |
| `HomeFiles`             | Path-to-contents map used by `HomeSeed`.                                           |
| `SkillContract`         | What `readSkillContract` returns: ready checks built from the skill's frontmatter. |
| `SkillContractOptions`  | Options of `readSkillContract`.                                                    |

### Types: hook delivery

| Type              | What it describes                                              |
| ----------------- | -------------------------------------------------------------- |
| `HookDelivery`    | Whether a hook's text reached the model, and by which channel. |
| `DeliveryChannel` | A channel a hook's text can travel by.                         |
| `StrandedOutput`  | Hook output that went nowhere the model reads.                 |
| `BlockMechanism`  | How a hook blocked: exit code, decision field, halt.           |

### Types: checks

| Type                     | What it describes                                                     |
| ------------------------ | --------------------------------------------------------------------- |
| `Check`                  | One declarative assertion over a result.                              |
| `CheckResult`            | The verdict of evaluating a check: pass flag and message.             |
| `CheckJSON`              | A check serialized to JSON.                                           |
| `ArgMatcher`             | Argument patterns for `check.tool({ with })`.                         |
| `ToolOptions`            | Options of `check.tool`.                                              |
| `HookFiredOptions`       | Options of `check.hook`.                                              |
| `OutputOptions`          | Options of `check.output`.                                            |
| `TurnsOptions`           | Options of `check.turns`.                                             |
| `WritesOptions`          | Options of `check.writes` on a recorded run.                          |
| `PathWritesOptions`      | Options of `check.writes` on an agent run.                            |
| `WritePath`              | An exact path or a RegExp.                                            |
| `TokenBudget`            | Caps of `check.tokens`.                                               |
| `JudgeFn`                | The grader function type behind model-judged checks.                  |
| `AgentResultExpectation` | `"ok"`, `"err"` or a predicate, for `check.experimental_agentResult`. |
| `ParsedAgentResult`      | The parsed result block a predicate receives.                         |

### Types: tool stubs

| Type          | What it describes                                         |
| ------------- | --------------------------------------------------------- |
| `ToolStub`    | A fake command placed on PATH, with its rules.            |
| `StubRule`    | One rule: an argument pattern and a reply.                |
| `StubReply`   | A reply that is always the same, or answers in order.     |
| `StubAnswer`  | Stdout, stderr and exit code of one answer.               |
| `StubCall`    | One recorded invocation of a stub.                        |
| `StubOutcome` | Whether a call was answered, matched no rule, or ran out. |
| `ArgvPattern` | The argument pattern of a rule.                           |
| `ArgvToken`   | One token of a pattern: a string or a RegExp.             |
| `ArgvRest`    | Marker that allows any remaining arguments.               |

### Types: evals

| Type                  | What it describes                                                         |
| --------------------- | ------------------------------------------------------------------------- |
| `EvalDefinition`      | What `defineEval` returns.                                                |
| `EvalDefinitionInput` | What `defineEval` accepts.                                                |
| `EvalHooks`           | `skipIf` and the report assertion of an eval file.                        |
| `EvalKind`            | The three measurement keys.                                               |
| `EvalMeasurements`    | The measurement shapes an eval file may declare.                          |
| `EvalReports`         | The report type each measurement produces.                                |
| `SelectionMatrixSpec` | Input of the selection-matrix measurement.                                |
| `EvalSpec`            | One task over trials: `arms` or one, `checks` or `measure`.               |
| `EvalArm`             | One arm of an A/B.                                                        |
| `ExecutionSpec`       | Where an eval's attempts run: the host, or a container per attempt.       |
| `ContainerOptions`    | The container settings an eval may pass: image, limits, network, tmpfs.   |
| `TriggerRateSpec`     | Whether a skill's description fires, over a prompt set.                   |
| `Metrics`             | The metric record an eval callback returns.                               |
| `EvalReport`          | The report of `paid_runEval` (eval key `runEval`), however it was scored. |
| `ArmReport`           | Per-arm figures inside a report.                                          |
| `ArmUsage`            | Cost and token totals of an arm.                                          |
| `EvalUsage`           | Cost, duration and token counts of one run.                               |
| `MetricStat`          | Mean, spread and sample size of one metric.                               |
| `TriggerRateReport`   | Recall and precision of a skill description.                              |
| `PromptTriggerStat`   | How often one prompt fired the skill.                                     |

Reading these reports (`compare`, `assertRates`, `assertImproves`, `assertNoRegression`) is on [`vigiles/eval`](eval.md).
