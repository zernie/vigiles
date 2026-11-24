# `vigiles/eval`

The moment you **measure**. This entry holds the runners that drive a real model
(every one is named `paid_`, because a call can spend money) and the free readers
that turn their reports into pass or fail.

**For:** people who gate a skill, hook or plugin on a measured number, in CI or
on a laptop. Eval files are run with `npx vigiles eval`, not with `node`.

vigiles is an ES module package: `import { assertRates } from "vigiles/eval"`.
Every entry also has a CommonJS copy, so `require("vigiles/eval")` works too,
including inside Jest. It needs Node 20.19+ or 22.12+.

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).
The guides: [measuring skills](../measuring-skills.md),
[the testing API overview](../testing-api.md) and
[harness testing](../harness-testing.md).

## Typical tasks

### Gate that a skill fires

`assertRates` on a trigger-rate report. The eval file only describes the
measurement; `vigiles eval` runs it.

```ts
import { defineEval, check } from "vigiles";
import { assertRates } from "vigiles/eval";

export default defineEval({
  measureTriggerRate: {
    skillsDir: ".claude/skills",
    stubSkillBodies: true,
    prompts: ["...tasks the skill should handle..."],
    irrelevantPrompts: ["...unrelated tasks it should ignore..."],
    // Loose skills are packaged under the namespace `vigiles-loose-skills`.
    fired: check.skill("vigiles-loose-skills:greet"),
    trials: 2,
  },
  assert: (report) => assertRates(report, { min: 0.8, maxFalsePositive: 0.1 }),
});
```

### Prove a change beats the baseline

An A/B on the same task, then `assertImproves` with `significant: true`. A
`no-signal` verdict means raise `trials`.

```ts
import { defineEval } from "vigiles";
import { assertImproves } from "vigiles/eval";

export default defineEval({
  runEval: {
    env: { kind: "ephemeral" },
    arms: { off: {}, on: { pluginDir: "./" } },
    task: "...a task the change should affect...",
    measure: (ctx) => ({ ok: ctx.output.length > 0 }),
    trials: 6,
  },
  assert: (report) =>
    assertImproves(report, {
      baseline: "off",
      arm: "on",
      metric: "ok",
      significant: true,
    }),
});
```

### Fail CI on a regression against a committed baseline

Record once with `update: true`, commit the file, then gate.

```ts
import { assertNoRegression } from "vigiles/eval";

const baseline = ".vigiles/eval-baseline.json";
assertNoRegression(report, { baseline, update: true }); // record
assertNoRegression(report, { baseline, lowerIsBetter: ["cost"] }); // gate
```

### Grade free text with a model

`paid_judged` is a check for `measure` and `measureArms`; `paid_judge` is the
synchronous call for inside a `measure` callback.

```ts
import { check } from "vigiles";
import { paid_judged, paid_measure } from "vigiles/eval";

const report = await paid_measure({
  task: "Summarize in.txt in one sentence.",
  fixture: { "in.txt": "..." },
  model: "sonnet",
  checks: [
    check.output(/invoice/i),
    paid_judged("A single, accurate one-sentence summary", { min: 0.7 }),
  ],
  trials: 5,
});
```

### Test an output style

`experimental_outputStyleArms` builds the with and without arms from the style
file. See [testing output styles](../testing-output-styles.md).

## Reference

### `measureTriggerRate` options

```ts
const report = await paid_measureTriggerRate({
  skillsDir: ".claude/skills", // loose skills — auto-packaged. XOR pluginDir.
  pluginDir: "./my-plugin", //    already-packaged plugin. XOR skillsDir.
  prompts: [...], //              recall set (≥ minPrompts, NCD-diverse)
  irrelevantPrompts: [...], //    precision set (→ falsePositiveRate / precision)
  fired: check.skill("my-plugin:greet"), // with skillsDir: "vigiles-loose-skills:greet"
  stubSkillBodies: true, //       stop at SELECTION (frontmatter decides firing)
  fixture: { "path": "contents" }, // seed repo STATE a skill triggers on
  installSet: [otherPluginsOrDirs], // co-install the rest of the harness (release gate)
  trials: 2,
  concurrency: 4, //              parallelize the prompts × trials grid
  minModel: "sonnet", //          fail before spending a token if pointed below
  effort: "low", //               reasoning budget — pin it to reproduce a number
  minPrompts: 10, //              diversity-gate floor
});
assertRates(report, { min: 0.8, maxFalsePositive: 0.1 }); // recall, precision side
```

