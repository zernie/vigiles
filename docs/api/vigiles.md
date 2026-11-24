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

assertChecks(r, [check.hookFired("PreToolUse", { blocked: true })]);
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
  model: [{ tool: "Bash", input: { command: "git push --force" } }],
  transcript: true,
});

assertChecks(r, [
  check.hookFired("PreToolUse", { blocked: true }),
  check.tool("Bash", { with: { command: /git push/ } }),
]);
r.cleanup();
```

### Use checks inside vitest or jest

Import [`vigiles/vitest` or `vigiles/jest`](matchers.md) once and `expect(r).toPass(check)` carries the check's own failure message. Without them, `assertChecks` works in any runner, including `node:test`.

### Declare an eval

`defineEval` describes what a `*.eval.mjs` file measures; `npx vigiles eval` runs it. The file imports nothing that bills.

```ts
import { defineEval, check } from "vigiles";

export default defineEval({
  measure: {
    task: "Write hello.txt containing 'hi'",
    trials: 3,
    checks: [check.writes({ include: ["hello.txt"] })],
  },
});
```

The model-calling runners and report readers are on [`vigiles/eval`](eval.md).

### Count what a script asserted

`vigiles test` sees only an exit code. If you assert some other way (`node:assert`, `expect`), call `recordCheck()` so a file that checks nothing is not reported as a pass; call `skip(reason)` to mark a script loudly skipped.

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

### The members of `check`

| Member                           | Holds when…                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `check.tool`                     | the agent used a tool (`min`, `max`, `with` bound count and arguments).          |
| `check.toolSequence`             | tools ran in the given order, gaps allowed.                                      |
| `check.onlyTools`                | the agent used only tools from an allow-list ("nothing but these").              |
| `check.runs`                     | a shell command ran a program, read by the compiled-hook shell parser.           |
| `check.skill`                    | a skill resolved without error, as the harness reports it.                       |
| `check.skillContract`            | builds checks from a skill's own `allowed-tools:` frontmatter.                   |
| `check.mcp`                      | the agent used an MCP server's tool.                                             |
| `check.subagent`                 | a subagent ran and passed nested checks.                                         |
| `check.output`                   | the final answer matches (`eachReply` demands every reply does).                 |
| `check.received`                 | text reached the model (slash command, injected context).                        |
| `check.hookFired`                | a hook fired for an event, and optionally blocked or allowed it.                 |
| `check.delivered`                | a hook's text reached the model, not only stderr.                                |
| `check.turns`                    | the agent took a number of turns, or a number of matching replies.               |
| `check.writes`                   | files were or were not written (`include`, `none`, and `only` on recorded runs). |
| `check.egressOnly`               | every network attempt of a confined run went to an allowed host.                 |
| `check.cost`                     | the run stayed under a dollar budget (eval runs).                                |
| `check.latency`                  | the run stayed under a time budget (eval runs).                                  |
| `check.tokens`                   | each token class stayed under its cap (eval runs).                               |
| `check.experimental_agentResult` | the output ends with a typed `ok` or `err` result block (experimental).          |

### Declare an eval

| Name         | What it is                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `defineEval` | Declare what an eval file measures: exactly one of `runEval`, `measure`, `measureArms`, `measureTriggerRate`, `measureSelectionMatrix`. |

### Typed results, emit channel (experimental)

| Name                           | What it is                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `experimental_emitTool`        | Build the tool definition a subagent calls to deliver a typed result.      |
| `experimental_parseEmitted`    | Read a typed result out of a run's tool calls.                             |
| `experimental_assertEmittedOk` | Throw unless the emitted result is on the `ok` track, narrowing the value. |

The types below describe these: `EmitFieldSchema`, `EmitObjectSchema`, `EmitPropertySchema`, `EmitTrackSchema`, `EmitToolDefinition`, `ExperimentalEmitTool`.

### Types: results of a run

| Type                | What it describes                                                           |
| ------------------- | --------------------------------------------------------------------------- |
| `ScriptRunResult`   | What `runScript` returns.                                                   |
| `HookRunResult`     | What `runHook` returns: a script result plus decision, `blocked`, delivery. |
| `HarnessTestResult` | What `runHarnessTest` returns; a `Trace` that owns its temp directory.      |
| `Trace`             | The record of one agent run: tool calls, hooks, skills, output, turns.      |
| `SubagentTrace`     | The part of a trace belonging to one subagent.                              |
| `ToolCall`          | One tool call with its input and result.                                    |
| `HookFire`          | One hook invocation seen in a run.                                          |
| `SkillFire`         | One skill activation.                                                       |
| `SkillFacts`        | Which skills fired, or why the harness cannot tell.                         |
| `ModelRequest`      | What the harness sent to the scripted model.                                |
| `ModelTurn`         | One scripted model turn: text, or a tool call.                              |
| `ContextEvidence`   | Whether expected context files reached the model's first request.           |
| `UnobservableWhy`   | Why context delivery could not be observed.                                 |
| `RunContext`        | What an eval `measure` or check callback receives for each trial.           |

### Types: inputs and options

| Type                    | What it describes                                                      |
| ----------------------- | ---------------------------------------------------------------------- |
| `HarnessTestSpec`       | The input of `runHarnessTest`.                                         |
| `RunHarnessTestOptions` | Its second argument; selects the harness adapter.                      |
| `RunScriptOptions`      | Options of `runScript` (cwd, env, stdin, sandbox, egress).             |
| `RunHookOptions`        | Options of `runHook`.                                                  |
| `HookInput`             | The event object piped to a hook.                                      |
| `HookOutput`            | The JSON a hook may print.                                             |
| `SandboxMode`           | `"auto"`, `"strict"` or `false`.                                       |
| `RunEnv`                | Where an eval trial runs: an ephemeral directory, or a stated inherit. |
| `HomeSeed`              | Files seeded into an ephemeral HOME.                                   |
| `HomeFiles`             | Path-to-contents map used by `HomeSeed`.                               |
| `SkillContract`         | The checks `check.skillContract` builds.                               |
| `SkillContractOptions`  | Options of `check.skillContract`.                                      |

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
| `HookFiredOptions`       | Options of `check.hookFired`.                                         |
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

| Type                  | What it describes                                          |
| --------------------- | ---------------------------------------------------------- |
| `EvalDefinition`      | What `defineEval` returns.                                 |
| `EvalDefinitionInput` | What `defineEval` accepts.                                 |
| `EvalHooks`           | `skipIf` and the report assertion of an eval file.         |
| `EvalKind`            | The five measurement keys.                                 |
| `EvalMeasurements`    | The measurement shapes an eval file may declare.           |
| `EvalReports`         | The report type each measurement produces.                 |
| `SelectionMatrixSpec` | Input of the selection-matrix measurement.                 |
| `EvalSpec`            | A/B across arms with derived metrics.                      |
| `EvalArm`             | One arm of an A/B.                                         |
| `MeasureSpec`         | Checks scored over trials of one task.                     |
| `ArmsMeasureSpec`     | The same checks scored per arm.                            |
| `TriggerRateSpec`     | Whether a skill's description fires, over a prompt set.    |
| `Metrics`             | The metric record an eval callback returns.                |
| `EvalReport`          | The report of `runEval`.                                   |
| `ArmReport`           | Per-arm figures inside a report.                           |
| `ArmUsage`            | Cost and token totals of an arm.                           |
| `EvalUsage`           | Cost, duration and token counts of one run.                |
| `MetricStat`          | Mean, spread and sample size of one metric.                |
| `CheckReport`         | Per-check pass rates over trials.                          |
| `CheckRate`           | One check's rate, standard error and pass-all-trials flag. |
| `ArmsCheckReport`     | A `CheckReport` per arm.                                   |
| `TriggerRateReport`   | Recall and precision of a skill description.               |
| `PromptTriggerStat`   | How often one prompt fired the skill.                      |

Reading these reports (`compare`, `assertRates`, `assertImproves`, `assertNoRegression`) is on [`vigiles/eval`](eval.md).
