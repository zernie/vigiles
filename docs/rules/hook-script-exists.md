# hook-script-exists

A file a **compiled** hook line needs is missing — the hook runtime it starts,
the hook program, or the program's stamp — so the hook cannot run. Same detector
`vigiles audit` uses (`scanHooks` in `src/scan-core.ts`); one detector, two
callers.

A line is compiled only by **identity**: it equals the line `vigiles compile`
writes for one of the repo's hook sources. Its files come from that plan, never
from reading the line. A line vigiles did not write is
[`hand-written-hook`](hand-written-hook.md)'s, and this rule does not look for
its script: vigiles never parses a hand-written hook command line. See that rule
for how a line is read, and for what that costs.

> **Correction, 2026-09-08.** This doc used to say the rule "matches Anthropic's
> own `claude plugin validate`, making vigiles a superset of the official
> validator on the hook surface." **That is false, and it under-sold this rule.**
>
> - **Measured:** `node tools/measure-validate-overlap.mjs` against Claude Code
>   2.1.263. A hook command naming a script that is not on disk passes
>   `claude plugin validate` clean — in the repo-local `.claude/settings.json`
>   form, in the plugin manifest, and via `hooks/hooks.json`, under `--strict`
>   too. Nothing else checks it either, as far as we have run.
> - **The silence is real.** The same tool errors on a `hooks.json` missing its
>   root key and warns on an agent with no description, so it does read these
>   files; it simply does not resolve the path.
> - **What it DOES check on this surface** is the hook **event name** — an
>   unknown one warns `unknown hook event; entry ignored at runtime` — which is
>   a different rule here, [hook-events](hook-events.md). That is where the real
>   overlap lives.
> - **Why the old line was written:** from the other tool's documentation rather
>   than a run of it. It is kept here rather than deleted because a silent
>   deletion reads as a wording change and invites someone to add it back.
> - **What would invalidate this:** a new Claude Code minor. Re-run the probe.

## What it flags

**A compiled line that is no longer its planned line** — `compile`'s merge key
says it wires one of the repo's hook sources, but it is not the line `compile`
writes for it: edited by hand, or compiled by another version (an older vigiles
recorded no role in the stamp). It is vigiles's own wiring gone wrong, so this
rule reports it, "edited or stale — recompile"; the cure is `vigiles compile`.

**A file a compiled line needs is missing.**

`vigiles compile` wires a hook as

```sh
node "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "${CLAUDE_PROJECT_DIR}/.vigiles/hooks/x.hook.mjs" || exit 0
```

Three files must exist: the runtime (`dist/cli.js`), the hook program, and its
stamp (`.vigiles/hooks/x.hook.mjs.json`). The start-of-session check `compile`
wires needs `.vigiles/hook-check.sh`.

**A missing runtime is reported as _not installed_.** It matters more than it
looks, because a reminder hook ends in `|| exit 0` on purpose (it must never
block a session), and that ending turns "the runtime is not there" into the same
silence as "the hook had nothing to say". Nothing else tells the two apart.
Measured 2026-10-11 on this repository: both of its own compiled reminders had
failed to load on every call for three weeks, and no gate noticed.

A **dependency the scan cannot see** is not reported missing: the browser audit
reads a GitHub fetch, which never contains `node_modules`, so there a path under
`node_modules/` is "unresolved". On disk (`vigiles lint`, `vigiles audit`) it is
checked like any other file.

## Configuration

```json
{ "rules": { "hook-script-exists": "error" } }
```

| Value              | Behavior                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2); what `"extends": "vigiles:recommended"` sets |
| `"warn"` (default) | Prints a warning, exits 0                                                       |
| `false`            | Skip the check                                                                  |

## Scope

Compiled hook lines in `.claude/settings.json`, the plugin manifest and Codex's
`.codex/config.toml`. **A repository can be both a plugin and a project.** The
manifest's hooks run for whoever installs the plugin; `.claude/settings.json`
runs for whoever works in the repository. The compiled lines of both are
checked here.

## Why

A compiled hook whose runtime or program is missing is a silent no-op — the
worst kind of failure, because the author believes the guard is in place.

## See also

- [hand-written-hook](hand-written-hook.md) — every hook line vigiles did not write.
- [compiled-hooks](../compiled-hooks.md) — writing a hook vigiles can check.
- [untested-hook](untested-hook.md) — a hook script that ships without a test/eval.