- **`skillsDir` vs `pluginDir`** — exactly one. `skillsDir` packages a loose
  `.claude/skills` into a throwaway plugin for you.
- **`fired`** — a check or a predicate over the run's trace.
  `check.skill("my-plugin:greet")` asks the harness's adapter, so it works on
  every harness. The id is exact: a `pluginDir` skill is `<plugin name>:<skill>`
  (the name in the plugin's manifest), a `skillsDir` skill is
  `vigiles-loose-skills:<skill>` (the report's `namespace` says which); a function `(t) => boolean` still works. Switching between the
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

### `runEval`, `measure`, `measureArms`

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
report) — [what each passes into the run](../measuring-skills.md#where-a-trial-runs--env).
**`stubs`** takes per-invocation rules for CLIs the agent calls, built with
`experimental_stub`; a call no rule answers is printed to stderr when `runEval`
returns, makes `vigiles eval` exit `2` (the file itself exits `78`) and refuses to write a lock — see
[Stubbing a CLI](../measuring-skills.md#stubbing-a-cli-the-agent-calls--experimental_stub).

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

### Significance &amp; regression gating

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
[Is a cheaper model a valid floor?](../harness-testing.md#is-a-cheaper-model-a-valid-floor-comparebefore-after).

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
import { assertNoRegression } from "vigiles/eval";

const baseline = ".vigiles/eval-baseline.json";

// Record once (then commit the file): `update: true` writes instead of gating.
assertNoRegression(report, { baseline, update: true });

// In CI thereafter — throws on a significant regression:
assertNoRegression(report, { baseline, lowerIsBetter: ["cost"] });
```

A path with no file there (and no `update`) **fails**, naming the `update: true`
call — a gate with nothing to compare against would pass every run.
`baseline` also takes an already-parsed `BaselineFile`. Higher is better by default; list `lowerIsBetter` metrics (cost/latency) to flip
them. A new arm/metric absent from the baseline is skipped (not a regression).

## Exports

### Runners (can spend money)

- `paid_runEval`: run arms x trials of one task and score each trial with a `measure(ctx)` callback.
- `paid_measure`: run one task and score a declarative `checks` array.
- `paid_measureArms`: score the same `checks` per arm (a thing on versus off).
- `paid_measureTriggerRate`: measure whether a skill's description fires on the right prompts and stays quiet on the wrong ones.
- `paid_judge`: grade one output against a rubric with a model, synchronously.
- `paid_judged`: a check that grades the output against a rubric; takes an injectable judge that costs nothing.
- `paid_claudeEvalDriver`: the Claude Code transport the runners use by default, for passing explicitly.
- `experimental_outputStyleArms`: build the with and without arms of an output-style eval from the style file.

### Readers (free, never call a model)

- `compare`: per metric, how far apart two arms are and whether the gap clears the noise floor; given two trigger-rate reports, which prompts were gained and lost.
- `assertImproves`: throw unless an arm beats the baseline on a metric, optionally by a margin and with significance.
- `assertNoRegression`: throw when an arm or metric moves significantly the wrong way against a committed baseline.
- `assertRates`: throw when a check report, an arm and metric, or a trigger-rate report is below a rate; `passK: 1` demands every trial.

### Types

- `ArmComparison`: one metric's comparison result: `gap`, `significant` and the `Verdict`.
- `Verdict`: `better`, `worse`, `no-signal` or `unmeasured`, with the test (Wilson or Welch) behind it.
- `Interval`: a Wilson interval (`lo`, `hi`, `k`, `n`) for a 0/1 metric.
- `TriggerDiff`: the prompts gained, lost, kept or never fired between two trigger-rate runs.
- `DiffOptions`: `alpha` and `lowerIsBetter`, shared by the comparison options.
- `ImprovesGate`: options of `assertImproves`.
- `RegressionGate`: options of `assertNoRegression`; the baseline is a path or a parsed file.
- `BaselineFile`: the committed baseline format (`version`, `recordedAt`, `reports`).
- `RateGate`: the `min` or `passK: 1` threshold shared by the rate gates.
- `CheckRateGate`: `RateGate` plus per-check minimums, for a check report.
- `ArmRateGate`: `RateGate` for one arm and metric of an eval report.
- `TriggerRateGate`: thresholds for a trigger-rate report (`min`, `minPrecision`, `maxFalsePositive`).
- `OutputStyleArms`: the `with` and `without` arms that `experimental_outputStyleArms` returns.
