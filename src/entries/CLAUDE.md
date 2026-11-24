<!-- vigiles:sha256:991a76deda5cb282 compiled from src/entries/CLAUDE.md.spec.ts -->

# CLAUDE.md

## Scope

Working in `src/entries/`? An ENTRY is one row of `package.json` `exports` plus its module here, which only re-exports (the matcher entries `vigiles/vitest` and `vigiles/jest` are the exception: they register side effects, so their modules stay in `src/`). The module mirrors the export path: `vigiles/hook/testing` is `src/entries/hook/testing.ts`, `vigiles` itself is `src/entries/index.ts`. Entries are composition roots, so they may import an adapter. The root `CLAUDE.md` holds the full rule set — read it first; this file adds only the namespace rules.

## Rules

### One Audience Per Entry

**Guidance only** — Each entry serves ONE audience, and each public name lives in exactly ONE entry (gate: one name, one entry, `scripts/export-gates.test.ts`). [Details](../../docs/contributing/rules.md#public-exports-are-opt-in)

### Two Levels Only

**Guidance only** — At most two path levels, and only for a family (`harness/*`, which grows with each harness) or for "X and its tests" (`hook/testing`, the `@angular/core/testing` convention). Everything else stays flat; there is no third level.

### Name Reads To An Outsider

**Guidance only** — An entry's name must read clearly to someone who has never seen this repo: no internal jargon (the word battery was dropped from the name of `vigiles/hook/testing` for this reason). Decide the name before the entry has users.

### Hook Entry Stays Effect Free

**Guidance only** — `vigiles/hook` stays effect-free: it is the only import a compiled hook may have, and `src/hook-entry-effects.test.ts` holds that. Test or loader helpers never go there; they belong in `vigiles/hook/testing`.

### A New Entry Passes The Gates

**Guidance only** — A new entry passes the gates: a release tag on every export, a `STABILITY.md` row, a budget row in `api-surface/budget.json` with an empty grandfather list, and a row in the `ENTRIES` list of `scripts/api-extractor.mjs` (with its report in `api-surface/`). [Details](../../docs/contributing/rules.md#public-exports-are-opt-in)

### Renaming An Entry Is Breaking

**Guidance only** — Renaming or moving an entry is a BREAKING release (`feat!:` with a `BREAKING CHANGE:` footer listing old → new paths, plus a row in the migration table of `docs/testing-api.md`); aliases are not kept.
