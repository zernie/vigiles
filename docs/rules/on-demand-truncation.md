# on-demand-truncation — a file loaded after launch fits the harness's per-file cut

Some instruction files load **after** launch, not at session start:

- a folder's own `CLAUDE.md` (or `AGENTS.md` when the folder has no
  `CLAUDE.md`), the first time the agent reads a file in that folder;
- a rule in `.claude/rules/` with a `paths:` list, when the agent reads a
  matching file;
- a rule in a folder's own `.claude/rules/` (`pkg/.claude/rules/api.md`), the
  first time the agent reads a file in that folder (or, with `paths:`, a
  matching file there).

Such a file is not cheap. Once loaded it **stays until compaction**, and since
Claude Code 2.1.309 the harness **cuts it** past a per-file limit: the model
gets the start and a note to read the rest, and the rules after the cut do not
reach it.

| Model window | Cut per file       | Who runs it                                                   |
| ------------ | ------------------ | ------------------------------------------------------------- |
| 1M           | 150,000 characters | every current default model (Opus 4.7+, Sonnet 5+, Haiku 5.5) |
| 200K         | 40,000 characters  | older models, or `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`           |

A character is counted the way Claude Code counts it: a Latin, Cyrillic or
Chinese letter is one, an emoji two (JavaScript string length). Bytes do not
matter, so a Cyrillic file is cut at the same number of letters as an English
one.

The rule checks each such file against **150,000**: a file over it is cut on
every model a user gets by default. Each file over it is one finding:

```
On-demand truncation (files loaded after launch):

  ✗ pkg/CLAUDE.md is 163,402 chars, over the per-file cut of 150,000: the model gets only the start. Split it, or move lists and records to a file nothing loads; for a copy no session loads, add `**/<folder>/**` to `claudeMdExcludes` (.claude/settings.json).
```

The detector is `checkOnDemandFiles` in `src/core/on-demand-limits.ts`;
`vigiles audit` prints the same measurement under `on-demand files`.

## Why a rule of its own

[`context-creep`](context-creep.md) is about **weight**: what loads at session
start costs tokens on every request, so it may grow up to the harness's limit,
and past it a recorded baseline accepts today's size. This rule is about
**loss**: past the cut, rules never reach the model. No baseline can accept
that, so the two need different switches, and one rule has one severity.

What follows from it:

- **No baseline accepts it.** `--update-baseline` never records such a file,
  and `lint` keeps failing until the file is fixed.
- **Per file, not per folder.** Each file counts on its own, so splitting a
  heavy file into several files under the cut fixes the finding. What the
  folder chain costs in tokens is not gated.
- **A copy is still loaded.** A `CLAUDE.md` copied under `data/` or a vendored
  folder loads the moment a file there is read. If no session should load it,
  say so where the harness reads it: a `**/<folder>/**` pattern in
  `claudeMdExcludes` (`.claude/settings.json`). An `exclude` in
  `.vigilesrc.json` only stops vigiles from reporting it: the harness still
  loads it.

The fix, in order: keep the file to rules for that folder; move lists, indexes
and dated records to a file nothing loads by itself, linked from there; split
what is left into files each under the cut.

## Configuration

```json
{ "rules": { "on-demand-truncation": "error" } }
```

| Value               | Behavior                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `"error"` (default) | `vigiles lint` exits 2 when a file loaded on demand is over the cut |
| `"warn"`            | Prints the finding, exits 0                                         |
| `false`             | Skip the check                                                      |

On by default because a file over the cut silently loses rules on every
default model, and a repository with no such file sees nothing.

### `limit`: if your team runs a 200K window

Lower the cut to that window's in `.vigilesrc.json`:

```json
{
  "rules": {
    "on-demand-truncation": ["error", { "limit": 40000 }]
  }
}
```

Which window a session runs is a per-machine fact (the model each person
picks, an environment variable), so vigiles cannot read it from the
repository. The default is the cut that applies to everyone who did not choose
otherwise; a team that knows it runs the smaller window says so once.

The number is an option, not a second rule, the way ESLint's `max-lines` takes
`max`: the number is the repository's to set. Two rules (an error at 150,000
and a warning at 40,000) would warn most repositories about a setup they do
not use.

`limit` is a positive integer in the harness's unit (characters for Claude
Code); `0`, a fraction or a string is a config error.

## Known limits

- **Imports are not weighed yet.** A file that an on-demand file imports with
  `@` loads with it and is cut the same way, but this check does not read it
  yet ([#560](https://github.com/zernie/vigiles/issues/560)).
- **Codex is not modelled.** Codex builds its chain once, from the root to the
  folder it starts in, and cuts the sum. `vigiles lint` prints the rule as
  **n/a** there, and `vigiles audit` says the check is not modelled.

## See also

- [context-creep](context-creep.md) — the weight of what loads at session
  start, with a baseline.
- [`vigiles audit`](../cli.md) — the full weight report, including the files
  loaded on demand.
