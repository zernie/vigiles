# Configuration

vigiles runs with no configuration at all. `.vigilesrc.json` in your repo root is
how you tell it the few things it cannot work out by looking at the repo.

## Do you need one?

Often not. Run `npx vigiles audit .` first and read what it says — the report
names the key when a key would help:

| what you run into                                                        | the key           |
| ------------------------------------------------------------------------ | ----------------- |
| It grades files that are not yours — a vendored corpus, a frozen fixture | `exclude`         |
| It found skills in a folder no tool reads                                | `harnesses.roots` |
| It guessed the wrong tool, or your repo targets two                      | `harnesses`       |
| Your instructions are not in `CLAUDE.md`                                 | `files`           |
| A rule is noise for this repo, or should be an error                     | `rules`           |
| Your linter keeps its rule docs somewhere unusual                        | `linters`         |

## Where the file goes

`.vigilesrc.json`, in the root of the repo you point vigiles at. One file per
repo: no cascading, no per-directory overrides, no `package.json` field.
`npx vigiles init` writes one for you.

Add `$schema` and your editor will complete key names and underline typos before
you ever run the CLI:

```json
{
  "$schema": "./node_modules/vigiles/dist/vigilesrc.schema.json"
}
```

## A config using every key

Nobody needs all of these at once. This is here so you can see the shapes in one
place and copy the two lines you want:

```json
{
  "$schema": "./node_modules/vigiles/dist/vigilesrc.schema.json",

  "files": ["CLAUDE.md", "docs/AGENT-NOTES.md"],
  "ruleMarkers": ["headings", "checkboxes"],
  "maxRules": 120,
  "maxTokens": 8000,
  "maxSectionLines": 60,

  "harnesses": {
    "claude-code": { "roots": [".ai"] },
    "codex": {}
  },

  "exclude": ["bench", "test/dogfood/**"],
  "sharedDirs": ["packages/shared-skills"],
  "bundles": "all",

  "rules": {
    "hook-events": "error",
    "integrity": "warn",
    "untested-skill": ["warn", { "include": ["tests/{surface}/*.eval.ts"] }]
  },
  "orphans": { "exclude": ["docs/archive/**"] },

  "linters": { "eslint": { "rulesDir": "docs/rules" } },
  "catalogOnly": true,

  "audit": { "measure": false },
  "eval": { "apiVersion": 2 },
  "nudge": "dismissed"
}
```

An unknown key is refused, with the closest known key named:

```
✗ .vigilesrc.json: unknown key "excludes" in (top level). Did you mean "exclude"?
```

---

## Reference

### `files`

The instruction files to check. Relative to the repo root.

> Default: `["CLAUDE.md"]`

```json
{ "files": ["CLAUDE.md", "AGENTS.md"] }
```

### `harnesses`

Which agent tools this repo is written for, and where each one should look.
Leave it out and vigiles works the tool out from what it finds.

> Default: detected from the repo

The names are `claude-code` (`claude` also works) and `codex`. `{}` means "yes,
this repo is written for it, and everything is in the usual place".

Where each tool reads is fixed in its layout descriptor, not in this file:
`vigiles:symbol src/adapters/claude-code/layout.ts#claudeCodeLayout` and
`vigiles:symbol src/adapters/codex/layout.ts#codexLayout`. Those two are the
source of truth for every path named on this page.

```json
{ "harnesses": { "claude-code": {}, "codex": {} } }
```

Name two and both are graded in one report: Claude Code's `CLAUDE.md` and
`.claude/skills`, Codex's `AGENTS.md` and `.agents/skills`. A file that both
tools read is counted once, not twice.

#### `harnesses.<name>.roots`

Extra folders to look in, for skills that live somewhere the tool does not read
by default.

> Default: none

vigiles looks for `skills/`, `agents/` and `commands/` folders in two places: the
repo root, and one level down inside **any** folder whose name starts with a dot.
When it finds one that no tool reads, it says so rather than skipping it quietly:

```
Surfaces no harness reads (1):
  ✗ .ai/skills/ holds 37 skills that no harness vigiles knows about reads, so none of
    it is in this grade.
```

If that folder is yours and you want it graded where it is, name it under the
tool that should read it:

```json
{ "harnesses": { "claude-code": { "roots": [".ai"] } } }
```

Name the **parent** folder, not the skills folder: `".ai"`, not `".ai/skills"`.
Under `claude-code` that one line covers `.ai/skills`, `.ai/agents` and
`.ai/commands`.

It only adds — nothing that was read before stops being read. Name a folder under
a tool that reads nothing there and you get an error rather than a silent no-op,
because Codex keeps its skills in `.agents/skills`:

```
✗ .vigilesrc.json: harnesses["codex"].roots names ".ai", but codex reads no surface
  there — nothing would be graded and nothing would be said.
  Looked for: .ai/.agents/skills/, .ai/prompts/
```

Absolute paths, `"."`, and anything containing `..` are ignored.

### `exclude`

Files in the repo that are not the repo's own: a vendored plugin corpus, a
third-party `CLAUDE.md` kept as benchmark data, a frozen reproduction.

