# hand-written-hook

One finding per **hook line vigiles did not write**. vigiles never parses a hook
command line, so it cannot say what a hand-written line runs, whether the script
it starts exists, or whether it swallows its own failure (`|| true`). The finding
names the hook and points at [compiled hooks](../compiled-hooks.md)
(`vigiles/hook`), whose line `vigiles compile` writes itself and
[`hook-script-exists`](hook-script-exists.md) checks exactly.

**Whether a hook works is answered only by running it** — `runHook` in a test,
or `vigiles test` ([harness testing](../harness-testing.md)).

## How a line is read

By **identity**, never by parsing. `vigiles compile` is the only writer of the
lines vigiles owns, and every compile records each hook's role in its stamp
(`.vigiles/hooks/<name>.json`). From those records `lint` rebuilds the exact
lines compile would write — with the same template functions compile calls —
and compares each wired line to them as a string:

| the wired line                                                                 | reading        | finding                                             |
| ------------------------------------------------------------------------------ | -------------- | --------------------------------------------------- |
| equal to a planned line                                                        | compiled       | none here; `hook-script-exists` checks files        |
| names one of the repo's hook sources (compile's merge key) but is not its line | edited / stale | `hook-script-exists`: "edited or stale — recompile" |
| anything else                                                                  | hand-written   | "vigiles did not write this line"                   |

The start-of-session check `compile` wires and the nudges `init` wires for Codex
are planned lines too.

Shell parsing, interpreter lists and "which word is the script" were tried and
removed: each shell shape a parser learned exposed the next one it did not, and
even a perfect parse answers only "does one path exist", never "does the hook
work".

## What it costs

A hand-written hook whose script is missing is **no longer detected
statically**. Compile it, or test it by running it.

In a plugin repo, the hand-written hooks of `.claude/settings.json` are not
listed: the loader reads the manifest's hooks and shadows the settings file.

## Configuration

**Off by default, and not in `vigiles:recommended`.** The only cure this rule
offers is a compiled hook, written with the `experimental_define*` API from
`vigiles/hook`, and lint must not push anyone onto an
[experimental](../experimental.md) API. Opt in if you want the list:

```json
{ "rules": { "hand-written-hook": "warn" } }
```

| Value             | Behavior                          |
| ----------------- | --------------------------------- |
| `"error"`         | `vigiles lint` exits non-zero (2) |
| `"warn"`          | Prints a warning, exits 0         |
| `false` (default) | Skip the check                    |

It joins `vigiles:recommended` when compiled hooks leave experimental — the exit
criteria in [What `experimental_` means](../experimental.md#when-the-prefix-comes-off).
vigiles's own repository opts in at `warn`.

A config that still names `prefer-compiled-hooks` (the one-nudge-per-repo rule
this replaces) is refused with a message naming this rule.

## See also

- [hook-script-exists](hook-script-exists.md) — the files a compiled hook needs.
- [compiled-hooks](../compiled-hooks.md) — writing a hook vigiles can check.
