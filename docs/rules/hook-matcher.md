# hook-matcher

Cross-reference each hook's **matcher string** against the harness tool catalog
and MCP server declarations. A matcher that can't select the tool name the
harness emits silently **never fires** — the hook runs zero times with no error,
and the gate it was meant to provide is simply absent.

Same detector `vigiles audit` uses (`hookMatcherIssues` in
`src/core/hook-matcher.ts`); one detector, two callers, no drift.

## A matcher is a pattern, not a tool name

This is the fact the rule is built on, and it was **measured** against the real
`claude` CLI (2.1.226) driven by the scripted mock model — one hook per run, a
marker file the hook writes as the oracle:

| matcher             | tool called                                 | fired  |
| ------------------- | ------------------------------------------- | ------ |
| `Write`             | `Write`                                     | yes    |
| `Writ` / `rit`      | `Write`                                     | **no** |
| `rit.`              | `Write`                                     | yes    |
| `W(rit)e`           | `Write`                                     | yes    |
| `mcp__.*`           | `mcp__some_server__list_events`             | yes    |
| `mcp__.*__.*`       | `mcp__some_server__list_events`             | yes    |
| `mcp__[^_]+__[^_]+` | `mcp__some_server__list_events`             | **no** |
| `mcp__[^_]+__[^_]+` | `mcp__4f54037d-…-6130f3da1ef8__list_events` | yes    |
| `mcp__\w+__\w+`     | `mcp__some_server__list_events`             | yes    |
| `mcp__\w+__\w+`     | `mcp__4f54037d-…-6130f3da1ef8__list_events` | **no** |

Two rules follow, and the detector models exactly these:

1. a matcher with **no regex metacharacter** is compared by string **equality**
   (`rit` does not fire on `Write`, even though it is a substring);
2. a matcher **with** metacharacters is an **unanchored regex** (`rit.` fires on
   `Write`; `mcp__[^_]+__[^_]+` fires on the hyphenated server because `[^_]+`
   only has to reach _into_ the tool segment).

