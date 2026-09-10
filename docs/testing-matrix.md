# Testing matrix — what's covered, and how

Every use case of the harness-testing API, mapped to the tier that tests it and
the file that proves it. Two kinds of coverage:

- **Unit** — deterministic, model-free, runs in `npm test` / `npm run test:vitest`
  / `npm run test:jest` / `npm run test:types`. These are the contract.
- **Integration (CI)** — needs the real `claude` CLI and/or a model, so it can't
  be a unit test. Covered by the canonical examples run in the `harness` CI job
  (deterministic tier, no API key) or by `bench/` + `examples` evals (real model).

> **Not the same map as [`CONTRIBUTING.md`](../CONTRIBUTING.md).** This page is about
> the harness-testing **API** — the use cases _you_ test in _your_ harness, and the
> file in this repo that proves each one works. `CONTRIBUTING.md` is about how _this
> repository_ is tested: its twelve tiers, the command that runs each, and which CI
> job (if any) does.

## Coverage

| Use case                                                                                                                                                                                                       | Tier                     | Where                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Hook unit tier — `runHook` (exit codes / stdin event / env / JSON decision)                                                                                                                                    | unit                     | `src/run-hook.test.ts`                                                      |
| Hook decision logic (`parseHookOutput` / `decideHook`)                                                                                                                                                         | unit                     | `src/run-hook.test.ts`                                                      |
| Subagent PreToolUse tool-contract rail — `hook-runtime agent` (parse contract / allow-deny / hook ⇄ allowlist agree / real built-CLI hook via `runHook`; grounded on the vendored `ui-visual-validator`)       | unit                     | `src/adapters/claude-code/agent-runtime.test.ts`                            |
| Plugin loader — inline `plugin.json` hooks                                                                                                                                                                     | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — `hooks` string-path                                                                                                                                                                            | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — `hooks/hooks.json` convention                                                                                                                                                                  | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — repo `.claude/settings.json`                                                                                                                                                                   | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — manifest-wins precedence                                                                                                                                                                       | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — bare dir (no hooks)                                                                                                                                                                            | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — `agents/` + `commands/` materialized + surface warnings                                                                                                                                        | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — empty-machine + MCP + dangling-intra-plugin-ref warnings                                                                                                                                       | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Plugin loader — in-repo dogfood                                                                                                                                                                                | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Vendored **real-plugin** conformance (`loadPlugin` invariants, pinned + offline)                                                                                                                               | unit                     | `src/adapters/claude-code/vendor.test.ts`                                   |
| Dogfood conformance over vigiles's **own** skills (every `SKILL.md` loads + has `name` + non-empty `description`; hook scripts resolve at the plugin root)                                                     | unit                     | `src/adapters/claude-code/skills-dogfood.test.ts`                           |
| Untested-surface detector (`untested-skill`/`untested-subagent`/`untested-hook` rules: colocation + content-reference coverage, `vigiles:ignore-test` opt-out, hook-script discovery)                          | unit                     | `src/test-coverage.test.ts`                                                 |
| `resolveHarness` — merge / passthrough / undefined                                                                                                                                                             | unit                     | `src/adapters/claude-code/plugin-loader.test.ts`                            |
| Eval aggregation (mean / std / se / n / pass^k) + report formatting                                                                                                                                            | unit                     | `src/eval.test.ts`                                                          |
| Eval usage capture + aggregation (`parseUsage` / `aggregateUsage`, cost/latency/tokens)                                                                                                                        | unit                     | `src/eval.test.ts`                                                          |
| Eval record/replay cache (`cacheKey` / snapshot+restore / replay skips the model)                                                                                                                              | unit                     | `src/eval-cache.test.ts`, `src/eval.test.ts`                                |
| Eval concurrency + rate-limit retry + `maxCostUsd` abort (`runPool` / `isRateLimited`)                                                                                                                         | unit                     | `src/eval.test.ts`                                                          |
| Trigger-rate orchestration (`measureTriggerRateWith`)                                                                                                                                                          | unit                     | `src/eval.test.ts`                                                          |
| Significance stats (`welchTTest` / `compareArms` / `tPValueTwoSided` / incomplete-beta vs t-table)                                                                                                             | unit                     | `src/stats.test.ts`                                                         |
| Assert/predicate helpers (create/turns/hook-block; tool used/notUsed/count/sequence/with; skillResolved; output/request-contains; hookFired; improvement/improves; reliable; **significant**; **triggerRate**) | unit                     | `src/harness-assert.test.ts`                                                |
| Matchers register + pass under **vitest** (via the `vigiles/vitest` entry)                                                                                                                                     | unit                     | `test/runners/matchers.vitest.mjs`                                          |
| Matchers register + pass under **jest** (via the `vigiles/jest` entry)                                                                                                                                         | unit                     | `test/runners/matchers.jest.cjs`                                            |
| Matcher **types** augment vitest/jest `expect`                                                                                                                                                                 | unit                     | `test/types/smoke.vitest.ts`, `smoke.jest.ts`                               |
| CLI runner (`discoverScripts`/`runScripts`/summary)                                                                                                                                                            | unit                     | `src/adapters/claude-code/run-scripts.test.ts`                              |
| Judge verdict parsing (`parseJudgeOutput`)                                                                                                                                                                     | unit                     | `src/judge.test.ts`                                                         |
| `runHarnessTest` end-to-end, incl. `plugin:`                                                                                                                                                                   | integration (CI)         | `examples/harness/policy-gate.harness.mjs`, `plugin-cohesion.harness.mjs`   |
| `withHarness` (auto-cleanup wrapper)                                                                                                                                                                           | integration (CI)         | `examples/harness/plugin-cohesion.harness.mjs`                              |
| `runEval` end-to-end, incl. `plugin` arm                                                                                                                                                                       | integration (real model) | `bench/evals/refs-hook.eval.mjs`, `examples/harness/skill-outcome.eval.mjs` |
| `measureTriggerRate` end-to-end (skill activation via `pluginDir`)                                                                                                                                             | integration (real model) | `examples/harness/skill-trigger-rate.eval.mjs`                              |
| Dogfood trigger-rate on vigiles's **own** model-invocable skills (recall + precision via `irrelevantPrompts`)                                                                                                  | integration (real model) | `examples/harness/dogfood/{test-harness,generate-logo}.trigger.eval.mjs`    |
| `judge()` model call                                                                                                                                                                                           | integration (real model) | (parsing is unit-tested; the spawn is not)                                  |

