<!-- vigiles:sha256:4c60cf804aee8709 compiled from src/rules/CLAUDE.md.spec.ts -->

# CLAUDE.md

## Scope

Working in `src/rules/`? This is the RULE layer — vigiles' product lint rules as data, outside core like the adapters. A rule is a module `<id>.ts` implementing core's `RuleSpec` (`src/core/rule.ts`); `groups.ts` is the group record; `index.ts` is the set, which still holds the not-yet-migrated rules as rows (#390). Only a composition root (`src/cli-main.ts`, the browser demo's `runAudit`, the JSON-Schema build) imports `index.ts` and hands the set to core.

## Rules

### What A Rule Declares

**Guidance only** — A rule module declares its POLICY with `defineRule`: `id`, `group` (a key of `RULE_GROUPS`), decidability `bucket`, `surface`, `defaultSeverity`, `cure`, `summary`, the core `detector` it reports, an `options` Zod schema if it takes options, and `findings(scan)` — how each finding reads, off core's `ScanInput`. The detector itself stays in `src/core/`. A rule imports `../core/` only: never another rule, `index.ts`, `groups.ts`, app code or an adapter (`boundaries` refuses each). A rule spells only its own id, and its colocated `<id>.test.ts` too; any other file takes the id from the module (`local/no-rule-ids`).

### Adding A Rule

**Guidance only** — Adding a rule changes three places and no generic file: the module `<id>.ts` (with `<id>.test.ts` beside it), one entry in `RULES` in `index.ts`, and `docs/rules/<id>.md` plus its row in `docs/verifying-instruction-files.md`. Group membership is the rule's `group` field; presets, `init`'s writes and the audit blocks derive from it. A rule module in a GRADED group needs its findings wired to the scorers first (#390) — `index.test.ts` fails until then.
