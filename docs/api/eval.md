# `vigiles/eval`

The moment you **measure**. This entry holds the runners that drive a real model
(every one is named `paid_`, because a call can spend money) and the free readers
that turn their reports into pass or fail.

**For:** people who gate a skill, hook or plugin on a measured number, in CI or
on a laptop. Eval files are run with `npx vigiles eval`, not with `node`.

The runners are CommonJS. Named imports work in Node (`import { assertRates } from
"vigiles/eval"`). If your loader or bundler cannot see the names, use a default
import and destructure it: `import evalApi from "vigiles/eval"; const { compare } =
evalApi;`.

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).
The guides: [measuring skills](../measuring-skills.md),
[the testing API](../testing-api.md) and
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
    fired: check.skill("my-plugin:greet"),
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
