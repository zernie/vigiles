# hook-block-ineffective

Flag a **hook that appears to block or deny but silently doesn't** — the most
common hook failure reported upstream ([#45427](https://github.com/anthropics/claude-code/issues/45427),
[#24327](https://github.com/anthropics/claude-code/issues/24327)): `exit 1` where
`2` is required, or the wrong JSON field. The author wires up a guard, the guard
"runs" without error, but nothing is ever prevented.

Two distinct failure shapes are detected:

## What it flags

### wrong-event — blocking mechanism on a NO-EFFECT event

A hook registered on `SessionStart`, `SessionEnd`, `Notification`, or
`PreCompact` that contains a blocking mechanism (`exit 2`, `"decision":"block"`,
`"permissionDecision":"deny"`). On these events a block decision is **silently
ignored entirely** — it can neither veto nor feed the model back (`exit 2` there
writes stderr only to the user). The author believes a gate is in place; nothing
happens.

```sh
#!/bin/sh
# Registered on SessionStart — this exit 2 does nothing (stderr → user only).
exit 2
```

→ flagged as `wrong-event`. Move the gate to a **blocking event** (`PreToolUse`,
`UserPromptSubmit`, `Stop`, or `SubagentStop`) so the deny fires before the action.

> **`PostToolUse` is deliberately NOT flagged.** There, `exit 2` feeds stderr
> back to the model — a legitimate **feedback** channel (a nudge/lint hook), not
> a failed block. A hook that exits 2 on `PostToolUse` _intending_ to block is
> misguided, but that intent isn't deterministically distinguishable from
> feedback, so flagging it would cry wolf on every nudge hook (including
> vigiles's own `refs-nudge.sh`). The don't-cry-wolf line: flag only events where
> a block does **nothing at all**.

### wrong-field — correct event, legacy JSON field

A hook on a permission-gated event (`PreToolUse`) that emits the **legacy**
top-level `"decision":"block"` field instead of the required structured form.
Claude Code ignores the legacy field on permission events; the hook appears to
block but nothing is denied:

```sh
#!/bin/sh
# On PreToolUse the harness only reads permissionDecision — this
# top-level "decision" field is silently discarded.
echo '{"decision":"block"}'
```

→ flagged as `wrong-field`. The correct output is:

```sh
echo '{"hookSpecificOutput":{"permissionDecision":"deny"}}'
```

## FP-safety

The detector is **conservative by design** — default severity is `warn`, never
`error` out of the box:

- **`exit 2`** is matched with a shell-context regex that requires a separator
  before `exit` and a word boundary after `2` — so `exit 200` and
  `--exit-code 2` as an argument are NOT matched.
- **JSON patterns** (`"decision":"block"`, `"permissionDecision":"deny"`) are
  matched as literal substrings — no partial JSON walking.
- Only events in the dialect's **no-effect set** (`SessionStart` / `SessionEnd` /
  `Notification` / `PreCompact`) are flagged for `wrong-event`; everything else —
  including `PostToolUse` (feedback) and the genuinely-blocking events — is left
  alone.
- The **no-effect event set is injected** from the dialect (`noEffectHookEvents`,
  never hard-coded): a Codex adapter injects its own, so the detector is
  harness-neutral (same `core ⊄ adapter` pattern as `verifyHookEvents`). Absent ⇒
  the check doesn't run for that harness.

Same detector used by `vigiles audit` (`scan`) and the `hook-block-ineffective`
lint rule — one detector, two callers, no drift.

## Configuration

```json
{ "rules": { "hook-block-ineffective": "warn" } }
```

### Severity

| Value              | Behavior                                                      |
| ------------------ | ------------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2) on a false-confidence block |
| `"warn"` (default) | Prints a warning, exits 0                                     |
| `false`            | Skip the check                                                |

## Scope

Hook commands in `.claude/settings.json`, `.claude-plugin/plugin.json`, and
`hooks/hooks.json`. Both script-file hooks (content read from disk) and inline
commands (content read from the `command` field directly) are inspected.

## The durable fix

Patching the field or the event assignment removes the immediate finding. But
the **root cause** is that hand-written shell hooks require the author to
correctly choose the exit code, the JSON field, and the event — each a
footgun the compiled-hooks design makes **unrepresentable**:

- You never write the exit code or the field (the compiler emits them from a
  closed vocabulary).
- The role (`experimental_defineHook` / `experimental_definePromptGate` / `experimental_defineStopGate`) constrains
  which events can carry a block decision — a category mistake is a `tsc` error.

Rewriting the hook as a **compiled hook** (`vigiles/hook`) is the durable
solution. See [docs/compiled-hooks.md](../compiled-hooks.md).

## See also

- [hook-script-exists](hook-script-exists.md) — a hook whose script file doesn't exist on disk.
- [hook-events](hook-events.md) — a hook registered under a typo'd event name (silently never fires).
- [hook-matcher](hook-matcher.md) — a hook matcher that silently never matches.
- [docs/compiled-hooks.md](../compiled-hooks.md) — make this class of bug unrepresentable.
