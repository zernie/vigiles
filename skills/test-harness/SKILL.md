---
name: test-harness
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
description: Install vigiles and test a Claude Code harness — hooks, skills, agents, settings, CLAUDE.md — by picking the right tier (unit / deterministic / eval) and writing a test that passes. Use to check that a hook fires or blocks, that a skill triggers, that injected context lands; or to observe a run — which tools it called, whether it stayed inside its declared allowed-tools, what files and side effects it produced, how to intercept a call without executing it.
---

Test the Claude Code **harness** — the hooks, skills, settings, and CLAUDE.md that
steer an agent — as the assembled machine it ships as. vigiles gives three tiers,
cheapest first; this skill picks the right one, writes the test, and runs it.

The guiding rule: **start at the cheapest tier that can answer the question, and
climb only when it genuinely can't.** Two of the three tiers need no model and no
API key, so they run on every commit for free — reach for the paid real-model
tier only when the question actually requires a real model.

## Step 0 — Pick the tier (the judgment call)

Match what you're testing to the cheapest tier that can answer it:

| What you're testing                                                                                                                    | Tier              | Cost                                             | API                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| "Does this hook block/allow event X?" — pure hook logic, **every** event type (incl. Edit/Write, PreCompact, SessionEnd, SubagentStop) | **Unit**          | free, milliseconds, no `claude`                  | `runHook`                                                                                       |
| "Is the hook actually **wired into** the assembled plugin and does it fire in a real session?"                                         | **Deterministic** | free, no API key (real `claude` + scripted mock) | `runHarnessTest` + `scriptModel`                                                                |
| "Did the injected context (a SessionStart hook, a `/command`) actually **reach the model**?"                                           | **Deterministic** | free, no API key                                 | `runHarnessTest` → `trace.modelRequests` / `check.received`                                     |
| "Does this skill's **description trigger** when it should (recall) **and stay quiet** when it shouldn't (precision)?"                  | **Eval**          | **paid** (real model)                            | `measureTriggerRate` (+ `irrelevantPrompts`) → `assertRates(report, { min, maxFalsePositive })` |
| "Can I measure triggering on a **cheaper model** and trust it as a floor?"                                                             | **Eval**          | **paid** (two runs)                              | `compare(weak, strong)` (from `vigiles/eval`) → `.lost`                                         |
| "Is this exact skill's **output any good**?" — absolute quality, no on/off baseline (the default for testing one skill)                | **Eval**          | **paid** (real model)                            | `measure({ checks: [judged(rubric)] })` → `assertRates({ min })`                                |
| "Does this harness change **move what the agent does**, _relative_ to off?" — A/B lift, regression, signal vs noise                    | **Eval**          | **paid** (real model)                            | `runEval` (arms) + `assertImproves({ significant: true })` (from `vigiles/eval`)                |

Most harness questions — block/allow, wired-in, context-landed — never need a
model. Only "does the model trigger / behave differently" needs the eval tier.

