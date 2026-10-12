# prefer-compiled-hooks

A **single repo-level recommendation** (one finding regardless of how many hooks
you have): when a plugin/repo ships **hand-written** hook commands that aren't
compiled [`vigiles/hook`](../compiled-hooks.md) artifacts, nudge toward compiling
them. Same detector `vigiles audit` uses (`manualHookCount` in `src/scan.ts`); one
detector, two callers.

This is a **discovery nudge, not a defect**. Hand-written shell hooks are a
first-class, supported lane — so the rule fires **once**, never per-hook, and is
opt-out. The message links the compiled-hooks guide.

## Why compiled hooks

A hook authored as a pure typed function against the closed `vigiles/hook`
vocabulary makes whole classes of hook bugs **unrepresentable at authoring time**:

- you never write the exit code / JSON decision field (the #1 _false-confidence_
  bug — `exit 1` where `2` is needed, the wrong field — a guard that looks like it
  blocks and silently doesn't);
- the matcher is **AST-backed** (catches `cd x && git push -f`, the compound
  bypass a `grep`/substring matcher misses);
- capability = API surface (an import outside `vigiles/hook` doesn't compile);
- the artifact is **stamped** (a later hand-edit is refused at runtime).

A widely-copied OSS safety hook blocks 2/7 of the disaster battery; the compiled
rewrite blocks 7/7. For hooks you already have, [`guardrail-check`](../compiled-hooks.md)
proves whether one actually blocks — regardless of how it was authored.

## What it flags

One nudge when the repo has ≥1 hand-written hook command — a shell script
(`bash ${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh`) or an inline one-liner — that isn't
a vigiles-managed (`hook-runtime run-program`) compiled hook. Silent when there
are no hooks, or every hook is already compiled.

## Honest caveat

This is **form-based** (compiled vs not), so it stays a _recommendation_: it can't
tell a correct hand-written hook from a broken one. The point is discovery and the
authoring-time win, not a quality verdict — keep it opt-out, and use
[`untested-hook`](untested-hook.md) + `guardrail-check` for the "is this hook
actually sound?" question — and, for a NUDGE hook, `assertDelivered` over a
`runHook` result for "does its text reach the model?" (a `PostToolUse` hook that
writes to stderr and exits 0 reaches nobody). That last one is a test, not a lint
finding, on purpose: where a shell script writes and which code it exits with is a
property of its run, not its text. See
[harness-testing.md](../harness-testing.md#assert-a-nudge-reaches-the-model-assertdelivered).

## Configuration

```json
{ "rules": { "prefer-compiled-hooks": "warn" } }
```

### Severity

| Value             | Behavior                                                   |
| ----------------- | ---------------------------------------------------------- |
| `"error"`         | `vigiles lint` exits non-zero (2) — enforce compiled hooks |
| `"warn"`          | Prints one `ℹ` recommendation, exits 0                     |
| `false` (default) | Skip the nudge (the hand-written lane stays first-class)   |

**Off by default.** This is a recommendation, not a defect — the hand-written shell
hook lane is fully supported — so it shouldn't fire unasked. Opt in with `"warn"`
(or `"error"`) when you want the nudge toward compiled hooks.

## Scope

Hook commands in `.claude/settings.json` / `.codex/config.toml [hooks]` and the
plugin manifest, across both shipping harnesses.

## See also

- [Compiled hooks](../compiled-hooks.md) — author a hook as a typed function and
  `compile` it (the thing this rule points you to).
- [untested-hook](untested-hook.md) — a hook that ships without a test/eval.
