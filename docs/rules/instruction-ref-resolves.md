# instruction-ref-resolves

Flag a **markdown link** or a **code-span path** in an instruction file, a
subagent or a command that names a path the repository does not hold. The agent
reads the pointer, opens the path and gets nothing. One finding per reference,
at its file and line — a path written on three lines is three findings:

```
instruction-ref-resolves:

  ⚠ web/AGENTS.md:3: `web/CLAUDE.md`: missing — the agent follows the pointer and finds nothing.
  ⚠ .claude/CLAUDE.md:7: ../agents.md: wrong case: the file is `AGENTS.md`, so it resolves only on a case-insensitive disk — the agent follows the pointer and finds nothing.
  ℹ CLAUDE.md:9: `scripts/check.sh`: not found from here; it exists at `packages/x/scripts/check.sh`.
```

## Experimental: off by default, never graded

A code span is prose: whether `` `docs/x.md` `` is a pointer or an example is a
judgment, and the precision of this check has not been measured yet. So it is
in the **`experimental`** group — off unless you turn it on, `warn` when on, and
never in the audit score:

```bash
npx vigiles lint --preset=experimental
```

```json
{ "rules": { "instruction-ref-resolves": "warn" } }
```

## What it reads

- **Sources:** the files the harness's instruction chain classifies (loaded or
  not, compiled ones included), subagent bodies and command bodies. Not hook
  scripts, helper scripts, tests or `docs/` — the harness does not read those
  as pointers. SKILL.md bodies are [skill-resource-resolves](skill-resource-resolves.md).
- **A link:** its destination, resolved from the file's directory (as GitHub
  renders it). Found only from the repository root: a note.
- **A mention:** a code span that is one path-shaped token containing `/` or
  ending in a common file extension, resolved from the file's directory and
  from the root (an agent runs from the root). A trailing `/` names a
  directory; a `:12` line suffix is dropped. Found only under another directory:
  a note.
- **Skipped:** anything inside a fenced or indented code block or an HTML
  comment, URLs, anchors, absolute, `~`- and `$`-rooted paths, globs,
  placeholders (`<name>`), percent-encoded paths, `@scope/pkg` and multi-word
  spans (commands). Commands named in a span (`npm run x`) are not checked yet,
  and `make` targets will not be: there is no parser for a Makefile that does
  not run it.

Resolution is against the repository's exact path list, as for
[reference-resolves](reference-resolves.md): a wrong-case name is caught on any
filesystem, a submodule's files are a note, a path leaving the directory is
silent.

## See also

- [reference-resolves](reference-resolves.md) — `@path` imports, graded.
