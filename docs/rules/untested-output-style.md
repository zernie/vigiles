# untested-output-style

Flag an **output style** that ships without a test or eval. One of the per-kind
surface-coverage rules alongside [`untested-skill`](untested-skill.md),
[`untested-subagent`](untested-subagent.md) and [`untested-hook`](untested-hook.md).

An output style is a file the harness sends to the model with every request of
the main session, chosen by name in the harness settings. It is an instruction
the model follows, so nothing enforces it. A style that says "end every reply
with one status block" or "answer in English" carries behavioural rules, and
without a test nothing notices when it stops loading or stops being followed.

## Configuration

```json
{ "rules": { "untested-output-style": "warn" } }
```

### Severity

| Value              | Behavior                                                       |
| ------------------ | -------------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero when an output style is untested |
| `"warn"` (default) | Prints a warning, exits 0 — a nudge, not a gate                |
| `false`            | Skip output-style coverage entirely                            |

Its severity is its own: setting `untested-hook` does not change how a style is
reported. Options (`include`, `exclude`) are shared with the other `untested-*`
rules — see [`untested-skill`](untested-skill.md#options).

## Scope, per harness

Which files are styles is the harness's own rule, given by its adapter.

| harness     | output styles | what the rule scans                                                                                                                                                           |
| ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | yes           | every lower-case `.md` file under a project's `.claude/output-styles/` or a plugin's `output-styles/`, nested folders and dotfiles included (measured on Claude Code 2.1.291) |
| Codex       | no            | nothing; the scan prints `Output styles: n/a (this harness has none)`                                                                                                         |
| OpenCode    | not built     | nothing yet; the adapter does not describe its styles                                                                                                                         |

Every style counts, whatever it says. vigiles does not try to decide from the
prose whether a style "has rules"; a skill is counted the same way.

## What counts as "tested"

A test named after the style file and sitting beside it:
`.claude/output-styles/status-block.harness.mjs` next to
`.claude/output-styles/status-block.md`. The name comes from the FILE, not from
the name the setting selects, so a style called `Status Block` is covered by
`status-block.harness.mjs`. A test elsewhere that merely names the style does not
count. See [`untested-skill`](untested-skill.md#what-counts-as-tested) for the
shared mechanics.

A harness test can show that the style reached the model — see
[Testing output styles](../testing-output-styles.md). Whether a real model
follows it is an eval-tier question: a style is not selected by the model, so
there is no trigger rate to measure — compare runs with and without the style.

## Exemptions

The only opt-out is an explicit `<!-- vigiles:ignore-test -->` marker in the
style file, reported as `exempt`.

## Why

A style is prose the model reads on every turn, which makes it as much a
behavioural surface as a skill. Warning-by-default; flip to `"error"` to gate CI.
