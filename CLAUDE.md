# CLAUDE.md

vigiles — ESLint for AI agents. Validates that instruction files (CLAUDE.md, AGENTS.md, .cursorrules) have enforcement annotations on every rule.

## Key Files

- `src/types.ts` — TypeScript type definitions (interfaces, type aliases)
- `src/validate.ts` — Core validation engine: parsing, config loading, linter checks
- `src/cli.ts` — CLI entry point: arg parsing, output formatting
- `src/action.ts` — GitHub Action wrapper, reads inputs and calls validatePaths
- `src/validate.test.ts` — Test suite (node:test). Run with `npm test`
- `action.yml` — GitHub Action metadata and input definitions
- `tsconfig.json` — TypeScript strict-mode configuration
- `package.json` — Dependencies: cosmiconfig, typescript (dev), prettier (dev)
- `.claude/settings.json` — PostToolUse hook that validates CLAUDE.md on every edit
- `skills/` — Claude Code skills (enforce-rules-format, audit-feedback-loop, pr-to-lint-rule)

## Commands

- `npm run build` — Compile TypeScript to dist/
- `npm test` — Build and run all tests
- `npx tsc --noEmit` — Type-check without emitting
- `npm run fmt` — Format with prettier
- `npm run fmt:check` — Check formatting
- `npx vigiles CLAUDE.md` — Validate this file
- `npx vigiles --markers=headings,checkboxes CLAUDE.md` — Validate with both marker types

## Principles

### Zero config by default

**Enforced by:** `code-review`
**Why:** vigiles should work out of the box with no config file and no CLI flags. Auto-detect instruction files, linters, and rule markers. Config exists only for overrides, not for basic operation.

## Architecture

TypeScript strict-mode codebase (`src/`). Core engine in `src/validate.ts`. Exports: `parseClaudeMd`, `validate`, `readClaudeMd`, `validatePaths`, `loadConfig`, `validateStructure`, `resolveSchema`, `STRUCTURE_PRESETS`, `RULE_PACKS`. All types in `src/types.ts`.

Rules are detected by line-by-line parsing. Two marker types: `###` headings and `- [ ]`/`- [x]` checkboxes (configurable via `.vigilesrc.json`). Each rule must have `**Enforced by:**`, `**Guidance only**`, or `<!-- vigiles-disable -->`.

Two rule packs: `"recommended"` (default) and `"strict"`. Set via `"extends"` in `.vigilesrc.json`. User `"rules"` overrides are merged on top.

Named validation rules (togglable in config under `rules`):

- `require-annotations` (recommended: `true`, strict: `true`) — every rule marker needs an enforcement annotation
- `max-lines` (recommended: `500`, strict: `300`) — caps file length; set a number for custom limit, `false` to disable
- `require-rule-file` (recommended: `"auto"`, strict: `"auto"`) — validates referenced linter rules exist and are enabled in project config; auto-detects eslint, stylelint, ruff, clippy, pylint, rubocop. Set `"catalog-only"` to only check rule existence without config-enabled checks
- `require-structure` (recommended: `false`, strict: `true`) — validates markdown structure via mdschema CLI. Schemas are `.mdschema.yml` files matched to files by glob. Built-in presets: `"claude-md"`, `"claude-md:strict"`, `"skill"`, `"skill:strict"`

## Rules

### Never include session links in commits or PRs

**Guidance only** — cannot be mechanically enforced
**Why:** This is a public repo. Claude Code session URLs (`https://claude.ai/code/session_...`) are private and should not be leaked in commit messages, PR descriptions, or comments.

## Example: Rules as headings

### Always use barrel file imports

**Enforced by:** `eslint/no-restricted-imports`
**Why:** Prevents import path drift during refactoring. All public APIs should be imported from the barrel file, not from internal module paths.

### No console.log in production

**Enforced by:** `eslint/no-console`
**Why:** Use the structured logger (`logger.error`, `logger.info`) which routes to Datadog. Raw console output is invisible in production.

### Use Tailwind spacing scale, no magic numbers

**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency across the design system. Use spacing scale values (`p-4`, `m-8`) instead of arbitrary values (`p-[24px]`).
