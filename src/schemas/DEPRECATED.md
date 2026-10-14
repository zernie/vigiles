# DEPRECATED — mdschema YAML presets

**Status: deprecated / parked. Nothing in `src/` reads these files.**

These are structure-validation presets for the third-party
[`@jackchuka/mdschema`](https://github.com/jackchuka/mdschema) tool. They were
scaffolded for a planned `require-structure` lint rule (validate a markdown file
against a schema) that was **never built** — there is no `require-structure` rule
in `src/rules/`, `docs/rules/`, `.vigilesrc.json`, or the CLI, and no
code imports `@jackchuka/mdschema`.

They were moved here from the repo-root `schemas/` (2026-07-14) and marked
deprecated rather than deleted, in case the `require-structure` idea is revived.

## If you revive it

Wire a real `require-structure` rule end-to-end (the `rules-docs-in-sync` +
`lint-rule-calibration` rules): a detector, a rule module in `src/rules/`, a
`docs/rules/require-structure.md`, a matrix row, and a `.vigilesrc.json` default.
Then `@jackchuka/mdschema` earns its place in `package.json`.

## If you don't

Delete this directory and remove `@jackchuka/mdschema` from `package.json`
entirely. It currently sits in `devDependencies` (moved out of `dependencies` on
2026-07-14 so it stops shipping ~11 MB of an unused binary to every consumer's
`npm install vigiles`).
