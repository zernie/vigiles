# instruction-import-resolves

An `@path` import in an instruction file the harness loads names a file that is
not in the repository. The harness tries to load it and gets nothing, and
nothing tells you. `vigiles lint` and `vigiles audit` report it at the file and
line where the token is written, from the same detector (`unresolvedImports` in
`src/core/instruction-imports.ts`).

Default: `"warn"`. In the `structural` group, so `vigiles:recommended` raises it
to `"error"`. It costs points in the audit's **Truthfulness** ring, for imports
written in committed files.

## What it flags

```markdown
<!-- CLAUDE.md -->

# Project

@docs/style.md
@docs/Testing.md
```

With `docs/style.md` absent and `docs/testing.md` present:

```text
instruction-import-resolves (2):
  ✗ CLAUDE.md:3: @docs/style.md: imports docs/style.md, which does not exist — the harness loads nothing for it.
  ✗ CLAUDE.md:4: @docs/Testing.md: imports docs/Testing.md, but the file is docs/testing.md — it loads on a case-insensitive file system (macOS) and not on Linux or in CI.
```

Three reasons, three different fixes:

- **missing** — nothing in the repository has that path in any letter case.
  Fix the path or delete the line.
- **wrong letter case** — a file exists under another spelling. It loads on
  macOS, whose default file system ignores case, and fails on Linux and in CI.
  Match the file's name exactly.
- **not a file** — something is at that path, but it is a directory, or a
  symlink that points at nothing. Point the import at a file inside the
  directory, or fix the link.

The JSON report carries each finding in `findings` as
`{ "rule", "findings": [{ "path", "line", "subject", "message" }] }`, where
`path` and `line` are where the import is written and `subject` is the token.

## What counts as an import

The harness decides, not vigiles. Each harness adapter reports the imports its
loader follows, already resolved to a repository path, and this rule checks
those paths:

- **Claude Code** — an `@path/to/file.md` token in the prose of a loaded file
  (`CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`). Text
  inside a code block, a code span or an HTML comment is not an import. The
  path is relative to the importing file, as Claude Code resolves it: `@notes.md`
  in `.claude/CLAUDE.md` is `.claude/notes.md`.
- **Codex** — has no import mechanism, so this rule finds nothing there.

Paths an instruction file only _mentions_ — a markdown link, a backticked path,
a file name in a sentence — are not imports, and this rule does not check them.
Whether a path in prose is meant as a pointer is a guess, and a guess does not
belong in a CI gate.

A token that points outside the repository (`/abs/path.md`, `~/x.md`,
`../x.md`) is never followed, so it is not reported either.

An import of a gitignored, per-developer file passes on a machine that has the
file and is reported in a clean checkout, such as CI. If the import is
optional, turn the rule off for the importing file with `overrides`.

An import written in a per-developer file (`CLAUDE.local.md`, or a committed
file that only `CLAUDE.local.md` imports) is reported by `lint` and listed by
`audit`, but it does not cost points. The grade only counts what a teammate's
checkout and CI load, so a gitignored file cannot change it — in either
direction. If a per-developer file stops your copy loading a committed one (a
`CLAUDE.local.md` makes Claude Code skip `AGENTS.md`; a `claudeMdExcludes` in
`.claude/settings.local.json` drops a rule), that file's broken imports still
cost points, though `lint` on your machine does not print them.

## Configure

```json
{ "rules": { "instruction-import-resolves": "error" } }
```

`false` turns it off; its findings then leave the report and the grade.
