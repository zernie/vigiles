# deprecated-key-files

Warn when an instruction spec (`CLAUDE.md.spec.ts`, `AGENTS.md.spec.ts`, any
`*.md.spec.ts`) still uses the **`keyFiles`** field. This page is the
migration guide.

**Remove `keyFiles` from your spec.** It is **deprecated** and is **removed in
the next major release** after the one that deprecated it. Until then it still
compiles exactly as before, and this rule is a **warning** — it never changes
`vigiles lint`'s exit code at its default severity, so upgrading vigiles cannot
turn your CI red. Remove the field before you take that major; do not add new
entries to it.

## Why `keyFiles` is going away

`keyFiles` compiles a flat list into your instruction file:

```markdown
## Key Files

- `src/core/compile.ts` — Compiler: spec to markdown with SHA-256 hash
- `src/core/spec.ts` — Type system and builder functions
```

That file is loaded **on every request**. A list of where files are is
something the agent finds itself — it searches the repository with its own
file tools — so every request pays for an answer the agent did not need.
Measured on vigiles' own root spec (2026-10-11): **230 entries, 45,467
characters — 29%** of a 157,872-character instruction file.

Anthropic's guidance for Claude Code says the same. Under what to **exclude**
from `CLAUDE.md`
([Best practices](https://code.claude.com/docs/en/best-practices#write-an-effective-claudemd)):

> Anything Claude can figure out by reading code

> File-by-file descriptions of the codebase

And on size ([How Claude remembers your project](https://code.claude.com/docs/en/memory)):

> **Size**: target under 200 lines per CLAUDE.md file. Longer files consume
> more context and reduce adherence. Move instructions that matter for only
> part of the codebase into path-scoped rules, which load only when Claude
> works with matching files.

> Files in subdirectories load on demand.

## How to remove it, entry by entry

Go through the map one entry at a time and ask what the entry is **for**, then
move or delete it as below. Where each entry goes is your call — this rule only
reports that the field is in use; it cannot know what an entry means. That the
field goes is not optional.

| The entry is…                                              | Do this                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** a pointer a decision depends on                    | Name the file **where that decision is written**, as a `file()` reference in a `prose` section. `vigiles compile` verifies it exists — the same check (`validateFileRef`) a `keyFiles` path had, so moving the file still fails the build. `guidance()` takes a plain string, so a path typed into a guidance rule is **not** verified. |
| **(b)** relevant only when working in one folder           | Move it into **that folder's own nested `CLAUDE.md`** (or its spec). Claude Code loads a subdirectory's `CLAUDE.md` only when it works there, so the pointer stops costing anything elsewhere.                                                                                                                                          |
| **(c)** a plain file or directory map ("what lives where") | **Delete it.** The agent reads the code. If **humans** need the map, keep it in that directory's `README.md`, which the harness does not load on its own.                                                                                                                                                                               |
| **(d)** a path that no longer exists                       | **Delete it.** (Compile was already failing on it.)                                                                                                                                                                                                                                                                                     |

When every entry is placed, delete the `keyFiles` field itself. An empty
`keyFiles: {}` is still reported — the migration is removing the field.

### Before

```ts
import { instructionFile, guidance } from "vigiles/spec";

export default instructionFile({
  keyFiles: {
    "src/core/compile.ts": "Compiler: spec to markdown with SHA-256 hash",
    "src/core/spec.ts": "Type system and builder functions",
    "src/legacy/old-api.ts": "Old API",
  },
  rules: {
    "hash-on-compile": guidance(
      "Every compiled file carries an integrity hash; never edit it by hand.",
    ),
  },
});
```

### After

```ts
import { instructionFile, guidance, file, prose } from "vigiles/spec";

export default instructionFile({
  sections: {
    // (a) the pointer the hash decision depends on, next to that decision —
    // verified at compile time.
    integrity: prose`The integrity hash is written by ${file("src/core/compile.ts")}.`,
  },
  rules: {
    "hash-on-compile": guidance(
      "Every compiled file carries an integrity hash; never edit it by hand.",
    ),
  },
  // (c) `src/core/spec.ts` — a plain map entry: deleted (the agent finds it).
  // (d) `src/legacy/old-api.ts` — gone from disk: deleted.
});
```

## What it reports

```
Deprecated-key-files check:

  ⚠ CLAUDE.md.spec.ts: `keyFiles` is deprecated and goes away in the next major (230 entries, 45,467 characters compiled into the instruction file). Remove `keyFiles` from your spec: name a file a decision depends on where that decision is written, as a file() reference (or in that folder's own nested instruction file), and delete the rest — the agent finds files itself: https://github.com/zernie/vigiles/blob/main/docs/rules/deprecated-key-files.md
```

The size is the size of the compiled `## Key Files` section, rendered the same
way `compile` renders it. A map that is not a literal (a variable, a computed
key or value, a spread) is reported as `not a literal map — size not measured`
rather than guessed.

`vigiles audit` prints the same finding, from the same detector, under
**Deprecated `keyFiles`** next to the always-loaded instruction weight, and
carries it in the JSON report as `deprecatedKeyFiles`. It is advisory there and
does not change the grade.

## How it reads your spec

The spec is **parsed, never run** (a TypeScript syntax tree:
`findKeyFilesInSpecSource` in `src/core/keyfiles-source.ts`, called by the
detector `findDeprecatedKeyFiles` in `src/deprecated-key-files.ts`). A `keyFiles` inside a comment or a string is
not usage and is not reported. Every `**/*.md.spec.ts` is read — the same glob
`vigiles compile` uses — except under `node_modules` and paths your
`.vigilesrc.json` `exclude` lists.

## Configuration

```json
{ "rules": { "deprecated-key-files": "warn" } }
```

`"warn"` is the default. Set `"error"` to make CI fail until every spec is
migrated, or `false` to silence it. It is not part of `vigiles:recommended`: a
deprecation that gated would break a consumer's CI on upgrade, which is exactly
what the one-major window exists to prevent.
