# untested-hook

Flag a **compiled hook** whose program ships without a test or eval. One of the per-kind
surface-coverage rules alongside [`untested-skill`](untested-skill.md) and
[`untested-subagent`](untested-subagent.md).

A hook is the most deterministic surface: a process that makes a block/allow
decision. Its natural test is a `runHook` unit test (pipe a synthesized
event, assert the decision) — cheap, no model, runs in CI for free. A hook with no
test is an unmeasured gate in the deterministic layer.

## Configuration

```json
{ "rules": { "untested-hook": "warn" } }
```

### Severity

| Value              | Behavior                                              |
| ------------------ | ----------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero when a hook is untested |
| `"warn"` (default) | Prints a warning, exits 0 — a nudge, not a gate       |
| `false`            | Skip hook coverage entirely                           |

Options (`include`) are shared with the other `untested-*` rules —
see [`untested-skill`](untested-skill.md#options).

## Scope

Reads every hook line the loader reads — the plugin manifest, a plugin's
`hooks/hooks.json`, and the project settings (including the settings a plugin
manifest shadows) — by **identity**, the same reading as
[`hand-written-hook`](hand-written-hook.md#how-a-line-is-read):

| the line                                         | surface                                      |
| ------------------------------------------------ | -------------------------------------------- |
| compiled (the line `vigiles compile` writes)     | its program, e.g. `.vigiles/hooks/x.hook.ts` |
| edited / stale (wires one of the repo's sources) | that source                                  |
| hand-written                                     | none — coverage **not measured**             |

vigiles never parses a hook line, so it does not know what a hand-written line
runs and cannot say whether anything tests it. Those lines are not counted as
untested; the report says how many there are instead:

```
  2 hand-written hook line(s): coverage not measured — vigiles does not read what they run
```

To get a hand-written hook measured, compile it ([compiled hooks](../compiled-hooks.md)).
To check it works today, run it in a test (`runHook`).

## What counts as "tested"

**A recorded run first** (`.vigiles/coverage.json`): `runHook` / `runScript`
name the hook from the command line they executed, so a `vigiles test` run that
fires this hook covers it wherever the test file happens to live — and coverage
prints `MEASURED BY A RUN`; a harness that evaluates a compiled hook in-process
(`experimental_loadHook` + `experimental_assertHookDenies`) records it too. **Colocation second**, as the
fallback: a test named after the program, beside it. A test elsewhere that
merely NAMES the hook does not count (that tier was removed 2026-08-11; it was
crediting these very hooks from the coverage detector's own fixtures). See
[`untested-skill`](untested-skill.md#what-counts-as-tested) for the shared
mechanics and why the three are reported separately.

## Exemptions

Every compiled hook is held to this; the only opt-out is an explicit
`vigiles:ignore-test` marker in the hook program, reported as `exempt`.

## Why

The second layer tests the assembled harness. A hook's block/allow logic is the
cheapest thing to test (the `runHook` unit tier needs no model), so an untested
hook is low-hanging fruit. Warning-by-default; flip to `"error"` to gate CI.
