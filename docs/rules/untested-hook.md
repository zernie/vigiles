# untested-hook

Flag a **hook script** that ships without a test or eval. One of the per-kind
surface-coverage rules alongside [`untested-skill`](untested-skill.md) and
[`untested-subagent`](untested-subagent.md).

A hook is the most deterministic surface: it's a shell/script process that makes a
block/allow decision. Its natural test is a `runHook` unit test (pipe a synthesized
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

Options (`include`, `exclude`) are shared with the other `untested-*` rules —
see [`untested-skill`](untested-skill.md#options).

## Scope

Scans hook scripts referenced from `.claude-plugin/plugin.json`,
`.claude/settings.json`, and `.claude/settings.local.json` (file-backed hooks
only). Inline shell one-liners have nowhere to colocate a test and are not scanned.

## What counts as "tested"

**A recorded run first** (`.vigiles/coverage.json`): `runHook` / `runScript`
name the hook from the command line they executed, so a `vigiles test` run that
fires this hook covers it wherever the test file happens to live — and coverage
prints `MEASURED BY A RUN`. **Colocation second**, as the fallback:
`hooks/pre-edit.harness.mjs` next to `hooks/pre-edit.sh`. A test elsewhere that
merely NAMES the hook does not count (that tier was removed 2026-08-11; it was
crediting these very hooks from the coverage detector's own fixtures). See
[`untested-skill`](untested-skill.md#what-counts-as-tested) for the shared
mechanics and why the three are reported separately.

## Exemptions

Every file-backed hook is held to this; the only opt-out is an explicit
`<!-- vigiles:ignore-test -->` marker in the hook script, reported as `exempt`.

## Why

The second layer tests the assembled harness. A hook's block/allow logic is the
cheapest thing to test (the `runHook` unit tier needs no model), so an untested
hook is low-hanging fruit. Warning-by-default; flip to `"error"` to gate CI.
