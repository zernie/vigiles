# untested-subagent

Flag a **subagent** (`agents/*.md`) that ships without a test or eval. One of the
per-kind surface-coverage rules alongside [`untested-skill`](untested-skill.md)
and [`untested-hook`](untested-hook.md).

An agent's contract is different from a skill's: it's dispatched by name (via the
`Task` tool) and carries a **tool contract** (`tools:` frontmatter). The test that
matters is "does it honor its contract and produce the right result?" — not "does
its description fire", which is the skill question. An agent with no test is an
unmeasured surface in the deterministic layer.

## Which tier answers what

The two tiers ask the same question of an agent and differ in **who plays the
model** — so a passing deterministic test does not make the eval tier redundant,
and this is the split the coverage nudge now reflects:

| tier                             | model          | what it establishes                                                                  |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| deterministic (`runHarnessTest`) | scripted mock  | the contract parses and the rail holds — `subagent(...)`, `notTool`, `assertAgentOk` |
| eval (`runEval` / `measure`)     | **real**, paid | a real model, handed this agent's prompt, stays inside the contract                  |

Keep the same assertions across both; only the model changes. The typed-outcome
helpers are model-free by design — see
[railway subagents](../railway-subagents.md#test-the-outcome-deterministically).

### `measureTriggerRate` does not apply to an agent

Measured against this build, no model spent:

```
packageSkillsDir("<repo>/agents")                  → THREW: No <name>/SKILL.md
                                                     skills found under <repo>/agents
measureTriggerRateWith({ pluginDir: <agents-only   → rate = 0 | competitors = 0
  plugin> }, fakeRunner)
```

It installs `<name>/SKILL.md` **skills** and decides "fired" by skill
**selection** (`skillResolved`), so an agent is not a surface it can address. The
loose-skills form throws; the plugin form returns a _number_ for a surface it
never installed, which is worse than an error. "Does Claude pick this subagent
when it should?" is a real question — vigiles has no API for it yet.

⚠️ `runEval` / `measure` / `measureArms` drive Claude Code and take **no**
`evalDriver` (only `measureTriggerRate` has that seam, and `runEvalWith` is not
exported from `vigiles/eval`). On a harness other than Claude Code the eval
tier has no public dispatch for a subagent yet — Codex has no subagent dir at all
(`agentDir: ""`), so in practice this concerns OpenCode.

## Configuration

```json
{ "rules": { "untested-subagent": "warn" } }
```

### Severity

| Value              | Behavior                                                |
| ------------------ | ------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero when an agent is untested |
| `"warn"` (default) | Prints a warning, exits 0 — a nudge, not a gate         |
| `false`            | Skip agent coverage entirely                            |

Options (`include`, `exclude`) are shared with the other `untested-*` rules —
see [`untested-skill`](untested-skill.md#options).

## Scope

Scans `agents/*.md` and `.claude/agents/*.md`.

## What counts as "tested"

**A recorded run first** (`.vigiles/coverage.json`), then **colocation** as the
fallback — `agents/bar.harness.mjs` next to `agents/bar.md`. A test elsewhere
that merely NAMES the agent does not count (that tier was removed 2026-08-11).
See
[`untested-skill`](untested-skill.md#what-counts-as-tested) for the shared
mechanics.

**What earns an agent a recorded run** (added 2026-08-12): a **dispatch** in the
transcript — a `tool_use` whose input carries a `subagent_type`, which is what a
passing `subagent("bar", …)` check is asserting on. It is keyed on the input
field rather than the tool name, because the dispatch tool is named `Agent` on
the live CLI and `Task` in older docs. An **errored** dispatch does not count (the
tool was reached and the agent was not), and neither does a call merely named
`Task` with no `subagent_type`.

Before that, no probe could resolve to an agent at all, so an agent proven to run
by a passing `subagent(...)` was still reported here as untested. If the dispatch
is namespaced (`plugin:bar`, which is what `--plugin-dir` reports) the namespace
must be this repo's own plugin name — another plugin's `bar` is not yours.

## Exemptions

Every agent is held to this; the only opt-out is an explicit
`<!-- vigiles:ignore-test -->` marker in the agent file, reported as `exempt`.

## Why

Same as the skill rule: the second layer tests the assembled harness. A subagent
is a high-risk surface (it acts with tools), so leaving it unmeasured is exactly
the gap this family closes. Warning-by-default; flip to `"error"` to gate CI.
