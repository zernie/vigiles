<!-- vigiles:sha256:29101ba1257948c3 compiled from src/entries/CLAUDE.md.spec.ts -->

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

### Name Says The Role

**Guidance only** — A public name says its role (v53): an ACTION is a verb, and a runner is `run<What>()` returning a result it never throws on; a VALUE (an input, a case set, a fixture handle) is a noun; a CHECK is named after what it OBSERVES, with the constraint in its options (`check.tool(name, { max: 0 })`, `check.egress({ only })`), never in its name; and `assertChecks` / `expect(r).toPass(...)` are the one place that throws. A function that reads a file and returns a structure is a reader (`readSkillContract`), not a check. Three exceptions, named rather than tolerated: a GATE over an aggregate report throws by design (`assertRates`, `assertImproves`, `assertNoRegression`, `assertNoCollision`, `assertAdapterConformance`); an assertion that NARROWS a type throws so the value after it is narrowed (`experimental_assertAgentOk`, `experimental_assertEmittedOk`, `assertAdapterLoadsHooks`); and the AUTHORING vocabularies `vigiles/spec` and `vigiles/hook` name what they declare (`deny("…")`, `file("…")`), so the hook and the spec read as text.

### Renaming An Entry Is Breaking

**Guidance only** — Renaming or moving an entry is a BREAKING release (`feat!:` with a `BREAKING CHANGE:` footer listing old → new paths, plus a row in the migration table of `docs/testing-api.md`); aliases are not kept.
