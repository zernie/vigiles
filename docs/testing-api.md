# Testing API overview

The parts of the testing API that belong to no single entry: which runner to
pick, the `Trace` every run produces, how imports and harness selection work,
and the migration tables for renamed names. The task-first how-to is
[Testing your harness](harness-testing.md).

**Each name's reference is on its entry's page** under [`docs/api/`](api/README.md):
what it is for, typical calls, and every export. Signatures are in the
[generated API reference](https://zernie.github.io/vigiles/api/).

## Contents

- [Picking a runner](#picking-a-runner)
- [The `Trace` model](#the-trace-model)
- [Where the reference lives](#where-the-reference-lives)
- [Imports &amp; harness selection](#imports--harness-selection)
- [Migrating to v53](#migrating-to-v53), [v52](#migrating-to-v52), [v51](#migrating-to-v51), [the v50 assertion form](#migrating-to-the-v50-assertion-form)

## Picking a runner

Four runners, keyed on the question you actually have. The first three are free
and deterministic; only the last needs a model.

| Your question                                                  | Runner                                     | Result              | Cost                |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------- | ------------------- |
| does my **helper script** do what it claims?                   | `runScript`                                | `ScriptRunResult`   | free                |
| does my **hook** block what it says it blocks?                 | `runHook`                                  | `HookRunResult`     | free                |
| does the **assembled harness** behave (hooks+settings+skills)? | `runHarnessTest`                           | `HarnessTestResult` | free, needs the CLI |
| does the **real model** pick my skill / do the job?            | `paid_measureTriggerRate` / `paid_runEval` | reports             | **paid**            |

`runHarnessTest` is deterministic and **free** despite its `model:` field — those
are _scripted_ turns (`ModelTurn[]`) served by a mock. Nothing reaches a real
model at that tier.

**`runScript` is the primitive; `runHook` is it plus the hook protocol** (event →
stdin, exit code → allow/deny). A **hook** has a _decision_; a **script** has
_effects_ — so `ScriptRunResult` deliberately carries no `decision` field.

**Both streams, always.** `ScriptRunResult`, `HookRunResult` and
`HarnessTestResult` all carry `stdout` **and** `stderr`. That matters more than
it looks: advisory output — including vigiles's own compiled-hook `notice()` —
goes to **stderr**, so a hand-rolled `execFileSync` runner (which returns stdout
alone on success) silently deletes it and reports a healthy react hook as dead.

**`filesWritten` is `undefined` until something records it.** Writes are captured
by diffing the work dir, which only a confined run does. `undefined` means
"nobody looked"; `[]` means "looked, wrote nothing" — `check.writes` fails on
the former instead of passing vacuously.

## The `Trace` model

Every tier produces one **`Trace`**: the observable record of a run. A
`runHarnessTest` result _is_ a `Trace`, and so is the `ctx` handed to a `runEval`
`measure`. Its fields:

| Field           | What it holds                                                      |
| --------------- | ------------------------------------------------------------------ |
| `toolCalls`     | every tool the agent invoked (name + input)                        |
| `hooks`         | each `HookFire` — `name`, `event`, `exitCode`, `blocked`, `output` |
| `output`        | the agent's final answer                                           |
| `modelRequests` | what actually reached the model (did injected context land?)       |
| `turns`         | number of agent turns                                              |
| `file(p)`       | read a file from the post-run filesystem                           |
| `sh(cmd)`       | run a shell command against the post-run filesystem (eval ctx)     |
| `usage`         | `{ costUsd, durationMs, inputTokens, outputTokens }` (eval)        |

`trace.hooks` is **recorded**, not inferred: each `HookFire` comes from the CLI's
stream events, so a test asserts a hook _actually_ fired and blocked — no marker
file the hook had to write. Capture it with `transcript: true` on the harness tier
(always on at the eval tier).

## Where the reference lives

This page used to hold the whole reference. Each part now sits on the page of
the entry its names are imported from:

| Topic                                              | Page                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| assertions, the `check` vocabulary, `assertChecks` | [`vigiles`: how checks work](api/vigiles.md#how-checks-work)                                            |
| testing a compiled hook in process                 | [`vigiles/hook/testing`](api/hook-testing.md#test-a-compiled-hook-in-process)                           |
| the guard battery (`runGuardrail`, `disasters`, …) | [`vigiles/hook/testing`](api/hook-testing.md#prove-a-guard-blocks-every-disaster)                       |
| a subagent's typed outcome                         | [`vigiles/spec`](api/spec.md#assert-a-subagents-outcome-without-a-model-judge)                          |
| vitest / jest matchers                             | [matchers](api/matchers.md)                                                                             |
| `measureTriggerRate` options                       | [`vigiles/eval`](api/eval.md#measuretriggerrate-options)                                                |
| `runEval`, `measure`, `measureArms`                | [`vigiles/eval`](api/eval.md#runeval-measure-measurearms)                                               |
| significance and regression gating                 | [`vigiles/eval`](api/eval.md#significance--regression-gating)                                           |
| the selection-collision matrix (Claude Code only)  | [`vigiles/harness/claude-code`](api/harness-claude-code.md#catch-one-skill-stealing-a-siblings-prompts) |

## Imports &amp; harness selection

**One door per reader.** Every public name lives behind exactly one entry; the
[API by entry](api/README.md) index lists them, each with its page.

**In a `*.eval.mjs` file the runners below are DECLARED, not called** —
`export default defineEval({ measure: spec })` — because importing a file that
calls one spends real money. See
[eval files describe their eval](harness-testing.md#eval-files-describe-their-eval).

**The testing surface splits by reader, not by test tier.** The package root is
the free testing surface; there is no `vigiles/test` — the bare package name _is_
the testing surface — and the old `vigiles/unit` / `vigiles/integration` /
`vigiles/e2e` / `vigiles/testing` barrels are gone. Tiers were never a property
of the module graph: express them where they belong, in test-file naming and
runner config (`vitest --project integration`), the way `@playwright/test` does.

**Every runtime export on `vigiles/eval` that can call a model is named `paid_`.** The import path
warns once, at the top of the file; the name warns at every call site, which is
where the money is spent. Same device the package already uses for
`experimental_` on every call site. ⚠️ The prefix overstates slightly —
`paid_judged(rubric, { judge: myFn })` runs your function and bills nothing, and
the `measure*` family takes an injectable `evalDriver`; only the DEFAULT path
calls a model. `metered_` would be exact but reads a beat slower, and a warning
that isn't absorbed at a glance isn't a warning. Types are **not** prefixed: a
type cannot be called, so it cannot bill.

Two consequences worth stating plainly:

- **Free is not fast.** `runHarnessTest` spawns a real `claude` under bubblewrap
  and can take ~40 seconds. It bills nothing, so it is on the free root, and the
  import no longer warns you about the wall clock.
- **The report readers are free and unprefixed, on `vigiles/eval`.** `compare`,
  `assertRates`, `assertNoRegression` and friends read a report without running
  anything; their only reader just ran an eval, so they sit beside the runners.
  To forbid spending in CI, match the `paid_*` names, not the door. The report
  TYPES (`EvalReport`, `CheckReport`, …) are on `vigiles`, since `defineEval`
  speaks them too.

**Selecting a harness.** The runners (`runHook`, `runHarnessTest`, `runEval`) are
harness-agnostic; pick the harness with one option, defaulting to Claude Code:

```ts
import { runHarnessTest } from "vigiles";

await runHarnessTest(spec); // Claude Code (default)
await runHarnessTest(spec, { adapter: codexAdapter }); // a second harness
```

`codexAdapter` comes from `vigiles/harness/codex`. Nothing in `vigiles` changes
when the harness changes; unused adapters tree-shake out. The CLI can't take an
import, so it **auto-detects** the harness from the repo. For the full
adapter/import model and the capability matrix, see
[`docs/harnesses.md`](harnesses.md).

## Migrating to v53

v53 makes every public name say its role (#418, #518): a runner is
`run<What>()` and returns a result, a value (an input, a case set) is a noun, a
check is named after what it observes with the constraint in its options, and
`assertChecks` / `toPass` are the one place that throws. The exceptions: a gate
over an aggregate report (`assertRates`, …), an assertion that narrows a type
(`experimental_assertAgentOk`, …), and the authoring vocabularies
`vigiles/spec` / `vigiles/hook`. The guard battery got the same shape: WHICH
cases run is a value you pass. On `vigiles/hook/testing` unless noted. There
are no aliases.

| Removed in v53                                                                                                               | Write instead                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyGuardrail(hook, opts)`                                                                                                | `runGuardrail(hook, cases?, opts?).rows` — the result is `{ kind, hook, rows }`                                                                                         |
| `assertGuardrail(hook, opts)`                                                                                                | `assertChecks(runGuardrail(hook, cases?, opts?), [guardrail()])` (`assertChecks` from `vigiles`)                                                                        |
| options `events` / `categories` / `spellings` / `harmless`                                                                   | `runGuardrail(hook, disasters({ events, categories, spellings, harmless }))`                                                                                            |
| option `experimental_targetRepo: { command, blocked, allowed, forms }`                                                       | `runGuardrail(hook, experimental_crossRepo({ command, blockIn, allowIn, forms }))`                                                                                      |
| `experimental_alternateSpellings(events)`                                                                                    | `disasters({ events }).spellings`                                                                                                                                       |
| `experimental_harmlessTwins(events)`                                                                                         | `disasters({ events }).harmless`                                                                                                                                        |
| `[...experimental_alternateSpellings(DISASTER_CATALOG), mine]`                                                               | `const d = disasters(); runGuardrail(hook, { ...d, spellings: [...d.spellings, mine] })`                                                                                |
| type `VerifyGuardrailOptions`                                                                                                | `RunGuardrailOptions` (how to run) + `DisasterCasesOptions` (which disasters)                                                                                           |
| type `GuardrailResult` (a row)                                                                                               | `DisasterRow`; the runner's result is `GuardrailRunResult`                                                                                                              |
| types `TargetRepoResult` / `TargetRepoCases` / `TargetRepoEvent` / `TargetRepoFixture` / `TargetRepoForm` / `TargetRepoSide` | `CrossRepoRow` / `CrossRepoSetup` (input; `CrossRepoCases` is the built set) / `CrossRepoEvent` / `CrossRepoFixture` / `CrossRepoForm` / `CrossRepoSide`                |
| `experimental_assertHookDenies(h, e)` / `…Allows` / `…Notices(h, e, m?)` / `…Silent`                                         | `assertChecks(runHookProgram(h, e), [experimental_decision("deny" \| "allow" \| "notice" \| "silent", m?)])` — `runHookProgram` on this entry is now the counted runner |
| `experimental_verifyPluginGuards(dir, opts)` (type `VerifyPluginGuardsOptions`)                                              | `experimental_runPluginGuards(dir, opts)` (type `RunPluginGuardsOptions`)                                                                                               |
| `check.hookFired(event, { blocked })` (`vigiles`)                                                                            | `check.hook(event, { blocked })` — the serialized `kind` is now `hook`                                                                                                  |
| `check.egressOnly(hosts)` / `check.egressOnly([])` (`vigiles`)                                                               | `check.egress({ only: hosts })` / `check.egress({ none: true })` — `kind` is now `egress`                                                                               |
| `check.skillContract(dir)` (`vigiles`)                                                                                       | `readSkillContract(dir)` (`vigiles`) — a reader, not a check                                                                                                            |
| `measureSelectionMatrix` (`vigiles/harness/claude-code`)                                                                     | `paid_measureSelectionMatrix` — it calls a model; the `defineEval` key stays `measureSelectionMatrix`                                                                   |
| `codexEvalDriver` (`vigiles/harness/codex`)                                                                                  | `paid_codexEvalDriver` — it drives a real `codex exec` turn                                                                                                             |
| `checkAdapterConformance` (`vigiles/harness/kit`)                                                                            | `runAdapterConformance` — a runner returning `ConformanceResult`                                                                                                        |
| `parseShellCommand`, `parseFilePath`, `leafCommandsNormalized` (`vigiles/hook`)                                              | none: internal. A hook reads `e.command` / `e.path`, which the runtime already parsed; an `e.command` method (`runs`, `touches`, …) is the vocabulary                   |

The check fails, each in its own words, where the old assertion threw: a hook
that never ran ("NEVER RAN"), a case it never answered ("NOT RUN"), and a
cross-repository crossing whose control failed ("NOT A VERDICT"). Combining a
cross-repository set with `cwd` still throws; combining it with the disaster
options can no longer be written. The `forms` of `experimental_crossRepo` are
checked when the set is built, not when it runs.

## Migrating to v52

v52 pays down the export budget (zernie/vigiles#518): a check takes OPTIONS
instead of spawning a sibling, and the eval readers fold into the gates they
fed. There are no aliases: the old names are gone.

| Removed in v52                                                  | Write instead                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `check.wrote(p)`                                                | `check.writes({ include: [p] })`                                                          |
| `check.didNotWrite(p)`                                          | `check.writes({ none: [p] })`                                                             |
| `check.noWrite(p)`                                              | `check.writes({ none: [p] })` — a string is now an EXACT path; use a RegExp for a pattern |
| `check.wroteOnly(list)`                                         | `check.writes({ only: list })` — the same, exact strings or RegExps                       |
| `check.blocked()`                                               | `check.hook(event, { blocked: true })` — the input must name `hook_event_name`            |
| `check.allowed()`                                               | `check.hook(event, { blocked: false })` — now FAILS on a hook that never ran              |
| `check.toolWith(n, args)`                                       | `check.tool(n, { with: args })`                                                           |
| `check.notTool(n)` / `check.notTool(n, args)`                   | `check.tool(n, { max: 0 })` / `check.tool(n, { with: args, max: 0 })`                     |
| `experimental_replyCount(m, { min, max })` (`vigiles`)          | `check.turns({ matching: m, min, max })`                                                  |
| `experimental_eachReply(m)` (`vigiles`)                         | `check.output(m, { eachReply: true })`                                                    |
| `experimental_assertAgentErr(out, c)` (`vigiles/spec`)          | `assertChecks({ output: out }, [check.experimental_agentResult("err", c)])`               |
| `experimental_assertAgentResult(out, pred, c)` (`vigiles/spec`) | `assertChecks({ output: out }, [check.experimental_agentResult(pred, c)])`                |
| `assertTriggerRate(report, gate)` (`vigiles/eval`)              | `assertRates(report, gate)` — an empty gate now fails                                     |
| `readBaseline(path)` + `assertNoRegression(r, baseline, opts)`  | `assertNoRegression(r, { baseline: path, ...opts })` — a missing file fails               |
| `writeBaseline(path, reports)` (`vigiles/eval`)                 | `assertNoRegression(reports, { baseline: path, update: true })`                           |

`ParsedAgentResult`, the type a predicate receives, moved from `vigiles/spec` to
`vigiles` with the check that uses it. `experimental_assertAgentOk` stays on
`vigiles/spec`: it throws, so the success value it returns is narrowed. Check
`kind`s in a serialized report changed with the names (`toolWith` / `notTool` →
`tool`, `wrote` / `didNotWrite` / `noWrite` / `wroteOnly` → `writes`,
`blocked` / `allowed` → `hookFired`, `replyCount` → `turns`, `eachReply` →
`output`), so an `assertRates` `per:` keyed by an old kind needs the new one.

## Migrating to v51

v51 renames the entry points by audience and nests two families. There are no
aliases: the old paths stop resolving.

| Removed in v51        | Write instead                 |
| --------------------- | ----------------------------- |
| `vigiles/battery`     | `vigiles/hook/testing`        |
| `vigiles/hook-test`   | `vigiles/hook/testing`        |
| `vigiles/claude-code` | `vigiles/harness/claude-code` |
| `vigiles/codex`       | `vigiles/harness/codex`       |
| `vigiles/adapter`     | `vigiles/harness/kit`         |

`vigiles`, `vigiles/spec`, `vigiles/eval`, `vigiles/rule-proof`, `vigiles/hook`,
`vigiles/fixtures`, `vigiles/vitest` and `vigiles/jest` do not move. Every name
keeps its entry, so only the import path changes.

## Migrating to the v50 assertion form

| Removed in v50                                                                                                                                                                                                  | Write instead                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `assertToolUsed(r, n)` / `usedTool(t, n)`                                                                                                                                                                       | `check.tool(n)`                                                              |
| `assertToolNotUsed(r, n)`                                                                                                                                                                                       | `check.tool(n, { max: 0 })`                                                  |
| `assertToolCount(r, n, b)` / `toolCount(t, n)`                                                                                                                                                                  | `check.tool(n, { min, max })`                                                |
| `assertToolSequence(r, [a, b])`                                                                                                                                                                                 | `check.toolSequence([a, b])`                                                 |
| `assertToolUsedWith(r, n, fn)` / `toolUsedWith`                                                                                                                                                                 | `check.tool(n, { with: args })`, or `check(name, fn)`                        |
| `assertToolCalls(r, fn, msg)`                                                                                                                                                                                   | `check(msg, (t) => fn(t.toolCalls))`                                         |
| `assertSkillResolved(r, id)` / `skillResolved`                                                                                                                                                                  | `check.skill(id)` — and `fired: check.skill(id)`                             |
| `assertOutputContains(r, x)` / `outputContains`                                                                                                                                                                 | `check.output(x)`                                                            |
| `assertRequestContains(r, x)` / `requestContains`                                                                                                                                                               | `check.received(x)`                                                          |
| `assertHookFired(r, e, { blocked })` / `hookBlocked`                                                                                                                                                            | `check.hook(e, { blocked })`                                                 |
| `assertCreated(r, p)` / `assertNotCreated(r, p)`                                                                                                                                                                | `check.writes({ include: [p] })` / `check.writes({ none: [p] })`             |
| `assertHookBlocked(r)` / `assertHookAllowed(r)`                                                                                                                                                                 | `check.hook(event, { blocked: true })` / `{ blocked: false }`                |
| `assertDelivered(r)`                                                                                                                                                                                            | `check.delivered()`                                                          |
| `assertEgressOnly(r, list)`                                                                                                                                                                                     | `check.egress({ only: list })` (`[]` = no egress)                            |
| `assertNoWrite(r, p)` / `assertWroteOnly(r, list)`                                                                                                                                                              | `check.writes({ none: [p] })` / `check.writes({ only: list })`               |
| a flat check — `tool(…)`, `toolWith`, `notTool`, `onlyTools`, `skill`, `output`, `received`, `hookFired`, `blocked`, `allowed`, `wrote`, `didNotWrite`, `mcp`, `subagent`, `turns`, `cost`, `latency`, `tokens` | the same name on `check`: `check.tool(…)` (the v52 table below folds some)   |
| `inputTokens({ max })` / `outputTokens({ max })`                                                                                                                                                                | `check.tokens({ maxInput })` / `check.tokens({ maxOutput })`                 |
| `cacheTokens({ maxCreation, maxRead })`                                                                                                                                                                         | `check.tokens({ maxCache })` (written + served)                              |
| `skillContract(dir)`                                                                                                                                                                                            | `readSkillContract(dir)` (v53)                                               |
| `fileToolEvents(path)` from `vigiles`                                                                                                                                                                           | `fileToolEvents(path)` from `vigiles/claude-code`                            |
| `experimental_stub` from `vigiles`                                                                                                                                                                              | `experimental_stub` from `vigiles/fixtures`                                  |
| `experimental_startServices`, `experimental_dockerRuntime` from `vigiles`                                                                                                                                       | the same names from `vigiles/fixtures`                                       |
| `experimental_outputStyleArms` from `vigiles`                                                                                                                                                                   | `experimental_outputStyleArms` from `vigiles/eval`                           |
| `loadHook`, `assertHookDenies/Allows/Notices/Silent` from `vigiles`                                                                                                                                             | `experimental_loadHook`, `experimental_assertHook*` from `vigiles/hook-test` |
| `runHookProgram`, `RawHookEvent`, `HookProgramOutcome` from `vigiles/hook`                                                                                                                                      | the same names from `vigiles/hook-test`                                      |

Each goes in `assertChecks(r, [ … ])`, `expect(r).toPass(…)`, or a `measure`'s
`checks` / a trigger-rate `fired:`.

## See also

- [Testing your harness](harness-testing.md) — the task-first how-to guide.
- [`docs/harnesses.md`](harnesses.md) — harness selection + the capability matrix.
- [API by entry](api/README.md) — one page per package entry, every export.