⚠️ **A trigger-rate of 0% on EVERY prompt is a wiring bug until proven otherwise.**
It reads like a verdict on the description, and three separate setup mistakes
produce it: a **bare** id in `fired` where the namespaced `<plugin>:<skill>` is
required; `pluginDir` where a loose `.claude/skills` needs **`skillsDir`**; and a
missing **`fixture`**, since a run starts in an empty directory and a prompt about
a file that isn't there is one the model is right to decline. Rule all three out
before reporting it. (A partial rate is a real number — don't second-guess it.)

**Don't tune against a cheaper model until you've checked it's actually a floor.**
Run the same prompts on both and `compare(weak, strong)` (from `vigiles/eval`):
each prompt in `lost` fired on the weak model but NOT the strong one, which means the weak model is not a
lower bound but a _different router_. Prompts in `gained` (fired only on the strong model)
are expected and are not a failure. Measured once (21 skills, 84 prompts, haiku
vs sonnet): **3 weak-only, and one skill higher on haiku** — so containment is
not established, which is why the floor stays.

If the unit and deterministic tiers can both answer it, **prefer unit**: it's
faster and reaches events the deterministic mock can't drive.

## Step 0.4 — Observing a run, and what it costs

Two questions have their own references — open the one you need, don't guess:

- **"What did the run actually DO?"** — which tools it called, whether it stayed
  inside its declared `allowed-tools`, what it wrote, how to record a call without
  executing it → [`references/observing-a-run.md`](references/observing-a-run.md)
- **"Is this free, sub-priced, or does it need a container?"** — the three buckets,
  and what to tell the user after a paid run →
  [`references/cost-and-expectations.md`](references/cost-and-expectations.md)

Never say "we'll test it" without settling the second one first.

## Step 1 — Ensure vigiles is installed

Check whether `vigiles` is a dependency (`package.json`), and install it as a
dev dependency if not:

```bash
npm i -D vigiles    # or: pnpm add -D vigiles / yarn add -D vigiles
```

The deterministic tier additionally needs the `claude` CLI on PATH (no API key):
`npm i -g @anthropic-ai/claude-code`. The eval tier needs model auth. If the
`claude` CLI is missing, you can still write and run **unit**-tier tests.

## Step 2 — Locate the harness surface to test

Find what the project actually ships, in this order:

1. `.claude/settings.json` / `.claude/settings.local.json` — inline `hooks`.
2. `.claude-plugin/plugin.json` — a plugin manifest (`hooks`, `skills`, `agents`, `mcpServers`).
3. `hooks/hooks.json` — the plugin hooks convention (e.g. obra/superpowers).
4. `skills/<name>/SKILL.md`, `agents/<name>.md`, `commands/<name>.md`.

Pick one concrete thing to pin down — a specific `PreToolUse` hook, a specific
`SessionStart` injection, a specific skill.

## Step 3 — Write the test for the chosen tier

Per-tier skeletons, and the one mistake that silently swallows failures (a
hand-rolled runner eats stderr) →
[`references/writing-tests.md`](references/writing-tests.md)

Read it before writing the file — the skeleton differs per tier, and the runner
warning has cost real debugging time.

## Step 4 — Run it

In a runner (node:test / vitest / jest) the tests are plain async functions. Or
use the zero-setup CLI, which discovers and runs the files:

```bash
npx vigiles test                 # *.harness.{mjs,ts} — unit + deterministic, no API key
npx vigiles eval --trials=6      # *.eval.{mjs,ts} — real model (local / nightly, not CI)
```

Unit-tier `runHook` tests need no `claude` and **always run** — write and run them
even with no `claude` installed. A tier that genuinely can't run reports a loud
`⊘ SKIPPED` (tallied separately, never a fake `✓`); a standalone script emits one
via `skip(reason)` from `vigiles`. A skip passes by default, but in a CI
job that asserts the capability is present, run **`vigiles test --no-skip`** so a
skipped tier fails — a green-with-skips is untested surface. Keep unit +
deterministic tests in CI (free); run evals locally or on a schedule with auth.

## CI — don't hand-write the steps

These tiers belong in CI, and there is a published Action for it. Run `vigiles init`: it
writes `.github/workflows/vigiles.yml`, wiring the Action (`zernie/vigiles@v1`) for the jobs
that can use it plus a plain `npx vigiles test` job for this tier — that one needs
repo-local `node_modules`, which the Action does not install, so it stays hand-rolled on
purpose.

If the repo already has a workflow, the Action's inputs are documented in
[docs/github-action.md](../../docs/github-action.md). Read them there rather than guessing:
the input list is defined in `action.yml`, and a copy of it here would be a second source of
truth that goes stale without anything noticing — which is exactly what happened to this
file's own sibling docs and to a consumer's CI comment, both measured on 2026-08-18.

## Step 5 — Lock the eval so CI stays honest (you do this automatically)

Real-model evals run on the user's subscription — locally, never in CI. So **as
part of writing an eval, you keep its result fresh for them.** Do these two things
without being asked:

1. **Give every eval a `name`.** That's what the lock keys on.
2. **After running it, commit the lock:**

   ```bash
   vigiles eval --update      # records the result → .vigiles/eval-locks/<name>.lock.json
   ```

   Then commit that file. CI runs `vigiles eval --check` (no model) to verify it
   still matches the inputs — so a later edit that forgets to re-eval fails loud
   instead of shipping stale numbers.

**When you later change a skill's description or prompts, re-run `vigiles eval
--update` and commit the updated lock** — the change altered what the eval
measures. (vigiles also nudges you: when a lock exists, a `SKILL.md` edit triggers
a non-blocking reminder.)

Why it's cheap: `--check` only hashes inputs (skill text, prompts, model). A
**threshold** change in the test re-uses the saved numbers (no model); only an
**input** change needs a fresh `--update`. Full mechanics:
[`docs/harness-testing.md`](../../docs/harness-testing.md#keep-eval-results-fresh-in-ci-the-lock).

## When the user didn't say what to test

Don't ask them to specify — **pick something real and demonstrate.** Scan the
harness surface (Step 2), choose the cheapest meaningful test, write it, run it,
and show the result. Good default picks, in order:

1. A `PreToolUse` hook → **unit-test** that it blocks the thing it's meant to block (and allows a safe sibling).
2. A `SessionStart` hook that injects context → **deterministic** test that the text actually reaches the model (`check.received`).
3. A skill → **deterministic** test that it resolves via `pluginDir`, then offer the paid `measureTriggerRate` eval as a follow-up.

Then say which tier you used and why, and offer to climb a tier if the cheaper
test can't fully answer their question.

## Reference

The full guide — every tier, testing skills for real, "fired ≠ landed", the
safe-by-default sandbox, the coverage matrix, and how it compares to promptfoo —
is in [`docs/harness-testing.md`](../../docs/harness-testing.md).
