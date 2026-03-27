# CLAUDE.md

agent-lint — ESLint for AI agents. Validates that instruction files (CLAUDE.md, AGENTS.md, .cursorrules) have enforcement annotations on every rule.

## Key Files

- `validate.mjs` — Core validation engine: parsing, config loading, CLI entry point
- `validate.test.mjs` — Test suite (node:test). Run with `npm test`
- `action.mjs` — GitHub Action wrapper, reads inputs and calls validatePaths
- `action.yml` — GitHub Action metadata and input definitions
- `package.json` — Dependencies: cosmiconfig, prettier (dev)
- `.claude/settings.json` — PostToolUse hook that validates CLAUDE.md on every edit
- `skills/` — Claude Code skills (enforce-rules-format, audit-feedback-loop, pr-to-lint-rule)

## Commands

- `npm test` — Run all tests
- `npm run fmt` — Format with prettier
- `npm run fmt:check` — Check formatting
- `node validate.mjs CLAUDE.md` — Validate this file
- `node validate.mjs --markers=headings,checkboxes CLAUDE.md` — Validate with both marker types

## Architecture

Single-file core (`validate.mjs`). Exports: `parseClaudeMd`, `validate`, `readClaudeMd`, `validatePaths`, `loadConfig`.

Rules are detected by line-by-line parsing. Two marker types: `###` headings and `- [ ]`/`- [x]` checkboxes (configurable via cosmiconfig). Each rule must have `**Enforced by:**`, `**Guidance only**`, or `<!-- agent-lint-disable -->`.

Named validation rules (togglable in config under `rules`):
- `require-annotations` (default: `true`) — every rule marker needs an enforcement annotation
- `max-lines` (default: `500`) — caps file length; set a number for custom limit, `false` to disable

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