## Surface coverage — which plugin surface is reachable at which tier

A Claude Code plugin/repo has several surfaces. They are reachable at different
tiers, because some only do anything under a real model:

| Surface                                                       | Hook unit (`runHook`) | Deterministic (`runHarnessTest`)    | Eval (`runEval`)                     |
| ------------------------------------------------------------- | --------------------- | ----------------------------------- | ------------------------------------ |
| Hooks — SessionStart / Stop / UserPromptSubmit                | ✅ logic              | ✅ fires in machine                 | ✅                                   |
| Hooks — Bash PreToolUse / PostToolUse                         | ✅ logic              | ✅ fires in machine                 | ✅                                   |
| Hooks — Edit/Write PreToolUse / PostToolUse                   | ✅ logic              | ⚠ headless-gated (drive via Bash)   | ✅                                   |
| Hooks — PreCompact / Notification / SessionEnd / SubagentStop | ✅ logic              | — (mock can't trigger)              | partial                              |
| CLAUDE.md / instruction files                                 | —                     | ✅ present in context               | ✅ moves behaviour                   |
| Skills                                                        | —                     | ✅ resolves via `pluginDir`         | ✅ activation (`measureTriggerRate`) |
| Subagents (`agents/`)                                         | ✅ tool-contract rail | ⚠ materialized; rail not live-armed | ✅ (Task)                            |
| Slash commands (`commands/`)                                  | —                     | ⚠ materialized, not invoked         | ✅                                   |
| MCP servers                                                   | —                     | — (not wired; warned)               | bring-your-own                       |

`loadPlugin(...).warnings` surfaces the ⚠ rows for a given plugin, so a "load the
whole plugin" test never silently runs an empty machine (e.g. a subagents-only
plugin like wshobson/agents `tdd-workflows`, which ships 2 agents + 4 commands
and **no** hooks).