**Why patterns are the correct authoring form for MCP.** The server segment is
not stable: the same Google Calendar server appears as
`mcp__Google_Calendar__list_events` in one session and
`mcp__4f54037d-…__list_events` in another. A hook keyed to one literal id dies
silently when the id changes — so a pattern is the _robust_ choice, not a sloppy
one. Accordingly a pattern is validated by **compiling it and running it against
synthetic probes**, never by checking it against the literal `mcp__server__tool`
shape (see [#131](https://github.com/zernie/vigiles/issues/131) — shape-checking
inverted the verdict on both contested forms).

## What it flags (five kinds)

### tool-typo — close casing / spelling error

A **literal** bare token that is a close typo (edit distance ≤ 2) of a real
built-in tool name:

```jsonc
{ "matcher": "bash" } // never equals the tool name "Bash"
```

→ Did you mean `"Bash"`? Reuses the same `closestTool` helper as
`subagent-tool-contract` (one algorithm, no drift).

### invalid-regex — the matcher doesn't compile

```jsonc
{ "matcher": "mcp__[a-" } // unterminated character class
```

A matcher the regex engine rejects can never match anything. It gets its own
finding rather than being silently treated as valid.

### mcp-form — the pattern can reach no MCP tool name at all

```jsonc
{ "matcher": "mcp_memory_search" }  // single underscores → not a tool name
{ "matcher": "mcp-memory-search" }  // hyphens → not a tool name
{ "matcher": "mcp_memory_*" }       // matches no `mcp__…__…` name
{ "matcher": "^mcp__srv$" }         // anchored so it can't reach the tool segment
```

The probes include a server segment containing an underscore
(`mcp__Google_Calendar__list_events`) and one containing hyphens
(`mcp__4f54037d-…__update_event`), plus probes **derived from the matcher's own
literal segments** — so a correctly scoped `mcp__memory__.*` or
`mcp__memory__search.*` is never called unreachable. When the server segment can
be recovered, the corrected `mcp__<server>__.*` form is suggested.

### mcp-narrow — it fires, but not on real server names

```jsonc
{ "matcher": "mcp__[^_]+__[^_]+" } // can't cross the `_` in `Google_Calendar`
{ "matcher": "mcp__\\w+__\\w+" }   // `\w` can't cross the `-` in the uuid form
```

This is **not** "never fires", and the message says so: it names the probes the
matcher actually misses and suggests `mcp__.*__.*`. Only a matcher that pins **no
literal server** and does match the simplest MCP name is judged here — a matcher
deliberately scoped to one server or a few tools is narrow on purpose and is
never flagged.

### mcp-undeclared — correct form, server not in declared set

```jsonc
{ "matcher": "mcp__ghost__search" } // server "ghost" not declared
```

Mirrors the `mcp-tool-resolves` guard applied to the hook surface.

## FP-safety (high-precision — won't cry wolf)

| Guard                      | What it skips                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Match-all**              | `*`, `.*`, `**`, and the empty matcher are the documented match-everything forms — skipped entirely.                                                                  |
| **Alternation**            | `Edit\|Write`, `mcp__a__b\|Bash` — each arm would have to be judged separately and a mixed arm set is legitimate, so an alternation is skipped.                       |
| **Non-MCP patterns**       | `Bash.*`, `(Read)`, `^Edit$` — a pattern over built-in tool names, not a name; only a literal bare token is typo-checked.                                             |
| **Far unknowns**           | A bare token with no close built-in match (edit distance > 2) is **not** flagged — likely a plugin/MCP tool vigiles doesn't know about.                               |
| **Deliberate scope**       | A matcher pinning a literal server (`mcp__memory__.*`) is never flagged as "too narrow" — narrowness is judged only for matchers meant to be generic.                 |
| **No declared MCP set**    | If the plugin declares no MCP servers, `mcp-undeclared` is **never** raised — the server may exist at the user/project level (the same guard as `mcp-tool-resolves`). |
| **Built-in MCP servers**   | `mcp__ide__…` and other servers in `dialect.knownMcpServers` are allowlisted even when not declared.                                                                  |
| **Plugin-namespaced form** | `mcp__plugin_<name>_<server>__…` is skipped — the join is ambiguous.                                                                                                  |

De-duplicates repeated matchers (same string across multiple entries → one
finding).

**The suggestion converges.** Every `Did you mean` this rule emits is fed back
through the rule by a property test (`src/core/hook-matcher.test.ts`): applying
the advice must produce a clean matcher in one step. That test exists because the
rule once suggested `mcp__.*__.*` for `mcp__.*` and then rejected its own
suggestion, proposing `mcp__.*__.*__.*`, and so on forever.

## Configuration

```json
{ "rules": { "hook-matcher": "warn" } }
```

### Severity

| Value              | Behavior                                                |
| ------------------ | ------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2) on a bad hook matcher |
| `"warn"` (default) | Prints a warning, exits 0                               |
| `false`            | Skip the check                                          |

## Scope

Reads each hook entry's `matcher` field from `.claude/settings.json` and the
plugin manifest (`.claude-plugin/plugin.json` / `hooks/hooks.json`). Runs
against the resolved harness dialect — a Codex repo's tool catalog and MCP
server list are injected via the Codex adapter.

## Why

A hook that never matches is enforcement that silently does nothing — exactly
the "false confidence" failure class vigiles exists to eliminate (the same class
as a guard that `exit 1`s where `2` is required — see
[compiled-hooks.md](../compiled-hooks.md)). But a checker that reports a _working_ matcher
as dead is the same failure with the sign flipped: a user who obeys it ends up
with a hook that lints clean and never runs. That is why the pattern half of this
rule is decided by compiling and probing rather than by how the string looks.

## See also

- [hook-events](hook-events.md) — a hook on a typo'd event name (silently never fires).
- [hook-block-ineffective](hook-block-ineffective.md) — a hook that appears to block but silently doesn't.
- [hook-script-exists](hook-script-exists.md) — a hook whose referenced script is missing.
- [mcp-tool-resolves](mcp-tool-resolves.md) — the same MCP-server guard applied to a subagent's tool contract.
- [docs/compiled-hooks.md](../compiled-hooks.md) — make the whole class of matcher bugs unrepresentable.
