# hook-script-exists

Flag a **hook command that references a script file which doesn't exist** on disk.
A `PreToolUse`/`SessionStart`/… hook pointing at `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`
when that file isn't there silently never runs — the protection or automation the
author wired up simply doesn't happen, with no error. Same detector `vigiles audit`
uses (the hook resolver in `src/scan.ts`); one detector, two callers.

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

```jsonc
"hooks": {
  "PreToolUse": [{
    "matcher": "Bash",
    "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" }]
  }]
}
```

→ flagged if `hooks/guard.sh` doesn't exist at the plugin root.

**The runner of a compiled hook is checked too.** `vigiles compile` wires a hook as

```sh
node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/x.hook.mjs" || exit 0
```

Both files must exist: the hook program and the runtime (`dist/cli.js`) that starts it. A missing runtime is reported as **not installed**. It matters more than it looks, because a reminder hook ends in `|| exit 0` on purpose (it must never block a session), and that ending turns "the runtime is not there" into the same silence as "the hook had nothing to say". Nothing else tells the two apart. Measured 2026-10-11 on this repository: both of its own compiled reminders had failed to load on every call for three weeks, and no gate noticed.

The same goes for a hand-written hook: `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh" || true` with no `x.sh` is flagged. The fail-open ending itself is not a finding. It is the right ending for a reminder; the finding is the path that does not resolve.

## FP-safety

The shared resolver already excludes the cases that aren't real misses:

- **Unresolved `$VAR`** paths (`$HOME/...`, any variable the harness does not set)
  → reported as "unresolved", never "missing" (can't be checked, so not flagged).
  The harness's own root variables do resolve: the plugin root
  (`${CLAUDE_PLUGIN_ROOT}`) and the project root (`$CLAUDE_PROJECT_DIR`), both
  spellings, against the scanned directory.
- **A dependency the scan cannot see.** The browser audit reads a GitHub fetch,
  which never contains `node_modules`, so there a path under `node_modules/` is
  "unresolved". On disk (`vigiles lint`, `vigiles audit`) it is checked like any
  other file.
- **Existence-guarded one-liners** (`[ ! -f x ] || x`, `test -f x && x`) → treated
  as optional, not a hard reference.
- **Inline commands** with no script file (`echo …`, `npx …`) → counted as inline,
  not path-checked.

A relative hook path (`./hooks/x.sh`) resolves against the **plugin root**, not the
scanner's cwd.

**The command is parsed as shell, not scanned as text.** Script operands come from
a real shell parse (mvdan-sh), so the standard portable-plugin idiom

```json
"command": "node -e \"(async()=>{ await import(join(root,'hooks','always-on.mjs')) })()\""
```

is read as what it is — an inline one-liner whose `-e` argument is a _program_,
not a path. Scanning the raw string instead cut a character run out of that
JavaScript and reported it as the hook's missing script, under a name the author
never wrote; that produced nine false "MISSING" findings across a 32-repo sweep
(2026-08-17) and contributed to two `F/0` grades. A script named on the right of
`&&` (`cd "$ROOT" && node hooks/x.mjs`) is still checked: it has to exist whether
or not it runs.

## Configuration

```json
{ "rules": { "hook-script-exists": "warn" } }
```

### Severity

| Value              | Behavior                                                   |
| ------------------ | ---------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2) on a missing hook script |
| `"warn"` (default) | Prints a warning, exits 0                                  |
| `false`            | Skip the check                                             |

## Scope

Hook commands in `.claude/settings.json` and the plugin manifest
(`.claude-plugin/plugin.json`, or `hooks/hooks.json`), across braced/unbraced
`${CLAUDE_PLUGIN_ROOT}` and `$CLAUDE_PROJECT_DIR`. Codex's `.codex/config.toml`
hooks are read the same way; a relative path resolves against the project root.

**A repository can be both a plugin and a project, and both sets are checked.**
The manifest's hooks run for whoever installs the plugin; `.claude/settings.json`
runs for whoever works in the repository. Only the manifest's used to be checked
when both existed. The settings file's hooks now join this existence check; the
other hook rules still read the manifest alone.

## Why

A hook is deterministic harness machinery; a hook whose script is missing is a
silent no-op — the worst kind of failure, because the author believes the guard is
in place. Catching it before it ships closes a real gap (the sweep found broken
hook refs in the wild).

## See also

- [untested-hook](untested-hook.md) — a hook script that ships without a test/eval
  (a different concern: the script exists but is unverified).
