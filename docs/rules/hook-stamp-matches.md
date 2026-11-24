# hook-stamp-matches

A **compiled** hook's source was edited after `vigiles compile` stamped it, and
was not recompiled. `compile` records a SHA-256 of the hook source in its stamp
(`.vigiles/hooks/<name>.json`); this rule recomputes it and reports every hook
whose source no longer matches.

The runtime runs the same check on every call (`checkHookStamp` in
`src/core/hook-stamp.ts`), so `lint`, `audit` and the runtime cannot disagree
on what "stale" means.

## What happens at run time

| The hook is                                                                               | A stale stamp                                                                                        |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| a tool gate (`bash-gate`, `file-gate`) on an event that vetoes a tool call (`PreToolUse`) | **Refused** (exit 2). The agent repairs it with a file write: the hook back, or `{}` into the stamp. |
| anything else: an inject, a react, a prompt or stop gate, or a tool gate on another event | **Skipped.** One warning on stderr names the fix; the hook body does not run; exit 0.                |

A prompt is never blocked by a stale stamp: nobody can repair a hook by typing
a prompt. But a skipped hook does nothing, and a refused gate refuses every
call — either way the hook is not doing what was compiled. That is why this
rule is an `error`: catch it in CI, not in a session.

## What it flags

```text
✗ .claude/hooks/heartbeat.hook.ts:  edited after it was compiled — it no longer matches its stamp in .vigiles/hooks/heartbeat.hook.ts.json, …
  Fix: run `vigiles compile .claude/hooks/heartbeat.hook.ts`.
```

A stamp cleared by hand (`{}`) is not reported: that is the documented way to
run a hook unstamped. A stamp whose hook source is gone is
[`hook-script-exists`](hook-script-exists.md)'s finding, not this rule's.

## Configuration

```json
{ "rules": { "hook-stamp-matches": "error" } }
```

| Value               | Behavior                          |
| ------------------- | --------------------------------- |
| `"error"` (default) | `vigiles lint` exits non-zero (2) |
| `"warn"`            | Prints a warning, exits 0         |
| `false`             | Skip the check                    |

## Scope

Every stamp under `.vigiles/hooks/` in the scanned directory, on disk
(`vigiles lint`, `vigiles audit`). The in-browser audit of a fetched repository
does not check it: the stamp is a SHA-256 the browser engine cannot compute
synchronously.

## Why

A hook edited without a recompile used to be found by the runtime, on a live
session — once by an `inject` hook on `UserPromptSubmit` that blocked every
prompt while CI stayed green. The runtime no longer blocks a prompt on it; this
rule makes sure the mismatch does not reach a session at all.

## See also

- [hook-script-exists](hook-script-exists.md) — a file a compiled hook line needs is missing.
- [compiled-hooks](../compiled-hooks.md) — writing and compiling a hook.
