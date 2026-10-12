# hook-script-exists

Two findings about hook lines, one detector (`scanHooks` in `src/scan-core.ts`,
shared by `vigiles lint` and `vigiles audit`):

1. **A file a hook line runs is missing.** A hook pointing at
   `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh` when that file is not there silently never
   runs: the protection or automation the author wired up does not happen, and
   nothing says so.
2. **A hook line vigiles did not write — one finding per hook.** A static reader
   cannot tell what a hand-written shell line runs or whether it swallows its own
   failure, so vigiles does not guess. It names the hook and points at
   [compiled hooks](../compiled-hooks.md) (`vigiles/hook`), whose command line
   vigiles writes itself and therefore checks exactly.

**Whether a hook works is answered only by running it** — `runHook` in a test, or
`vigiles test` ([harness testing](../harness-testing.md)). Both findings here are
about what can be known without running it.

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

## How a hook line is read

The line is parsed as shell (mvdan-sh), never split as a string, and gets exactly
one of three readings (`hookCommandShape` in `src/core/hook-command.ts`):

| reading    | the line                                                                                                         | what is checked                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `compiled` | one vigiles wrote: `node <runner> hook-runtime <kind> …`, `npx vigiles hook-runtime <kind> …`, the session check | the runner and the program it names exist           |
| `script`   | hand-written, and STARTS by running a literal path: `./hooks/x.sh`, `bash ${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`      | that one file exists; the hook is named (finding 2) |
| `opaque`   | anything else                                                                                                    | nothing is guessed; the hook is named (finding 2)   |

A compiled line is read by the template that writes it, as the WHOLE line (an
optional `|| exit <n>` ending included). A line that mentions our words, or
chains more work after them, is hand-written.

A literal path is a word with a slash that the shell does not compute: no
variable other than the harness's own root (`${CLAUDE_PLUGIN_ROOT}`,
`$CLAUDE_PROJECT_DIR`, either spelling) as its whole first segment, no glob, no
`~`. `bash -x hooks/x.sh`, `sh -c '…'`, `cd "$ROOT" && node hooks/x.mjs`,
`[ -f x ] && x`, `"$HOME"/x.sh` and `bash "${CLAUDE_PROJECT_DIR:-.}/x.sh"` are
all opaque: finding the script in any of them takes the guessing this rule
refuses to do.

## What it flags

```jsonc
"hooks": {
  "PreToolUse": [{
    "matcher": "Bash",
    "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" }]
  }]
}
```

→ `hooks/guard.sh` missing at the plugin root is finding 1; the line itself,
hand-written, is finding 2 whether or not the file is there.

**The runner of a compiled hook is checked too.** `vigiles compile` wires a hook as

```sh
node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/x.hook.mjs" || exit 0
```

Both files must exist: the hook program and the runtime (`dist/cli.js`) that starts it. A missing runtime is reported as **not installed**. It matters more than it looks, because a reminder hook ends in `|| exit 0` on purpose (it must never block a session), and that ending turns "the runtime is not there" into the same silence as "the hook had nothing to say". Nothing else tells the two apart. Measured 2026-10-11 on this repository: both of its own compiled reminders had failed to load on every call for three weeks, and no gate noticed.

A **dependency the scan cannot see** is not reported missing: the browser audit
reads a GitHub fetch, which never contains `node_modules`, so there a path under
`node_modules/` is "unresolved". On disk (`vigiles lint`, `vigiles audit`) it is
checked like any other file. A relative path resolves against the scanned root,
not the scanner's cwd.

## Configuration

```json
{ "rules": { "hook-script-exists": "warn" } }
```

### Severity

| Value              | Behavior                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2); what `"extends": "vigiles:recommended"` sets |
| `"warn"` (default) | Prints a warning, exits 0                                                       |
| `false`            | Skip the check                                                                  |

Under `vigiles:recommended` every hand-written hook fails the lint until it is
compiled (`vigiles/hook`) or the rule is turned down for the path that holds it
(`overrides`).

## Scope

Hook commands in `.claude/settings.json` and the plugin manifest
(`.claude-plugin/plugin.json`, or `hooks/hooks.json`). Codex's
`.codex/config.toml` hooks are read the same way; a relative path resolves
against the project root.

**A repository can be both a plugin and a project.** The manifest's hooks run
for whoever installs the plugin; `.claude/settings.json` runs for whoever works
in the repository. The files the settings name join the existence check (finding
1); finding 2, and the other hook rules, read the hooks the loader chose (the
manifest's).

## Why

A hook is deterministic harness machinery; a hook whose script is missing is a
silent no-op — the worst kind of failure, because the author believes the guard is
in place. And every hand-written line is a place where that failure, or a
swallowed one (`|| true`), can hide from any static reader: tokenizing more shell
shapes only moves the blind spot. A compiled hook removes it.

## See also

- [compiled-hooks](../compiled-hooks.md) — writing a hook vigiles can check.
- [untested-hook](untested-hook.md) — a hook script that ships without a test/eval
  (a different concern: the script exists but is unverified).
