# CLAUDE.md

vigiles — validates that AI instruction files (CLAUDE.md) have enforcement annotations on every rule, and cross-references those annotations against actual linter configurations.

## Positioning

vigiles is a **bridge between instruction files and linter configs** — not a markdown linter, not a file sync tool. The core value: every rule in your CLAUDE.md either points to a real, enabled linter rule, or explicitly declares itself as guidance-only.

### Goals

<!-- vigiles-disable -->

- Validate instruction file **content quality** (annotations, links, structure)
- **Cross-reference** enforcement claims against real linter APIs (ESLint, Ruff, Clippy, etc.)
- Default to validating `CLAUDE.md` only — configurable via `"files"` in `.vigilesrc.json`
- Zero config by default — works out of the box with no setup

### Non-goals

<!-- vigiles-disable -->

- File sync across agents — use [Ruler](https://github.com/intellectronica/ruler), [rulesync](https://github.com/dyoshikawa/rulesync), or [block/ai-rules](https://github.com/block/ai-rules) for that
- Validating `.claude/` ecosystem (hooks, MCP, plugins) — use [claudelint](https://github.com/pdugan20/claudelint) or [cclint](https://github.com/carlrannaberg/cclint)
- Scoring/grading instruction files (A-F) — use [AgentLinter](https://github.com/seojoonkim/agentlinter)
- Structural checks that mdschema can handle (heading hierarchy, required sections, max depth) — write a schema for `require-structure` instead

### Moat

<!-- vigiles-disable -->

`require-rule-file` is the differentiator. No other tool resolves ESLint builtinRules via Node API, runs `ruff rule`, `cargo clippy --explain`, `pylint --help-msg`, `rubocop --show-cops`, AND checks config-enabled status. Every new rule should ideally require knowing something about the filesystem or linter state that a pure markdown tool can't know.

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
- `research/` — Product research: competitive landscape, feature ideas, pain points, linter design patterns

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
**Why:** vigiles should work out of the box with no config file and no CLI flags. Auto-detect linters and rule markers. Config exists only for overrides, not for basic operation.

### Never skip or disable tests

**Enforced by:** `code-review`
**Why:** All tests must pass, none may be skipped. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), that tool must be installed — not the test skipped. The SessionStart hook in `.claude/settings.json` installs all required tools. If a test fails because a tool is missing, fix the environment, not the test.

## Architecture

TypeScript strict-mode codebase (`src/`). Core engine in `src/validate.ts`. Exports: `parseClaudeMd`, `validate`, `readClaudeMd`, `validatePaths`, `loadConfig`, `findInstructionFiles`, `validateStructure`, `resolveSchema`, `STRUCTURE_PRESETS`, `RULE_PACKS`. All types in `src/types.ts`.

By default, validates `CLAUDE.md` only. Configure `"files"` in `.vigilesrc.json` to validate additional instruction files (e.g., `["CLAUDE.md", "AGENTS.md", ".cursorrules"]`). CLI args override config.

Rules are detected by line-by-line parsing. Two marker types: `###` headings and `- [ ]`/`- [x]` checkboxes (configurable via `.vigilesrc.json`). Each rule must have `**Enforced by:**`, `**Guidance only**`, or `<!-- vigiles-disable -->`.

Two rule packs: `"recommended"` (default) and `"strict"`. Set via `"extends"` in `.vigilesrc.json`. User `"rules"` overrides are merged on top.

Named validation rules (togglable in config under `rules`):

- `require-annotations` (recommended: `true`, strict: `true`) — every rule marker needs an enforcement annotation
- `max-lines` (recommended: `500`, strict: `300`) — caps file length; set a number for custom limit, `false` to disable
- `require-rule-file` (recommended: `"auto"`, strict: `"auto"`) — validates referenced linter rules exist and are enabled in project config; auto-detects eslint, stylelint, ruff, clippy, pylint, rubocop. Set `"catalog-only"` to only check rule existence without config-enabled checks
- `require-structure` (recommended: `false`, strict: `true`) — validates markdown structure via mdschema CLI. Schemas are `.mdschema.yml` files matched to files by glob. Built-in presets: `"claude-md"`, `"claude-md:strict"`, `"skill"`, `"skill:strict"`
- `no-broken-links` (recommended: `true`, strict: `true`) — checks that relative markdown links (`[text](path)`) resolve to existing files. Skips external URLs, anchors, and mailto links. Strips fragments/query strings before checking

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
