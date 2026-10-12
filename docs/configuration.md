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
| You want the structural rules to fail CI, and to follow new ones         | `extends`         |
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

  "extends": "vigiles:recommended",
  "rules": {
    "hook-events": "warn",
    "integrity": "warn",
    "untested-skill": ["warn", { "include": ["tests/{surface}/*.eval.ts"] }]
  },
  "overrides": [
    { "files": ["notes/**"], "rules": { "require-instructions-spec": "off" } },
    { "files": ["docs/archive/**"], "rules": { "orphan-docs": "off" } }
  ],
  "orphans": { "include": ["docs/**/*.md"] },

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
excluded, with no finding either. To keep a folder read but stop one rule
reporting there, use [`overrides`](#overrides) instead.

### `extends`

Start from a named set of rule severities, then adjust it with `rules`. The one
preset is `vigiles:recommended`. `npx vigiles init` writes it for you.

> Default: none — every rule at its built-in severity

```json
{ "extends": "vigiles:recommended" }
```

`vigiles:recommended` raises the **structural** rules to `error`. These rules
fire only on a real defect, so a well-formed harness stays green:
`subagent-tool-contract`, `subagent-frontmatter`, `hook-events`,
`hook-script-exists`, `mcp-config`, `mcp-tool-resolves`,
`mcp-hook-target-resolves`, `disallowed-tools-contract` and
`description-overlap`. It also gates [`compile-budget`](rules/compile-budget.md):
a compiled instruction file whose Rules section is over 20,000 characters, or
with a section over 15,000 or a `commands` entry over 200, fails `compile` and
`lint`. And it gates
[`require-instructions-spec`](rules/require-instructions-spec.md): a
hand-written `CLAUDE.md` or `AGENTS.md`, nested ones included, fails `lint`
until it has a spec, its folder is excluded, or an [`overrides`](#overrides)
entry turns the rule off there. Every other rule keeps its built-in severity.

**Your `rules` win.** An entry in `rules` overrides the preset, in either
direction:

```json
{
  "extends": "vigiles:recommended",
  "rules": { "description-overlap": "warn" }
}
```

**Why a preset and not the rule list.** The preset is read every time vigiles
runs. When a newer vigiles adds a rule to it, your repo gets that rule on
upgrade — no edit, no re-run of `init`. A list of rules copied into your config
would stay the list from the day you copied it.

⚠️ **Adding a rule to `vigiles:recommended` is a breaking change**, released as
a new major version, because it can turn your CI red with no change on your
side. ESLint treats `eslint:recommended` the same way. Removing a rule from the
preset is not breaking. To control exactly when new rules start failing CI, pin
the vigiles version in `package.json` (the GitHub Action runs that version) or
list the rules yourself in `rules` instead of extending the preset.

An unknown preset name is refused:

```
✗ .vigilesrc.json: extends — Invalid input: expected "vigiles:recommended".
```

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

### `overrides`

Change a rule's severity for some paths only — the folders of a notes repo that
stay hand-written, a docs archive nothing links to, an old plugin you have not
written tests for. One list for every rule, in the shape ESLint, Biome and
Stylelint use: `files` are globs, `rules` are severities.

> Default: none

```json
{
  "extends": "vigiles:recommended",
  "overrides": [
    {
      "files": ["notes/**", "health/**"],
      "rules": { "require-instructions-spec": "off" }
    },
    { "files": ["skills/legacy"], "rules": { "untested-skill": "off" } }
  ]
}
```

**Which setting wins**, from weakest to strongest: the `extends` preset, then
`rules`, then each `overrides` entry whose `files` match the finding's path, in
order — a later entry wins over an earlier one. It is ESLint's cascade.

**Globs** work exactly as in top-level [`exclude`](#exclude): relative to the
repository root, a bare folder name covers its whole subtree, dotfiles match.

**An override sets a severity only** — `"error"`, `"warn"` or `"off"` (and the
other spellings `rules` accepts). A rule's options stay in `rules`; an override
that sets `compile-budget` to `"warn"` keeps the thresholds `rules` gave it.
Options inside an override are refused, as is an unknown rule name (with the
nearest name suggested) and an entry with no `files`.

**An override cannot bring back what `exclude` removed.** `exclude` means
vigiles does not read the path at all, so there is no finding for an override
to change. Use `exclude` for files that are not yours; use an override for
your own files where one rule does not apply.

**Which rules it affects.** An override applies to a finding tied to one file,
at that file's path:

`require-instructions-spec`, `require-skill-spec`, `integrity`, `spec-refs`,
`compile-budget`, `duplicate-rules`, `deprecated-key-files`, `orphan-docs`,
`doc-refs`, `unmarked-refs`, `untested-skill`, `untested-subagent`,
`untested-hook`, `untested-output-style`, `subagent-tool-contract`,
`subagent-frontmatter`, `skill-frontmatter`, `disallowed-tools-contract`,
`frontmatter-valid`, `mcp-tool-resolves`, `lethal-trifecta`,
`delegation-trifecta`, `skill-resource-resolves`, `skill-missing-fence`,
`plugin-dir-layout`.

These rules report about the repository or a settings entry rather than one
file, so an override does not change them — set them in `rules`:

`coverage`, `instruction-weight`, `hook-events`,
`hook-script-exists`, `hook-block-ineffective`, `hook-matcher`, `mcp-config`,
`mcp-hook-target-resolves`, `description-overlap`, `skill-description-budget`.

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

Turns on the orphan-docs check — documentation nothing links to — and says
which files count as docs.

> Default: none (the check is off). `include` defaults to `["docs/**/*.md"]`.

```json
{ "orphans": { "include": ["docs/**/*.md", "research/**/*.md"] } }
```

To stop it reporting a folder, turn `orphan-docs` off there with an
[`overrides`](#overrides) entry; a doc in that folder still counts as a link
that keeps others alive.

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

## Upgrading: `require-instructions-spec` in the preset, and `overrides`

Two changes, released together as a major version.

**`vigiles:recommended` now gates `require-instructions-spec`.** A repo that
extends the preset fails `lint` on every hand-written `CLAUDE.md` or
`AGENTS.md`, nested ones included. The finding says what to do, in order: adopt
the file into a spec (the `adopt-spec` skill, or `npx vigiles init
--target=<path>`); exclude its folder if the file is not yours; or turn the rule
off for the folders that stay hand-written, with an `overrides` entry. A repo
that does not extend the preset sees no change (the built-in severity is still
`warn`), and `"rules": { "require-instructions-spec": "warn" }` keeps the old
behaviour in a repo that does. A bare `npx vigiles init` adopts nested
instruction files too, and the gate-only setup (`--ci-only`) writes the rule as
`"off"`.

**The per-rule `exclude` options moved to `overrides`.** `exclude` inside an
`untested-*` rule's options and `orphans.exclude` are refused, with the
`overrides` entry that does the same thing built from your own globs:

```
✗ .vigilesrc.json: "exclude" inside "orphans" moved to "overrides" — skipping paths is not a rule option any more; an override turns the rule off for them.
  Write:  "overrides": [{ "files": ["docs/archive/**"], "rules": { "orphan-docs": "off" } }]
  and remove "exclude" from "orphans". Paths top-level "exclude" removes are not read at all; an override only changes what a rule reports.
```

The `untested-*` rules shared one set of options, so an `exclude` on any of them
skipped those paths for all four; the suggested entry turns all four off there.
`include` stays a rule option in both places: it says where tests live, and
which files are docs.

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