Below the three runtime tiers sits a **static, model-free floor** the table
doesn't have a column for: skills load and resolve with a usable `description`
(`src/adapters/claude-code/skills-dogfood.test.ts`), and `vigiles lint`'s
per-kind [`untested-skill`](rules/untested-skill.md) / [`untested-subagent`](rules/untested-subagent.md) / [`untested-hook`](rules/untested-hook.md) rules flag any skill/hook/subagent
that ships with no test or eval at all — the "is there even a test?" check that
precedes "does the test pass?".

The **subagent tool-contract rail** (`hook-runtime agent`) makes the `agents/` Hook-unit
cell `✅`: the generated `PreToolUse` hook that enforces an agent's declared
`tools:` is `runHook`-testable like any other hook, and the declared list and the
enforced rail are compiled from one source (proven by a round-trip test). The
deterministic cell stays ⚠ for an honest reason — Claude Code doesn't surface the
active subagent to hooks, so arming the rail in a live session
(`.vigiles/active-agent.json`) is still unsolved; the logic is proven at the unit
tier, not yet end-to-end in a real dispatch.

## What is intentionally _not_ unit-tested

Only the real-`claude` subprocess is out of the gate: `runHarnessTest`,
`withHarness`, `judge()`'s model call, and `runEval`/`measureTriggerRate`'s
default `spawnAgent` runner spawn the CLI (and, for evals, a real model). A unit
test can't drive that deterministically — but everything _around_ it is pinned.
The eval **orchestration** (`runEvalWith` / `measureTriggerRateWith`) takes an
**injected runner**, so the loop, cache, concurrency, budget, usage aggregation,
and significance run against canned stream-json with no model; the mock model
(`src/mock-model.ts`), the loader, the parsing, and the matchers are unit-tested
too. End-to-end behaviour is exercised by the example suite in CI: the
deterministic examples (`*.harness.mjs`) run with **no API key** (real `claude` +
scripted mock model), so they're CI-affordable; the evals (`*.eval.mjs`) cost
real model calls and run manually / in a keyed job.

## JavaScript or TypeScript? Both.

`vigiles test` / `vigiles eval` accept harness/eval scripts in **either
language** — the glob is `*.harness.*` / `*.eval.*` over `.mjs` `.cjs` `.js`
`.mts` `.cts` `.ts` (`src/adapters/claude-code/run-scripts.ts`). Discovery is
name-only and scoped to those infixes — **never `*.test.*` / `*.spec.*`** — so it
won't pick up your vitest/jest/Playwright files (and it ignores `node_modules` +
`dist`). A JavaScript file runs as a plain `node <file>`; a TypeScript file is run
through **`tsx`** when it's installed, else **Node's native type stripping**
(Node ≥ 22.6), with an actionable error if neither is available. So you can author
your own tests in TS and get types end-to-end, or in JS for zero setup.

A bare `vigiles eval` (no target) discovers the whole tree, and each eval runs the
**real model on your subscription** — so it **asks before fanning out**: name the
eval(s), pass `--all`, or answer the terminal prompt; headless with none of those,
it refuses (exit 2) rather than spend quota. `vigiles test` is free/deterministic
and always runs. And the deterministic API folds into an existing vitest/jest
suite (`vigiles/vitest` · `vigiles/jest` matchers) — the CLI is the zero-dep floor,
not a required second runner; `eval` stays its own surface (real-model, statistical).

