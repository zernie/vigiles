# Testing API reference

The complete surface behind [Testing your harness](harness-testing.md) — every
predicate, assertion, check, matcher, and option. The guide has the task-first
how-to; this is the reference you reach for when you need the exact name or knob.

## Contents

- [Picking a runner](#picking-a-runner)
- [And one that asks about the tests themselves](#and-one-that-asks-about-the-tests-themselves)
- [The `Trace` model](#the-trace-model)
- [Predicates](#predicates)
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
"nobody looked"; `[]` means "looked, wrote nothing" — `assertNoWrite` /
`assertWroteOnly` throw on the former instead of passing vacuously.

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

## Predicates

Pure functions over a `Trace` — **no `assert` prefix, no throw**. Use them in a
`measure` as metrics, or wherever you want a boolean.

```ts
import {
  usedTool,
  toolCount,
  skillResolved,
  toolUsedWith,
  outputContains,
  hookFired,
  hookBlocked,
} from "vigiles";

usedTool(trace, "Skill"); // boolean
usedTool(trace, /^mcp__github__merge/); // boolean (regex)
toolCount(trace, "Write"); // number
skillResolved(trace, "demo:greet"); // boolean
toolUsedWith(trace, "Edit", (i) => isRightFile(i)); // boolean (tool argument)
outputContains(trace, /done/i); // boolean (the final answer)
hookFired(trace, "PreToolUse:Edit"); // boolean (recorded from the stream)
hookBlocked(trace, "PreToolUse"); // boolean (fired AND exit ≠ 0)
```

## Assertions

Each `assert*` is a predicate wrapped in a throw (`assertToolUsed` is `usedTool`
then throw; `assertSkillResolved` is `skillResolved` then throw). They're plain
functions, so they work in `node:test`, vitest, jest, or any runner. Beyond a
single tool you can assert on sequence and budget:

```ts
assertToolSequence(r, ["Read", "Edit"]); // ordering — Read before Edit
assertToolCount(r, "Write", { max: 1 }); // budget — no runaway writes
assertToolUsedWith(r, "Edit", (i) => i.file_path === "src/billing.ts"); // argument
assertToolCalls(r, (calls) => /* any custom rule over the list */ true);

assertHookBlocked(r); // exit 2 / decision:"block" / permissionDecision:"deny"
assertBlocksDisasters("bash hooks/guard.sh"); // the hook denies every disaster (force-push, rm -rf, curl|sh …)
assertHookFired(r, "UserPromptSubmit");
assertOutputContains(r, /on it/);
assertCreated(r, "DONE"); // a file was created
```

`withHarness(spec, fn)` wraps a deterministic run with try/finally cleanup so a
test doesn't leak temp dirs.

### Test a compiled hook in-process (no subprocess)

A [compiled hook](compiled-hooks.md) (a `vigiles/hook` program) has a **pure**
decision, so you can test it without spawning the CLI at all — pass the hook's
default export and a raw event:

```ts
import {
  loadHook,
  assertHookDenies,
  assertHookAllows,
  assertHookNotices,
  assertHookSilent,
} from "vigiles";
import { runHookProgram } from "vigiles/hook";

// loadHook takes the hook's PATH — what a .harness.mjs file actually has. It is
// the same loader the runtime uses, and it handles a .hook.ts under tsx / Node
// >= 23.6. Already holding the object (a static import)? Pass it directly.
const guard = await loadHook(".vigiles/hooks/guard.mjs");

assertHookDenies(guard, {
  tool_name: "Bash",
  tool_input: { command: "git push -f" },
});
assertHookAllows(guard, {
  tool_name: "Bash",
  tool_input: { command: "git status" },
});

// A REACT hook can't block, so it gets its own pair. NB `notice()` writes to
// STDERR — a probe that reads stdout reports a healthy react hook as dead.
// These read the reaction itself.
const warn = await loadHook(".vigiles/hooks/warn-on-failure.mjs");
assertHookNotices(warn, failedBashEvent, /read the error/); // message matcher optional
assertHookSilent(warn, successfulBashEvent);

// the raw primitive: a normalized, role-dispatched outcome
runHookProgram(guard, event); // → { kind: "decision" | "injection" | "reaction", … }
```

`assertHookBlocked` / `assertHookAllowed` (above) are the sibling assertions over
a `runHook` **result** (the hook run as a real subprocess); `assertHookDenies` /
`assertHookAllows` evaluate the typed program **directly** — cheaper, and they
work for inject/react hooks too via `runHookProgram`.

### Assert a subagent's typed outcome

For the railway/result subagent contract, `assertAgentOk` / `assertAgentErr` /
`assertAgentResult` test a subagent's outcome via `parseAgentResult` — a
**deterministic assert that replaces an LLM judge**. A subagent with a `result()`
contract ends its turn with a `vigiles:ok` / `vigiles:err` block; these helpers
parse it and validate it against the declared shape:

```ts
import { experimental_agent } from "vigiles/spec";
const { result } = experimental_agent;
import { assertAgentOk, assertAgentErr, assertAgentResult } from "vigiles";

const contract = result(
  { files: "string[]", summary: "string" }, // the ok track
  { reason: "string", step: "string" }, // the err track
);

const value = assertAgentOk(r.output, contract); // returns the validated `value`
const error = assertAgentErr(r.output, contract); // returns the validated `error`

// The general predicate form, for rich detail:
assertAgentResult(
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

A **check** is data, not a throwing assert: `tool("Bash")` is an object that knows
how to `eval` itself against a `Trace` (or a hook decision) and `toJSON`. The same
check is evaluated two ways — write the assertion once:

```ts
import { tool, skill, output, hookFired, blocked, assertChecks } from "vigiles";

// STRICT (deterministic tiers): throws, collecting ALL failures with messages.
assertChecks(await runHarness(spec), [tool("Bash"), output(/done/)]);
assertChecks(runHook(cmd, event), [blocked()]);

// SCORED (eval): the SAME checks, as a rate ± se across trials.
import { paid_measure } from "vigiles/eval"; // the `paid_` prefix = it calls a model
import { assertRates, checkReportToJUnit } from "vigiles"; // reading the report is free
const report = await paid_measure({
  pluginDir: "./my-plugin",
  task: "…",
  checks: [skill("vigiles:test-harness")],
  stubSkillBodies: true, // firing check: stub bodies → a fraction of the tokens
  trials: 10,
  model: "sonnet",
});
assertRates(report, { min: 0.8 }); // gate the rate, not one noisy run
writeFileSync("checks.junit.xml", checkReportToJUnit(report, { min: 0.8 }));
```

A check's **failure message is the product** (`expected the agent to use tool
"Bash", but it used [Read, Edit]`), and because it serializes, CI reports and
regression baselines fall out for free.

**The vocabulary** (from `vigiles` — except `paid_judged`, which calls a model and
so lives on `vigiles/eval`):

| Check                      | Holds when…                                       | Over             |
| -------------------------- | ------------------------------------------------- | ---------------- |
| `tool(name)`               | the agent used that tool                          | Trace            |
| `skill(id)`                | a `Skill` resolved to `id` (no error)             | Trace            |
| `mcp(server, tool)`        | the agent used `mcp__server__tool`                | Trace            |
| `subagent(name, [checks])` | the `Task` subagent ran + passed nested checks    | Trace (nested)   |
| `output(str \| /re/)`      | the final answer contains/matches                 | Trace            |
| `received(str \| /re/)`    | text reached the model (slash-command / injected) | Trace (mock)     |
| `hookFired(event)`         | a hook fired for that event                       | Trace            |
| `turns({ min, max })`      | the agent took N turns (multi-turn)               | Trace            |
| `wrote(path)`              | a file was created                                | Trace            |
| `paid_judged(rubric, {…})` | a model grades the output ≥ `min` (LLM rubric)    | Trace (eval)     |
| `cost/latency/tokens({…})` | the run stayed under budget                       | run usage (eval) |
| `blocked()` / `allowed()`  | the hook blocked / allowed                        | `runHook` result |

`paid_measureArms({ arms, checks })` scores the same checks per arm (a hook/skill/rule
**on vs off**); `compareCheck(report, baseline, arm, i)` returns a Welch verdict.
It takes `stubSkillBodies` too. `propertyHook({ seed, mutate, decide, invariants })`
fuzzes a hook's `(event) → decision` and shrinks any counterexample.

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

So `toPass(tool("Bash"))`, `toPass(skill("x:y"))`, `toPass(blocked())`,
`toPass(cost({ maxUsd: 0.05 }))` all work with one matcher. vitest and jest are
**optional peer dependencies** — only the entry you import pulls one in; the seam
is tested under both runners in [`test/runners/`](../test/runners/).

## `measureTriggerRate` options

```ts
const report = await paid_measureTriggerRate({
  skillsDir: ".claude/skills", // loose skills — auto-packaged. XOR pluginDir.
  pluginDir: "./my-plugin", //    already-packaged plugin. XOR skillsDir.
  prompts: [...], //              recall set (≥ minPrompts, NCD-diverse)
  irrelevantPrompts: [...], //    precision set (→ falsePositiveRate / precision)
  fired: (t) => skillResolved(t, "my-plugin:greet"),
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
`pluginDir`.

The `measure` ctx is a full `Trace`, so a metric reads the agent's **actions**
(`ctx.toolCalls`), its **final answer** (`ctx.output`), and the **filesystem**
(`ctx.file`, `ctx.sh`) — reuse the bare predicates to compute them.

**Two questions, two oracles** — don't default to A/B for both:

- **Absolute — "is this exact skill / output any good?"** Testing _one_ skill with
  no on/off variant: score it directly with `measure({ checks: [judged(rubric)] })`
  - `assertRates({ min })`. The oracle promptfoo/DeepEval lead with.
- **Relative — "does this change _move_ behaviour vs off?"** The lift a change buys
  (regression gating, proving a gap isn't noise): `runEval` with `off`/`on` arms +
  `assertSignificant`.

**Cost / caching / concurrency:**

- `concurrency: N` — run N trials at once (default 1). Rate-limit responses back
  off and retry automatically (`rateLimitRetries`, `retryBackoffMs`).
- `maxCostUsd: N` — stop launching once measured cost crosses the cap; in-flight
  trials finish and `report.aborted` is set.
- `cache: "readwrite"` — **record/replay**. Each trial's output _and_ post-run
  filesystem are recorded; a matching re-run replays without calling the model. The
  key excludes `measure`, so **editing your metric and re-running re-scores for
  free** — the model is re-called only when a model-affecting input changes.

`report.arms[a].usage` aggregates per arm; `report.totalCostUsd` sums the run.

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

**Significance.** `se` gives the spread; `assertSignificant` runs a Welch's t-test
over two arms' summary stats and throws unless the arm beats the baseline at
`alpha` (default 0.05) — the noise floor is **computed**, not hand-fed:

```ts
import { assertSignificant, significantlyBeats, compareArms } from "vigiles";

assertSignificant(report, {
  baseline: "vanilla",
  arm: "gated",
  metric: "marked",
});
significantlyBeats(report, "vanilla", "gated", "marked"); // bare predicate
const c = compareArms(report, "vanilla", "gated", "marked");
// → { delta, seDelta, t, df, pValue, significant }  (reads mean/se/n, no raw rows)
```

For 0/1 metrics this is the t approximation to the two-proportion test — close at
eval trial counts. An insignificant gap means **raise `trials`** until the noise
floor drops below it. `assertReliable(report, { arm, metric })` is the stricter
bar: the metric succeeded on **every** trial (pass^k = 1).

**Regression gating** compares one run against a **committed baseline** — "jest
snapshots for agent behaviour, with a real noise floor":

```ts
import {
  writeBaseline,
  readBaseline,
  assertNoRegression,
  diffToJUnit,
  diffReports,
} from "vigiles";

// Record once (commit .vigiles/eval-baseline.json):
writeBaseline(".vigiles/eval-baseline.json", [report]);

// In CI thereafter — throws on a significant regression:
const baseline = readBaseline(".vigiles/eval-baseline.json");
if (baseline) {
  assertNoRegression(report, baseline, { lowerIsBetter: ["cost"] });
  // or emit JUnit: diffToJUnit(diffReports(baseline, [report]))
}
```

Higher is better by default; list `lowerIsBetter` metrics (cost/latency) to flip
them. A new arm/metric absent from the baseline is skipped (not a regression).

## Imports &amp; harness selection

**One canonical entry point per layer** — import from these:

| Layer                  | Canonical import  | What it re-exports                                                                                                                        |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Test your harness      | `vigiles`         | every check, assertion, matcher, hook/harness runner and tool stub — everything that costs nothing to run                                 |
| Measure with a model   | `vigiles/eval`    | `paid_runEval` · `paid_measure` · `paid_measureArms` · `paid_measureTriggerRate` · `paid_judge` · `paid_judged` · `paid_claudeEvalDriver` |
| Declare an eval file   | `vigiles`         | `defineEval` (free — a description cannot spend; see [eval files](harness-testing.md#eval-files-describe-their-eval))                     |
| Lint instruction files | `vigiles/linting` | the spec builders and their types (compiling is `vigiles compile` / `vigiles lint`)                                                       |

**In a `*.eval.mjs` file the runners below are DECLARED, not called** —
`export default defineEval({ measure: spec })` — because importing a file that
calls one spends real money. See
[eval files describe their eval](harness-testing.md#eval-files-describe-their-eval).

**The testing surface splits on COST, not on test tier.** Free is the package
root; anything that can call a model is `vigiles/eval`. There is no
`vigiles/test` — the bare package name _is_ the testing surface — and the old
`vigiles/unit` / `vigiles/integration` / `vigiles/e2e` / `vigiles/testing`
barrels are gone. Tiers were never a property of the module graph: express them
where they belong, in test-file naming and runner config (`vitest --project
integration`), the way `@playwright/test` does.

**Every runtime export on `vigiles/eval` is also named `paid_`.** The import path
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
- **The eval-analysis helpers stay free and unprefixed.** `assertSignificant`,
  `assertNoRegression`, `diffReports`, `cost` / `latency` / `tokens` and friends
  read a report without running anything, so they are on `vigiles`. Their argument
  TYPES (`EvalReport`, `CheckReport`, …) are re-exported from both barrels, so you
  never import `vigiles/eval` for a type alone.

The remaining entry points are deliberate surfaces, not aliases:

- **Authoring** — `vigiles/spec`: the spec builders for `.spec.ts` files.
- **CC-specific transport** — `scriptModel`, `loadPlugin`, `resolveHarness`,
  `LoadedPlugin` live in `vigiles/claude-code`, not on the root surface.
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

## See also

- [Testing your harness](harness-testing.md) — the task-first how-to guide.
- [`docs/harnesses.md`](harnesses.md) — harness selection + the capability matrix.
