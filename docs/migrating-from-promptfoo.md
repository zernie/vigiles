# Migrating skill evals from promptfoo

> The [README](../README.md) has the pitch; this is the how-to. If you already
> A/B skills with promptfoo and the **metered-API bill** is the pain, this maps
> your setup onto vigiles — same questions, run on your **Claude subscription**
> (`$0` beyond the sub), loading your **real Claude Code / Codex harness** as it
> ships.

## Why move

promptfoo is a solid LLM eval runner, but for **Claude Code / Codex skill**
testing it has two structural costs:

- **It bills per token, every run.** The default `anthropic:` provider hits the
  metered API. Complex skills × trials × redteam matrices is how a suite reaches
  four figures a year.
- **It tests a re-assembled agent, not your shipped harness.** A skill's real
  behavior depends on the assembled harness — the real system prompt + your
  `CLAUDE.md`/`AGENTS.md` + skill selection + hooks. A YAML-configured provider
  can't reproduce that, and the #1 skill question — _does the description actually
  fire?_ — isn't something completion-grading reaches.

vigiles runs the same behavioral checks on the subscription you already pay for,
against the harness loaded the way a user installs it. See
[why it's affordable](measuring-skills.md#why-you-can-afford-to-run-it).

## Concept mapping

| promptfoo                                                | vigiles                                               | Notes                                                     |
| -------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `providers: [anthropic:messages:claude-…]` (metered API) | `model: "sonnet"` on the sub (`apiKeySource: "none"`) | The cost win — your own `claude` CLI, no metered billing. |
| `prompts:` + `tests[].vars`                              | the `task` (+ `paid_measureTriggerRate` prompts)      | One prompt or a varied set.                               |
| a `test` with `assert:`                                  | one `paid_runEval` run with a `checks:` array         | Each assertion becomes a check.                           |
| baseline vs skill (two providers/configs)                | `paid_runEval({ arms: { … }, checks })`               | The A/B is first-class; the delta is the signal.          |
| "did the skill even get used?"                           | `paid_measureTriggerRate` (recall + precision)        | The CC-specific question promptfoo can't cleanly answer.  |
| a whole skill dir installed                              | `pluginDir: "./skills/my-skill"`                      | Loads the real plugin (skills + hooks) natively.          |

## Assertion mapping

Each promptfoo `assert` entry maps to a vigiles check (from `vigiles` — except
`paid_judged`, which calls a model and lives on `vigiles/eval`):

| promptfoo `assert.type` | vigiles check                  | Notes                                                                         |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `contains`              | `check.output("substring")`    | A string matcher is a substring test.                                         |
| `icontains`             | `check.output(/substring/i)`   | Case-insensitive → a regex.                                                   |
| `regex`                 | `check.output(/pattern/)`      |                                                                               |
| `equals`                | `check.output(/^exact$/)`      | Anchor the regex.                                                             |
| `llm-rubric`            | `paid_judged("rubric", …)`     | Model-graded, on the sub. `threshold` → `min`.                                |
| `cost`                  | `check.cost({ maxUsd })`       | vigiles reads the real `total_cost_usd`.                                      |
| `latency`               | `check.latency({ maxMs })`     |                                                                               |
| `javascript` / `python` | a custom `measure((ctx) => …)` | Not auto-portable — read `ctx.file()`/`ctx.output` and return `1/0` yourself. |
| `similar` (embeddings)  | —                              | No direct equivalent; use `paid_judged` or a custom check.                    |

ℹ️ vigiles won't silently pretend to convert what it can't. Anything not in the
table above stays a **deliberate manual step**, not a false green — the same
"valid is not true" discipline vigiles applies everywhere.

## Worked example — one test, side by side

**promptfoo** (`promptfooconfig.yaml`, billed per token):

```yaml
providers: [anthropic:messages:claude-sonnet-4]
prompts: ["Summarize {{doc}} in one sentence."]
tests:
  - vars: { doc: "…" }
    assert:
      - type: icontains
        value: "invoice"
      - type: llm-rubric
        value: "A single, accurate one-sentence summary"
        threshold: 0.7
      - type: cost
        threshold: 0.01
```

**vigiles** (`summary.eval.mjs`, on your subscription — see the runnable
[`examples/harness/from-promptfoo.eval.mjs`](../examples/harness/from-promptfoo.eval.mjs)):

```javascript
import { defineEval, check } from "vigiles"; // free: a description cannot spend
// paid_judged: a Check whose default judge calls a model; assertRates reads the report (free)
import { paid_judged, assertRates } from "vigiles/eval";

export default defineEval({
  runEval: {
    env: { kind: "ephemeral" }, // a throwaway HOME and a scrubbed environment
    task: "Summarize in.txt in one sentence. Write it to out.txt, then stop.",
    fixture: { "in.txt": "…" },
    model: "sonnet",
    trials: 5,
    checks: [
      check.output(/invoice/i), // icontains
      paid_judged("A single, accurate one-sentence summary", { min: 0.7 }), // llm-rubric
      check.cost({ maxUsd: 0.01 }), // cost
    ],
  },
  assert: (report) => assertRates(report, { min: 0.8 }), // each check ≥80% of trials
});
```

Like promptfoo's YAML, the file is a **description**: `npx vigiles eval
summary.eval.mjs` runs it. Unlike a JS file that calls the runner at the top
level, importing it cannot spend anything.

To A/B a skill against no-skill, add `arms: { baseline: {}, skill: { pluginDir: "./skills/my-skill" } }` to the same `runEval` spec and read the per-arm delta with `compare(report, "baseline", "skill")`.

## What moves cleanly — and what doesn't yet

| Your promptfoo tests…                                   | Status on vigiles                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavior / output assertions (contains, regex, rubric)  | ✅ Move cleanly, on the sub.                                                                                                                                                                                                                                                                                                           |
| Cost / latency assertions                               | ✅ Move cleanly (real `total_cost_usd`).                                                                                                                                                                                                                                                                                               |
| "Does the skill fire?"                                  | ✅ Better — `paid_measureTriggerRate` (recall + precision).                                                                                                                                                                                                                                                                            |
| Baseline vs skill A/B                                   | ✅ First-class (`paid_runEval` with `arms` + significance).                                                                                                                                                                                                                                                                            |
| **Redteam suites**                                      | ⚠️ **Not covered.** vigiles has a safety-hook battery (`runGuardrail`) and judged adversarial checks, but **no redteam _generator_**. Keep promptfoo (or your own adversarial prompts) for that.                                                                                                                                       |
| Skills with **real side effects** (write to a DB, etc.) | 🧪 vigiles has an **experimental** tier that runs the skill against a disposable container and checks the real result — [R3](measuring-skills.md#experimental-real-side-effect-testing). promptfoo has **no equivalent** (it grades the model's text; it never runs a real side effect), so this is a capability you _gain_, not lose. |
| `javascript`/`python` assertions                        | ✍️ Manual — port the logic into a custom `measure` callback (the spec field, not the runner).                                                                                                                                                                                                                                          |

## See also

- [Measuring skills](measuring-skills.md) — the full A/B method, the metric triple, and the cost model.
- [Testing your harness](harness-testing.md) — the free deterministic tiers under the eval tier.