The **API itself is fully TypeScript** — `src/*.ts`, shipped with `.d.ts`; the
whole unit suite (`src/*.test.ts`) and the type smokes (`test/types/*.ts`) are
TypeScript, so the project dogfoods the typed path. Under a runner (vitest /
jest) the `vigiles/vitest` / `vigiles/jest` entries add typed matchers.

The canonical examples under `examples/harness/` stay **`.mjs` on purpose** —
not because TS is unsupported, but because they're the **lowest-common-denominator
demos**: they must run with nothing but Node (no `tsx`, no loader, no build) so a
copy-paste into any repo Just Works and the CLI-fallback tier stays
dependency-free. Your own scripts are under no such constraint — reach for `.ts`
whenever you want types.

- **Zero-dep CLI tier** → `.mjs` (or `.ts` if you have `tsx`/Node ≥ 22.6), via `vigiles test`.
- **Runner tier** → `.ts`, full types via `vigiles/vitest` / `vigiles/jest`.

If you want a typed worked example, the type smokes in
[`test/types/`](../test/types/) show the API used from `.ts` with the matcher
types applied.

## Running the tiers in CI

CI runs **every tier except evals** — not one at a time, and not all crammed into
one job. Each tier runs where it's cheapest, so a fast unit failure surfaces
before the slow, privileged ones.

| Tier                     | Run it with                                  | This repo's CI job           | Needs                         |
| ------------------------ | -------------------------------------------- | ---------------------------- | ----------------------------- |
| Unit (+ coverage gate)   | `npm test` / `npm run coverage`              | `test`                       | nothing (model-free)          |
| Reference verification   | `vigiles lint` (+ the Action via `uses: ./`) | `check`                      | nothing                       |
| Deterministic harness    | `vigiles test` (`*.harness.{mjs,ts}`)        | `harness`                    | the real `claude` CLI, no key |
| e2e (allowlisted egress) | `npm run test:e2e`                           | `e2e` (privileged container) | bubblewrap + slirp4netns      |
| **Eval** (real model)    | `npm run test:eval` (`*.eval.{mjs,ts}`)      | **manual — not in CI**       | model auth ($)                |

**Best practice** (what this maps to): keep the model-free tiers (unit /
reference / deterministic) on every push and PR so feedback is fast and free;
isolate the slow or privileged tiers (real-egress e2e) in their own jobs; and run
the paid **eval** tier on demand, not on every commit — its non-determinism and
cost make it a release/regression gate, not a per-push check. The per-tier
`npm run test:unit | test:integration | test:e2e` scripts exist for exactly this
split (see [`vitest.config.ts`](../vitest.config.ts)).

**Skips are loud, never a silent green.** `vigiles test` classifies each script
pass / skip / fail. A unit-tier `runHook` test needs no `claude` and always runs;
a tier that can't run (deterministic with no `claude`, e2e with no bubblewrap)
reports a loud `⊘ SKIPPED`, tallied separately as "N skipped" — it never counts
as a `✓ passed`. A skip passes by default (capabilities differ per job — this
repo runs the egress tier under `e2e`, not `harness`), but in a CI job that
**asserts** the capability is present, add **`vigiles test --no-skip`** so a
skipped tier **fails**: a green-with-skips is itself untested surface. A standalone
script emits a skip with `skip(reason)` from `vigiles`.

**And so is a file that verified nothing.** A script that exits clean having
recorded **zero** checks reports `∅ … 0 CHECKS`, tallied apart from `passed` — the
shape being a harness that _defines_ tests (`export default { … }`) and never calls
them, which no exit code can distinguish from a pass. Non-fatal by design: it never
turns a build red, and a script that doesn't import `vigiles` cannot report,
so it stays a plain pass. `recordCheck()` reports assertions made another way.

## See also

- [`docs/harness-testing.md`](harness-testing.md) — the full guide (four layers:
  verify-refs / hook unit / deterministic / eval, runner-agnostic usage, plugin
  loader, variance, judge, CLI fallback).
