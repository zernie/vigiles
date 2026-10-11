# deprecated-key-files

Warn when an instruction spec (`CLAUDE.md.spec.ts`, `AGENTS.md.spec.ts`, any
`*.md.spec.ts`) still uses the **`keyFiles`** field. This page is the
migration guide.

**Move each entry where it belongs, then remove `keyFiles` from your spec.**
It is **deprecated** and is **removed in
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

Go through the map one entry at a time. Do not just cut it: an entry sometimes
carries a fact that is written nowhere else. Ask the questions below **in
order** and stop at the first that fits. Where each entry goes is your call —
this rule only reports that the field is in use; it cannot know what an entry
means. That the field goes is not optional.

| The entry…                                                                                        | Do this                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1)** says what the file's own header comment, your docs or the path already say                | **Delete it.** Also delete an entry whose path no longer exists (compile was already failing on it).                                                                                                                                                                                                                 |
| **(2)** states a fact about that one file, written nowhere else                                   | **Move it into the file's header comment**, where a reader meets it on opening the file.                                                                                                                                                                                                                             |
| **(3)** is really a rule an agent must follow while working in one folder, not a file description | **Move it into that folder's nested instruction file** — `<folder>/CLAUDE.md` (or `AGENTS.md`), compiled from its own `<folder>/CLAUDE.md.spec.ts`. The harness loads it only when the agent works in that folder, so it stops costing anything elsewhere.                                                           |
| **(4)** points at a file an agent would otherwise not find at all                                 | **Keep a one-line pointer** where the decision that needs it is written, as a `file()` reference in a `prose` section. `vigiles compile` verifies it exists — the same check (`validateFileRef`) a `keyFiles` path had. `guidance()` takes a plain string, so a path typed into a guidance rule is **not** verified. |

When every entry is placed, delete the `keyFiles` field itself. An empty
`keyFiles: {}` is still reported — the migration is removing the field. If
**humans** need a map of what lives where, keep it in that directory's
`README.md`, which the harness does not load on its own.

### Before

```ts
import { instructionFile, guidance } from "vigiles/spec";

export default instructionFile({
  keyFiles: {
    "src/core/spec.ts": "Type system and builder functions",
    "src/legacy/old-api.ts": "Old API",
    "src/core/cache.ts": "Cache — entries expire after 10 minutes",
    "src/db/":
      "Database layer — every query goes through db/query.ts, never raw SQL",
    "tools/release.sh": "Run before tagging a release",
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
    // (4) nothing else leads an agent to the release script: a one-line
    // pointer, next to the decision it belongs to, verified at compile time.
    releasing: prose`Before tagging a release, run ${file("tools/release.sh")}.`,
  },
  rules: {
    "hash-on-compile": guidance(
      "Every compiled file carries an integrity hash; never edit it by hand.",
    ),
  },
  // (1) `src/core/spec.ts` — the path and the file's header say it: deleted.
  // (1) `src/legacy/old-api.ts` — gone from disk: deleted.
  // (2) `src/core/cache.ts` — the 10-minute expiry moved into that file's
  //     header comment.
  // (3) `src/db/` — a rule for the folder: moved into src/db/CLAUDE.md.spec.ts.
});
```

And the new nested spec for (3), compiled to `src/db/CLAUDE.md`:

```ts
import { instructionFile, guidance } from "vigiles/spec";

export default instructionFile({
  rules: {
    "queries-through-one-module": guidance(
      "Every query goes through `db/query.ts`; never write raw SQL elsewhere.",
    ),
  },
});
```

## What it reports

```
Deprecated-key-files check:

  ⚠ CLAUDE.md.spec.ts: `keyFiles` is deprecated and goes away in the next major (230 entries, 45,467 characters compiled into the instruction file). For each entry: delete it if the file or the docs already say it · move a fact about one file into that file's header comment · move a rule for one folder into <folder>/CLAUDE.md · keep a one-line file() pointer only if nothing else leads there (guide: https://github.com/zernie/vigiles/blob/main/docs/rules/deprecated-key-files.md)
```

The nested file is named after the instruction file the reported spec
compiles to (`AGENTS.md` for an `AGENTS.md.spec.ts`). The size is the size of
the compiled `## Key Files` section, rendered the same way `compile` renders
it. A map that is not a literal (a variable, a computed
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