> Default: none. `node_modules`, `dist`, `.git` and `.vigiles` are always excluded.

```json
{ "exclude": ["bench", "test/dogfood/**", "research/frozen-2025"] }
```

A bare folder name excludes its whole subtree — `"bench"`, `"bench/"` and
`"bench/**"` mean the same thing. It applies to every command:

| command         | what it drops                                                     |
| --------------- | ----------------------------------------------------------------- |
| `compile`       | an excluded `*.spec.ts` is not loaded                             |
| `lint`          | instruction files, nested bundles, docs, skills, subagents, hooks |
| `audit`         | the instruction file, discovery, and any declared `roots`         |
| `test` / `eval` | an excluded `*.harness.*` / `*.eval.*` is not discovered          |

It filters discovery only. A path you name on the command line is still
processed, and one line says why:

```
note: bench/old/SKILL.md.spec.ts matches exclude "bench" — compiling because you named it
```

`exclude` beats everything: a folder both excluded and named in `roots` stays
excluded, with no finding either.

### `rules`

Turn an individual check off, or change its severity. Names and what each one
catches are in [what vigiles catches](what-vigiles-catches.md).

> Default: every rule at its built-in severity

```json
{ "rules": { "integrity": "warn", "description-overlap": "off" } }
```

Some rules take options as a second element:

```json
{ "rules": { "coverage": ["warn", { "scripts": 50, "linterRules": 5 }] } }
```

### `ruleMarkers`

Which markdown constructs count as a rule when vigiles reads an instruction
file — headings, checkbox lines, or both.

> Default: `["headings", "checkboxes"]`

```json
{ "ruleMarkers": ["headings"] }
```

### `maxRules`, `maxTokens`, `maxSectionLines`

Budgets for an instruction file: how many rules it may hold, how many tokens it
may cost on every turn, and how long one section may run.

> Default: unset — no budget is enforced

```json
{ "maxRules": 120, "maxTokens": 8000, "maxSectionLines": 60 }
```

See [spec format](spec-format.md) for what counts toward each.

### `linters`

Where a linter keeps its rule documentation, when it is not where vigiles would
look. See [linter support](linter-support.md).

> Default: detected per linter

```json
{ "linters": { "eslint": { "rulesDir": "docs/rules" } } }
```

### `catalogOnly`

Check rule names against the linter's catalog only, without loading the linter
itself. See [linter support](linter-support.md).

> Default: `false`

### `orphans`

Narrows the orphan-docs check — documentation nothing links to — without
changing what the rest of the commands read.

> Default: none

```json
{ "orphans": { "exclude": ["docs/archive/**"] } }
```

`orphans.exclude` narrows this one rule further. It never re-admits a path that
top-level `exclude` already dropped: set both and you get the union.

### `sharedDirs`

Folders holding skills that several bundles in a monorepo share, so they are read
once rather than reported missing in each bundle. See
[skills in a monorepo](skills-monorepo.md).

> Default: none

```json
{ "sharedDirs": ["packages/shared-skills"] }
```

### `bundles`

In a repo that holds several plugin bundles: grade only the root (`"root"`), or
every bundle under it (`"all"`).

> Default: `"root"`

```json
{ "bundles": "all" }
```

Every path in this file — `include`, `exclude`, `sharedDirs` — is relative to the
folder that holds `.vigilesrc.json`, for every bundle, the way ESLint and Ruff
resolve theirs. A nested bundle's findings print that way too
(`plugins/p/skills/x/SKILL.md`, not `skills/x/SKILL.md`), and a finding that names
no file starts with its bundle, e.g. `[plugins/p] MCP server "db" …`.

### `audit`

`{ "measure": false }` stops `audit` from offering to run the checks that call a
real model. See [`audit`](cli.md#audit-dir).

> Default: offered when the terminal is interactive

### `eval`

`{ "apiVersion": 2 }` pins the eval API your harness files are written against.
See [testing API](testing-api.md).

> Default: the current version

### `nudge`

`"dismissed"` silences the one-time setup suggestion vigiles prints on a repo it
has not seen before.

> Default: unset — the nudge is shown once

### `$schema`

A pointer to the published JSON Schema, for editor completion. Accepted and
never read by the CLI.

> Default: unset

```json
{ "$schema": "./node_modules/vigiles/dist/vigilesrc.schema.json" }
```

---

## Upgrading from `harness` / `surfaceRoots`

Both keys are gone, with no alias and no fallback. A config still using them is
refused, and the message writes out the replacement:

```
✗ .vigilesrc.json: "harness" and "surfaceRoots" were replaced by one nested key, "harnesses".
  Write:  { "harnesses": { "claude-code": { "roots": [".ai"] }, "codex": {} } }
  - "harness": ["claude-code", "codex"]  →  a KEY per harness
  - "surfaceRoots": [".ai"]              →  "roots" INSIDE the harness that reads them
```

The old pair read one global folder list under whichever tool happened to be
listed first, so a repo naming both got either its skills or its instruction
file, depending on array order. One nested key has no order to get wrong.
