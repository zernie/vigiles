# Testing API reference

The complete surface behind [Testing your harness](harness-testing.md) — every
assertion, check, matcher, and option. The guide has the task-first
how-to; this is the reference you reach for when you need the exact name or knob.

## Contents

- [Picking a runner](#picking-a-runner)
- [And one that asks about the tests themselves](#and-one-that-asks-about-the-tests-themselves)
- [The `Trace` model](#the-trace-model)
- [Assertions](#assertions)
- [The `check` vocabulary](#the-check-vocabulary)
- [vitest / jest matchers](#vitest--jest-matchers)
- [`measureTriggerRate` options](#measuretriggerrate-options)
- [Selection-collision matrix (Claude Code only)](#selection-collision-matrix-claude-code-only)
- [`runEval`, `measure`, `measureArms`](#runeval-measure-measurearms)
- [Significance &amp; regression gating](#significance--regression-gating)
- [Imports &amp; harness selection](#imports--harness-selection)

## Picking a runner

Four runners, keyed on the question you actually have. The first three are free
and deterministic; only the last needs a model.

| Your question                                                  | Runner                           | Result              | Cost                |
| -------------------------------------------------------------- | -------------------------------- | ------------------- | ------------------- |
| does my **helper script** do what it claims?                   | `runScript`                      | `ScriptRunResult`   | free                |
| does my **hook** block what it says it blocks?                 | `runHook`                        | `HookRunResult`     | free                |
| does the **assembled harness** behave (hooks+settings+skills)? | `runHarnessTest`                 | `HarnessTestResult` | free, needs the CLI |
| does the **real model** pick my skill / do the job?            | `measureTriggerRate` / `runEval` | reports             | **paid**            |

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
"nobody looked"; `[]` means "looked, wrote nothing" — `check.noWrite` /
`check.wroteOnly` fail on the former instead of passing vacuously.

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

## Assertions

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
  check.toolWith("Edit", { file_path: "src/billing.ts" }), // argument
  check.hookFired("UserPromptSubmit"),
  check.output(/on it/),
  check.wrote("DONE"), // a file was created
  check(
    "every Edit follows a Read",
    (t) => /* any rule over t.toolCalls */ true,
  ),
]);

assertChecks(hookResult, [check.blocked()]); // exit 2 / decision:"block" / permissionDecision:"deny"
```

Want a boolean instead of a throw — in a `measure`, say? A check's verdict is
`check.skill("demo:greet").eval(trace).pass`; `fired:` takes the check itself.

What a hook or script run did beyond its decision is a check too:
`check.delivered()` (its text REACHED the model, not just stderr — see
[harness-testing.md](harness-testing.md#assert-a-nudge-reaches-the-model-checkdelivered)),
and `check.egressOnly([...])` / `check.noWrite(p)` / `check.wroteOnly([...])` over a
confined run's egress and file writes.

The flat check functions (`tool`, `skill`, `wrote`, …), the `assertToolUsed`-style
functions and the boolean predicates (`usedTool`, `skillResolved`, …) were removed
in v50 — each is one `check.*` member; the
[migration table](#migrating-to-the-v50-assertion-form) lists them.

A `runHarnessTest` result owns its temp directory. Remove it in a `finally` with
`r.cleanup()`, or let TypeScript (5.2+) or Node 24+ do it for you:
`await using r = await runHarnessTest(spec)` disposes the result when it leaves
scope, even when an assertion throws.

To prove a guard blocks every disaster and allows the same text as data, use the
battery on [`vigiles/battery`](harness-testing.md#prove-a-guard-actually-blocks-the-disaster-battery):
`assertGuardrail("bash hooks/guard.sh")`.

### Test a compiled hook in-process (no subprocess)

A [compiled hook](compiled-hooks.md) (a `vigiles/hook` program) has a **pure**
decision, so you can test it without spawning the CLI at all — pass the hook's
default export and a raw event. The test functions live on `vigiles/hook`,
beside the vocabulary they test:

```ts
import {
  experimental_loadHook,
  experimental_assertHookDenies,
  experimental_assertHookAllows,
  experimental_assertHookNotices,
  experimental_assertHookSilent,
  runHookProgram,
} from "vigiles/hook";

// experimental_loadHook takes the hook's PATH — what a .harness.mjs file actually has. It is
// the same loader the runtime uses, and it handles a .hook.ts under tsx / Node
// >= 23.6. Already holding the object (a static import)? Pass it directly.
const guard = await experimental_loadHook(".vigiles/hooks/guard.hook.mjs");

experimental_assertHookDenies(guard, {
  tool_name: "Bash",
  tool_input: { command: "git push -f" },
});
experimental_assertHookAllows(guard, {
  tool_name: "Bash",
  tool_input: { command: "git status" },
});

// A REACT hook can't block, so it gets its own pair. Which STREAM carries a
// `notice()` depends on the event (additionalContext on stdout where the event
// injects, stderr only where it cannot), so these read the reaction itself.
const warn = await experimental_loadHook(
  ".vigiles/hooks/warn-on-failure.hook.mjs",
);
experimental_assertHookNotices(warn, failedBashEvent, /read the error/); // message matcher optional
experimental_assertHookSilent(warn, successfulBashEvent);
// A react declared for Bash alone (`match: tools("Bash")`) also reads the
// command: its event is a `BashReactEvent`, so feed it a Bash payload, and
// add a non-Bash event to show it stays quiet there.

// the raw primitive: a normalized, role-dispatched outcome
runHookProgram(guard, event); // → { kind: "decision" | "injection" | "reaction", … }
```

`check.blocked()` / `check.allowed()` (above) are the sibling checks over a
`runHook` **result** (the hook run as a real subprocess); `experimental_assertHookDenies` /
`experimental_assertHookAllows` evaluate the typed program **directly** — cheaper, and they
work for inject/react hooks too via `runHookProgram`. Which reacts see
`e.command` (a `BashReactEvent`) and which do not (a `ToolReactEvent`):
[A react that reads the command](compiled-hooks.md#a-react-that-reads-the-command).

### Assert a subagent's typed outcome

For the railway/result subagent contract, `experimental_assertAgentOk` / `experimental_assertAgentErr` /
`experimental_assertAgentResult` test a subagent's outcome via `parseAgentResult` — a
**deterministic assert that replaces an LLM judge**. A subagent with a `result()`
contract ends its turn with a `vigiles:ok` / `vigiles:err` block; these helpers
parse it and validate it against the declared shape. They live on `vigiles/spec`,
beside the `experimental_agent` contract they read:

```ts
import {
  experimental_agent,
  experimental_assertAgentOk,
  experimental_assertAgentErr,
  experimental_assertAgentResult,
} from "vigiles/spec";
const { result } = experimental_agent;

const contract = result(
  { files: "string[]", summary: "string" }, // the ok track
  { reason: "string", step: "string" }, // the err track
);

const value = experimental_assertAgentOk(r.output, contract); // returns the validated `value`
const error = experimental_assertAgentErr(r.output, contract); // returns the validated `error`

// The general predicate form, for rich detail:
experimental_assertAgentResult(
  r.output,
  (res) => res.kind === "ok" && res.value.files.length > 0,
  contract,
);
```

Pass the `contract` and a wrong/missing field fails the assertion; omit it and any
well-formed JSON block is accepted. Output that isn't a valid block is `malformed`
(throws) — never a silent pass. Worked example:
[`railway-result.harness.mjs`](../examples/harness/railway-result.harness.mjs).

## The `check` vocabulary

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
assertChecks(runHook(cmd, event), [check.blocked()]);

// SCORED (eval): the SAME checks, as a rate ± se across trials.
// the `paid_` prefix = it calls a model; reading the report (assertRates) is free
import { paid_measure, assertRates } from "vigiles/eval";
const report = await paid_measure({
  pluginDir: "./my-plugin", // or skillsDir: ".claude/skills" (loose, auto-packaged)
  task: "…",
  checks: [check.skill("vigiles:test-harness")],
  stubSkillBodies: true, // firing check: stub bodies → a fraction of the tokens
  trials: 10,
  model: "sonnet",
});
assertRates(report, { min: 0.8 }); // gate the rate, not one noisy run
assertRates(report, { passK: 1 }); // or: every check passed on EVERY trial
```

A check's **failure message is the product** (`expected the agent to use tool
"Bash", but it used [Read, Edit]`), and because it serializes, CI reports and
regression baselines fall out for free.

**The vocabulary** — every check is a member of the one callable `check` object
from `vigiles` (type `check.` and the editor lists them), and `check(name, fn)`
names your own. The exception is `paid_judged`, which calls a model and so lives
on `vigiles/eval`.

| Check                                                  | Holds when…                                                                            | Over             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------- |
| `check.tool(name)`                                     | the agent used that tool                                                               | Trace            |
| `check.tool(name, { min, max })`                       | that tool was used a number of times in bounds                                         | Trace            |
| `check.toolSequence([a, b])`                           | those tools ran in that order (gaps allowed)                                           | Trace            |
| `check.runs(program, { force? })`                      | a shell command ran `program` — read by the compiled-hook parser, any spelling         | Trace            |
| `check(name, fn)`                                      | your own predicate holds — named, serialized and scored like the rest                  | anything         |
| `check.skill(id)`                                      | the skill `id` resolved (no error), as the harness's adapter reports it                | Trace            |
| `check.mcp(server, tool)`                              | the agent used `mcp__server__tool`                                                     | Trace            |
| `check.subagent(name, [checks])`                       | the `Task` subagent ran + passed nested checks                                         | Trace (nested)   |
| `check.output(str \| /re/)`                            | the final answer contains/matches                                                      | Trace            |
| `check.received(str \| /re/)`                          | text reached the model (slash-command / injected)                                      | Trace (mock)     |
| `check.hookFired(event \| /re/, { blocked? })`         | a hook fired for that event or label (and blocked)                                     | Trace            |
| `check.turns({ min, max })`                            | the agent took N turns (multi-turn)                                                    | Trace            |
| `check.wrote(path)`                                    | a file was created                                                                     | Trace            |
| `paid_judged(rubric, {…})`                             | a model grades the output ≥ `min` (LLM rubric)                                         | Trace (eval)     |
| `check.cost({ maxUsd })` / `check.latency({ maxMs })`  | the run stayed under budget                                                            | run usage (eval) |
| `check.tokens({ max, maxInput, maxOutput, maxCache })` | each given token class stayed under its cap (total, fresh input, output, prompt cache) | run usage (eval) |
| `check.blocked()` / `check.allowed()`                  | the hook blocked / allowed                                                             | `runHook` result |
| `check.delivered()`                                    | the hook's text reached the model (not just stderr)                                    | `runHook` result |
| `check.egressOnly([...])`                              | every egress attempt went to an allowed host (`[]` = none at all)                      | confined run     |
| `check.noWrite(p)` / `check.wroteOnly([...])`          | no write matches `p` / every write matches the list (fails if unrecorded)              | confined run     |
| `check.skillContract(dir)`                             | builds `activation` + `surface` checks from a SKILL.md's `allowed-tools:`              | (a builder)      |

`paid_measureArms({ arms, checks })` scores the same checks per arm (a hook/skill/rule
**on vs off**): `report.arms[name].perCheck[i]` lines up across arms. It takes
`stubSkillBodies` too.

## vitest / jest matchers

The testing API is runner-agnostic; these are an optional convenience. Register by
hand:

```ts
import { expect } from "vitest"; // or "@jest/globals"
import { vigilesMatchers } from "vigiles";
expect.extend(vigilesMatchers);
```

…or use the **opt-in integration entries**, which register the matchers _and_ add
their TypeScript types:

```ts
// vitest.config.ts →  test: { setupFiles: ["vigiles/vitest"] }
// jest.config.js   →  setupFilesAfterEnv: ["vigiles/jest"]
import "vigiles/vitest"; // …or import once at the top of a test file
```

|                   | vitest                                     | jest                                   |
| ----------------- | ------------------------------------------ | -------------------------------------- |
| Register (config) | `test: { setupFiles: ["vigiles/vitest"] }` | `setupFilesAfterEnv: ["vigiles/jest"]` |
| …or per-file      | `import "vigiles/vitest"`                  | `import "vigiles/jest"`                |
| Manual (no types) | `expect.extend(vigilesMatchers)`           | `expect.extend(vigilesMatchers)`       |

`toPass` fronts the whole check vocabulary, so reach for it first; the rest are
shorthands.

| Matcher                                  | Asserts                                  | Over             |
| ---------------------------------------- | ---------------------------------------- | ---------------- |
| `expect(r).toPass(check)`                | the check holds (its own message)        | any result       |
| `expect(r).toPassAll([checks])`          | every check holds                        | any result       |
| `expect(r).toHaveCreated(path)`          | a file was created                       | harness result   |
| `expect(r).toBlock()`                    | the hook blocked                         | `runHook` result |
| `expect(report).toBeatBaseline(b, a, m)` | arm `a` beats baseline `b` on metric `m` | eval report      |

So `toPass(check.tool("Bash"))`, `toPass(check.skill("x:y"))`, `toPass(check.blocked())`,
`toPass(check.cost({ maxUsd: 0.05 }))` all work with one matcher. vitest and jest are
**optional peer dependencies** — only the entry you import pulls one in; the seam
is tested under both runners in [`test/runners/`](../test/runners/).

## `measureTriggerRate` options

```ts
const report = await paid_measureTriggerRate({
  skillsDir: ".claude/skills", // loose skills — auto-packaged. XOR pluginDir.
  pluginDir: "./my-plugin", //    already-packaged plugin. XOR skillsDir.
  prompts: [...], //              recall set (≥ minPrompts, NCD-diverse)
  irrelevantPrompts: [...], //    precision set (→ falsePositiveRate / precision)
  fired: check.skill("my-plugin:greet"),
  stubSkillBodies: true, //       stop at SELECTION (frontmatter decides firing)
  fixture: { "path": "contents" }, // seed repo STATE a skill triggers on
  installSet: [otherPluginsOrDirs], // co-install the rest of the harness (release gate)
  trials: 2,
  concurrency: 4, //              parallelize the prompts × trials grid
  minModel: "sonnet", //          fail before spending a token if pointed below
  effort: "low", //               reasoning budget — pin it to reproduce a number
  minPrompts: 10, //              diversity-gate floor
});
assertTriggerRate(report, { min: 0.8, maxFalsePositive: 0.1 });
```

- **`skillsDir` vs `pluginDir`** — exactly one. `skillsDir` packages a loose
  `.claude/skills` into a throwaway plugin for you.
- **`fired`** — a check or a predicate over the run's trace.
  `check.skill("my-plugin:greet")` asks the harness's adapter, so it works on
  every harness; a function `(t) => boolean` still works. Switching between the
  two does not make a recorded lock stale: the lock pins what the model sees, not
  how the script reads the run.
- **`stubSkillBodies`** — triggering is decided by frontmatter _before_ the body
  loads, so stubbing the body (descriptions kept) lets a run stop at selection
  instead of executing a multi-step procedure. Don't combine with judged/quality
  checks — the body is gone.
- **Diversity gate** — `minPrompts` (default 10) + an NCD near-duplicate check
  rejects a too-small / copy-pasted prompt set before spending a token.
- **Model** — defaults to `"sonnet"` (the realistic selector; a weaker model
  under-selects — dogfooded 0.50 on haiku vs 0.90 on sonnet). The `minModel` floor
  fails a too-weak run up front. Model lives in the spec, not an env override.
- **`effort`** — the reasoning budget the run is pinned to (`"low"`, `"high"`, an
  integer — whatever your harness build accepts). Set it when you are reproducing
  or publishing a number: a result measured at one budget is not a result at
  another, so effort is hashed into both the eval lock and the local cache, and a
  recorded report is **stale** for a run at a different budget. It is also an arm
  in its own right — `arms: { cheap: { effort: "low" }, rich: { effort: "high" } }`
  answers "does my harness still hold on the cheaper budget?" through the same
  significance machinery, exactly as model-as-an-arm does.

  Three things worth knowing before you rely on it:

  |                                               |                                                                                                                                                                                                                                                                        |
  | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **It is pinned, not merely passed**           | The harness also reads `CLAUDE_CODE_EFFORT_LEVEL`, and that env var outranks the flag. vigiles sets it for the run — and **deletes an inherited one when you omit `effort`** — so an exported value in your shell can never silently become the budget a lock records. |
  | **A value the harness rejects fails the run** | It does not fail on a bad level; it warns and quietly uses its default. vigiles turns that warning into an error, because a number produced by a configuration nobody asked for is the problem this field exists to avoid.                                             |
  | **Omitting it means the harness default**     | Not a fixed level: the default is per-model and can move between builds. An effort-less lock is reproducible only modulo that — the same kind of caveat as the harness version.                                                                                        |

  Not supported on Codex: no mapping has been measured, so a spec declaring
  `effort` there **fails loudly** rather than recording a budget the run did not use.

- **`fixture`** — each run defaults to an empty cwd (faithful for opening-move
  skills); pass `fixture` to seed the repo state a skill claims to fire on.
- **`installSet`** — by default the skill competes against the other skills in the
  plugin you point at (honest — selection is competitive); `installSet` co-installs
  the rest of the user's harness for a release-gate measurement. `report.competitors`
  is the pool size (`0` = isolated, an upper bound on recall).
- **Comparing models** is a harness A/B — set a per-arm `model` in `measureArms` /
  `runEval`, no separate matrix runner.

## Selection-collision matrix (Claude Code only)

> **🔵 Claude Code only — import from `vigiles/claude-code`, not the root `vigiles`
> surface.**
> This reads _which_ skill the selector chose, and only Claude Code surfaces that
> (Codex has no skill-selection event). On any other harness it returns
> `available: false` rather than a fake pass.

Per-skill trigger-rate asks each skill in isolation. It can't catch the failure
that breaks a _multi-skill_ plugin: one skill hijacking a **sibling's** prompt.
`measureSelectionMatrix` runs each skill's own prompts against the whole installed
set and records which skill fired — an N×N matrix whose diagonal is recall and
whose off-diagonal mass is collision.

```ts
import { measureSelectionMatrix, assertNoCollision } from "vigiles/claude-code";

const report = await measureSelectionMatrix("./my-plugin", {
  // prompts auto-derived from each skill's description (zero setup);
  // pass `prompts` (a { skill: { prompts: [...] } } map) for a curated set.
  trials: 1,
});

// Fail the build when a sibling steals a skill's prompt.
assertNoCollision(report, { maxOffDiagonal: 0.2 }); // per-skill collision ceiling
// or gate the plugin-wide rate: assertNoCollision(report, { maxPluginCollision: 0.1 })
```

- **Zero-setup** — omit `prompts` and they're derived from descriptions (the same
  generator the `audit` trigger tier uses). Body-stubbed, so it measures
  _selection_ cheaply (the skill's procedure never runs).
- **`assertNoCollision`** — with no options it demands **zero** collision;
  `maxOffDiagonal` caps each skill's collision rate, `maxPluginCollision` caps the
  plugin-wide rate. It **throws on a green that tested nothing** (unavailable
  harness / zero runs), never a silent pass.
- It's the behavioral confirmation of the deterministic
  [`description-overlap`](rules/description-overlap.md) lint rule: the rule says
  "these two look confusable," the matrix says "they collide X% of the time."

## `runEval`, `measure`, `measureArms`

`runEval` drives the real model N trials × arm and aggregates: **mean** for
numbers, **fraction-true** for booleans, with **std / se** and **pass^k** (did the
metric succeed on _every_ trial? — the reliability question "worked every time" ≠
"worked on average"). An arm is a fixture + settings, or a whole `plugin` /
`pluginDir` / `skillsDir` (a loose `.claude/skills` dir, auto-packaged into a
throwaway plugin under the namespace `vigiles-loose-skills` — the same field
`measureTriggerRate` takes; `measure` and `measureArms` take it too, and
`stubSkillBodies` applies to it). Every runner refuses a field its spec does not
declare — a typo, or a sibling runner's option — before it spends a token, rather
than dropping it and measuring a setup you did not ask for.

`runEval` also takes two fields no sibling has. **`env`** is required: `{ kind:
"ephemeral", home? }` (a throwaway HOME, optionally seeded with files) or `{
kind: "inherit", reason }` (your real HOME; the reason is printed with the
report) — [what each passes into the run](measuring-skills.md#where-a-trial-runs--env).
**`stubs`** takes per-invocation rules for CLIs the agent calls, built with
`experimental_stub`; a call no rule answers is printed to stderr when `runEval`
returns, makes `vigiles eval` exit `2` (the file itself exits `78`) and refuses to write a lock — see
[Stubbing a CLI](measuring-skills.md#stubbing-a-cli-the-agent-calls--experimental_stub).

**Every trial checks that its instruction files reached the model.** A file
sitting in the trial's directory is not proof it loaded: a settings flag, an
env var or a `CLAUDE.md` beside an unimported `AGENTS.md` can drop it, and the
run still exits 0. So each trial reads the model's first request and looks
for the files the harness should load from that trial's world — `CLAUDE.md`,
a lone `AGENTS.md`, each `@`-import. You declare nothing; the harness's own
loading rules decide what is expected. One line per arm says what was found:

```
  skill      ✓ context: CLAUDE.md delivered in 5 of 5 trials
  skill      ✗ context: AGENTS.md missing from the model's request in 2 of 5 trials — not scored
  skill      ⚠ context not checked: this harness has no request-body channel in 5 of 5 trials
```

A trial with a missing file is **not scored**: it is left out of `runs`,
`metrics` and `stats` (its cost stays in `usage`), the lock is not written and
the eval fails. "Not checked" is never a pass. Per-trial results are in
`report.arms[a].context`. The request bodies are written to a temporary
directory with every telemetry exporter off, read once and deleted; only file
names reach the report and the cache. Codex trials say "not checked" — no
request channel is read there yet. `experimental_contextCheck: false` turns the
check off.

The `measure` ctx is a full `Trace`, so a metric reads the agent's **actions**
(`ctx.toolCalls`), its **final answer** (`ctx.output`), and the **filesystem**
(`ctx.file`, `ctx.sh`) — reuse the bare predicates to compute them.

**Two questions, two oracles** — don't default to A/B for both:

- **Absolute — "is this exact skill / output any good?"** Testing _one_ skill with
  no on/off variant: score it directly with `measure({ checks: [judged(rubric)] })`
  - `assertRates({ min })`. The oracle promptfoo/DeepEval lead with.
- **Relative — "does this change _move_ behaviour vs off?"** The lift a change buys
  (regression gating, proving a gap isn't noise): `runEval` with `off`/`on` arms +
  `assertImproves({ significant: true })`.

**Cost / caching / concurrency:**

- `concurrency: N` — run N trials at once (default 1). Rate-limit responses back
  off and retry automatically (`rateLimitRetries`, `retryBackoffMs`).
- `maxCostUsd: N` — stop launching once the charged cost crosses the cap; in-flight
  trials finish and `report.aborted` is set. Each run is started with the budget not
  yet charged as its own cap (`claude --max-budget-usd`), so a run that would cross
  the ceiling ends itself and still reports its cost.
- **A run killed by `timeoutMs`** reports no cost (the harness never wrote its final
  `result`). It is charged its cap toward `maxCostUsd`, since nothing proves it spent
  less; `ctx.timedOut` is `true` and `ctx.exitCode` is `-1`, not `0`. Its metrics are
  still computed from what the agent did before the kill, and its `usage` is a floor
  read from the stream: input and cache tokens are exact, output tokens are not.
- `cache: "readwrite"` — **record/replay**. Each trial's output _and_ post-run
  filesystem are recorded; a matching re-run replays without calling the model. The
  key excludes `measure`, so **editing your metric and re-running re-scores for
  free** — the model is re-called only when a model-affecting input changes.

`report.arms[a].usage` aggregates per arm; `report.totalCostUsd` sums the reported
cost of the run. `report.chargedUsd` is what counted against `maxCostUsd` (the reported
cost plus each killed run's cap), and `report.unknownCostRuns` counts the runs that
reported no cost. A killed run's cap is the most it could have spent, not what it
spent, so the printed report names it as a charge to the budget — never as `$0`, and
never as a floor on spend.

**LLM-as-judge** — grade with a model inside `measure` (synchronous, shells out via
the harness CLI):

<!-- vigiles:ignore -->

```ts
import { paid_judge } from "vigiles/eval";

measure: (ctx) => {
  const v = paid_judge({
    output: ctx.file("PLAN.md") ?? "",
    rubric: "1 if the plan lists concrete, ordered steps; else 0.",
  });
  return { quality: v.score, ok: v.pass };
};
```

Deliberately thin — for datasets, tracing, and dashboards use a dedicated eval
platform (Braintrust, DeepEval). vigiles owns the harness A/B, not the judging
platform.

## Significance &amp; regression gating

The report readers live on `vigiles/eval`, beside the runners that produce the
report. None of them calls a model, so none is named `paid_`.

**Significance.** `se` gives the spread; `compare` says, metric by metric, how far
apart two arms are and whether the gap clears a noise floor the trials can
actually show — the floor is **computed**, not hand-fed. The test depends on the
metric:

- **A 0/1 metric** (pass/fail, `true`/`false`): each arm gets a 95% Wilson
  interval, and the gap is significant only when the two intervals do not
  overlap. A metric counts as 0/1 when every trial reported 0 or 1; the report
  records the tally as `stats[metric].successes`. A report saved before that
  field existed has no tally, so it is judged by Welch's test.
- **Any other metric**: Welch's t-test at `alpha` (default 0.05).

```ts
import { compare, assertImproves } from "vigiles/eval";

const c = compare(report, "vanilla", "gated"); // one entry per metric both arms report
c.marked; // → { gap, significant, verdict }
// verdict: { kind: "better" | "worse" | "no-signal", test: "wilson", arm, baseline }
//       or { kind, test: "welch", delta, pValue } · { kind: "unmeasured", why }

assertImproves(report, {
  baseline: "vanilla",
  arm: "gated",
  metric: "marked",
  significant: true, // the verdict must be `better`, not just a positive gap
});
```

A significant LOSS is `significant` with a negative `gap`. An arm name the report
does not have throws (a typo is not an arm that scored nothing).

Hand `compare` two **trigger-rate** reports instead and it diffs them prompt by
prompt — which prompts a description edit (or a different model) gained and lost:

```ts
const { gained, lost, both, neither } = compare(before, after);
```

A prompt only one run measured is left out. Where firing is inferred rather than
observed (Codex), a `gained`/`lost` entry can be inference noise; see
[Is a cheaper model a valid floor?](harness-testing.md#is-a-cheaper-model-a-valid-floor-comparebefore-after).

**Why 0/1 metrics are not t-tested.** When every trial agrees — 3 of 3 against
0 of 3 — both arms have zero spread, and a t-test has nothing to divide by. Read
literally that says "no noise, so any gap is real", and one trial per arm came out
significant. Fisher's exact test puts 3/3 against 0/3 at p = 0.10. A Wilson
interval never shrinks to a point at 0 or 1, so 3/3 still admits a true rate near
0.44 and the verdict is `no-signal`; it takes about 10/10 against 0/10 to separate.
`no-signal` means **raise `trials`**, not "no effect". Requiring disjoint
intervals is stricter than a two-proportion test at the same level: a cautious
verdict costs a re-run, an eager one costs a shipped regression.

`vigiles eval` prints the same verdict, one line per other arm and metric.
`assertImproves` throws when an arm never reported the metric, instead of reading
it as 0. `assertRates(report, { arm, metric, passK: 1 })` is the stricter bar: the
metric succeeded on **every** trial (pass^k = 1).

**Regression gating** compares one run against a **committed baseline** — "jest
snapshots for agent behaviour, with a real noise floor":

```ts
import { writeBaseline, readBaseline, assertNoRegression } from "vigiles/eval";

// Record once (commit .vigiles/eval-baseline.json):
writeBaseline(".vigiles/eval-baseline.json", [report]);

// In CI thereafter — throws on a significant regression:
const baseline = readBaseline(".vigiles/eval-baseline.json");
if (baseline) {
  assertNoRegression(report, baseline, { lowerIsBetter: ["cost"] });
}
```

Higher is better by default; list `lowerIsBetter` metrics (cost/latency) to flip
them. A new arm/metric absent from the baseline is skipped (not a regression).

## Imports &amp; harness selection

**One door per reader** — every name lives behind exactly one of these:

| Reader                        | Import            | What it holds                                                                                                                                                                             |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test your harness             | `vigiles`         | the runners, every check and assertion over a run, the matchers, tool stubs, `defineEval`, and the report types — everything that costs nothing to run                                    |
| Measure with a model          | `vigiles/eval`    | the `paid_*` runners, and the free readers of their report: `compare`, `assertRates`, `assertTriggerRate`, `assertImproves`, `assertNoRegression`, baselines                              |
| Prove a guard blocks          | `vigiles/battery` | `assertGuardrail`, `verifyGuardrail`, `DISASTER_CATALOG`, `experimental_verifyPluginGuards`, `experimental_hookState`                                                                     |
| Write or test a compiled hook | `vigiles/hook`    | the hook vocabulary, and `experimental_loadHook` / `experimental_assertHookDenies` / `experimental_assertHookAllows` / `experimental_assertHookNotices` / `experimental_assertHookSilent` |
| Author a spec                 | `vigiles/spec`    | the spec builders and their types, and `experimental_assertAgentOk` / `experimental_assertAgentErr` / `experimental_assertAgentResult` (compiling is `vigiles compile` / `vigiles lint`)  |

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

The remaining entry points are deliberate surfaces, not aliases:

- **Authoring** — `vigiles/spec`: the spec builders for `.spec.ts` files.
- **CC-specific transport** — `scriptModel`, `loadPlugin`, `LoadedPlugin`,
  `startMock` and the stream-json parsers `parseToolCalls` / `parseClaudeRun` live
  in `vigiles/claude-code`, not on the root surface. Its ports (`layout`,
  `dialect`, `harnessTestDriver()`, …) and tool catalog (`builtinAgentTools`,
  `sideEffectingTools`) are fields of `claudeCodeAdapter`.
- **CC-only measurement** — `measureSelectionMatrix` / `assertNoCollision` live in
  `vigiles/claude-code` too. They read which skill the selector chose (Codex has no
  such event), so they can't sit on the agnostic surface. Everything else measured
  (`paid_measureTriggerRate`, `paid_measure`, `paid_runEval`) is on `vigiles/eval`.
- **Runner integration** — `vigiles/vitest` / `vigiles/jest`.
- **Harness selection** — `vigiles/claude-code` / `vigiles/codex` / `vigiles/adapter`.

**Selecting a harness.** The runners (`runHook`, `runHarnessTest`, `runEval`) are
harness-agnostic; pick the harness with one option, defaulting to Claude Code:

```ts
import { runHarnessTest } from "vigiles";

await runHarnessTest(spec); // Claude Code (default)
await runHarnessTest(spec, { adapter: codexAdapter }); // a second harness
```

`codexAdapter` comes from `vigiles/codex`. Nothing in `vigiles` changes
when the harness changes; unused adapters tree-shake out. The CLI can't take an
import, so it **auto-detects** the harness from the repo. For the full
adapter/import model and the capability matrix, see
[`docs/harnesses.md`](harnesses.md).

## Migrating to the v50 assertion form

| Removed in v50                                                                                                                                                                                                  | Write instead                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `assertToolUsed(r, n)` / `usedTool(t, n)`                                                                                                                                                                       | `check.tool(n)`                                              |
| `assertToolNotUsed(r, n)`                                                                                                                                                                                       | `check.notTool(n)`                                           |
| `assertToolCount(r, n, b)` / `toolCount(t, n)`                                                                                                                                                                  | `check.tool(n, { min, max })`                                |
| `assertToolSequence(r, [a, b])`                                                                                                                                                                                 | `check.toolSequence([a, b])`                                 |
| `assertToolUsedWith(r, n, fn)` / `toolUsedWith`                                                                                                                                                                 | `check.toolWith(n, args)`, or `check(name, fn)`              |
| `assertToolCalls(r, fn, msg)`                                                                                                                                                                                   | `check(msg, (t) => fn(t.toolCalls))`                         |
| `assertSkillResolved(r, id)` / `skillResolved`                                                                                                                                                                  | `check.skill(id)` — and `fired: check.skill(id)`             |
| `assertOutputContains(r, x)` / `outputContains`                                                                                                                                                                 | `check.output(x)`                                            |
| `assertRequestContains(r, x)` / `requestContains`                                                                                                                                                               | `check.received(x)`                                          |
| `assertHookFired(r, e, { blocked })` / `hookBlocked`                                                                                                                                                            | `check.hookFired(e, { blocked })`                            |
| `assertCreated(r, p)` / `assertNotCreated(r, p)`                                                                                                                                                                | `check.wrote(p)` / `check.didNotWrite(p)`                    |
| `assertHookBlocked(r)` / `assertHookAllowed(r)`                                                                                                                                                                 | `check.blocked()` / `check.allowed()`                        |
| `assertDelivered(r)`                                                                                                                                                                                            | `check.delivered()`                                          |
| `assertEgressOnly(r, list)`                                                                                                                                                                                     | `check.egressOnly(list)` (`[]` = no egress)                  |
| `assertNoWrite(r, p)` / `assertWroteOnly(r, list)`                                                                                                                                                              | `check.noWrite(p)` / `check.wroteOnly(list)`                 |
| a flat check — `tool(…)`, `toolWith`, `notTool`, `onlyTools`, `skill`, `output`, `received`, `hookFired`, `blocked`, `allowed`, `wrote`, `didNotWrite`, `mcp`, `subagent`, `turns`, `cost`, `latency`, `tokens` | the same name on `check`: `check.tool(…)`                    |
| `inputTokens({ max })` / `outputTokens({ max })`                                                                                                                                                                | `check.tokens({ maxInput })` / `check.tokens({ maxOutput })` |
| `cacheTokens({ maxCreation, maxRead })`                                                                                                                                                                         | `check.tokens({ maxCache })` (written + served)              |
| `skillContract(dir)`                                                                                                                                                                                            | `check.skillContract(dir)`                                   |
| `fileToolEvents(path)` from `vigiles`                                                                                                                                                                           | `fileToolEvents(path)` from `vigiles/claude-code`            |
| `experimental_stub` from `vigiles`                                                                                                                                                                              | `experimental_stub` from `vigiles/fixtures`                  |
| `experimental_startServices`, `experimental_dockerRuntime` from `vigiles`                                                                                                                                       | the same names from `vigiles/fixtures`                       |
| `experimental_outputStyleArms` from `vigiles`                                                                                                                                                                   | `experimental_outputStyleArms` from `vigiles/eval`           |

Each goes in `assertChecks(r, [ … ])`, `expect(r).toPass(…)`, or a `measure`'s
`checks` / a trigger-rate `fired:`.

## See also

- [Testing your harness](harness-testing.md) — the task-first how-to guide.
- [`docs/harnesses.md`](harnesses.md) — harness selection + the capability matrix.
