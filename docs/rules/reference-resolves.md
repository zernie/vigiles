# reference-resolves

Flag an **`@path` import** in an instruction file (`CLAUDE.md`, `AGENTS.md`, a
rules file, an imported file) that names a file the repository does not hold.
The harness loads the imported file into context; when it is missing, it loads
nothing in its place and says nothing. One finding per import, at its file and
line:

```
reference-resolves:

  ⚠ .claude/CLAUDE.md:12: @docs/style.md: missing — the harness loads nothing for this import.
```

## What counts as an import

Only what the harness's own instruction chain reads as one: for Claude Code, an
`@path.md` token in prose (never inside a code block or a code span), resolved
from the importing file's directory; for OpenCode, an entry of
`opencode.json#instructions`. Codex has no imports, so the rule finds nothing
there. Links and code-span paths are a different, experimental rule:
[instruction-ref-resolves](instruction-ref-resolves.md).

## How it resolves

Against the repository's **exact path list** (`git ls-files`: tracked files and
untracked ones that are not ignored), never by asking the filesystem:

| Resolution    | Printed as                                                      | Counts |
| ------------- | --------------------------------------------------------------- | ------ |
| missing       | `missing` (with `did you mean …?` for a near sibling name)      | yes    |
| wrong case    | `wrong case: the file is AGENTS.md` — works on a Mac, not on CI | yes    |
| in submodule  | `ℹ` note — the submodule's files are not in this tree           | no     |
| one machine's | not printed (`@AGENTS.local.md` is gitignored by convention)    | no     |
| outside repo  | not printed (`@../x.md` leaves the scanned directory)           | no     |

The path list is why a wrong-case import is caught on a case-insensitive disk
too: `agents.md` is not `AGENTS.md` in the list, whatever the filesystem says.

## Severity and score

`"warn"` by default, `"error"` under `vigiles:recommended`. In the `structural`
group: the harness itself loads the file, so a missing one is a fact, not a
reading of prose. Each finding lowers the audit's Truthfulness ring, and
`audit --json` lists it in `brokenReferences` with `rule`, `from`, `line`,
`kind`, `target` and `resolution`.

| Value     | Behavior                                                 |
| --------- | -------------------------------------------------------- |
| `"error"` | `vigiles lint` exits non-zero on a broken import         |
| `"warn"`  | Prints a warning (and a `::warning` annotation), exits 0 |
| `false`   | Skip the check                                           |

## See also

- [instruction-ref-resolves](instruction-ref-resolves.md) — links and
  code-span paths, from the same reference graph.
- [skill-resource-resolves](skill-resource-resolves.md) — the same question for
  a SKILL.md body.
