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
- `src/validate.ts` — Core validation engine: parsing, config loading, linter checks (v1)
- `src/spec.ts` — v2 spec system: type definitions, builder functions (`enforce`, `guidance`, `prove`, `claude`, `skill`, `file`, `cmd`, `ref`)
- `src/compile.ts` — v2 compiler: spec → markdown with SHA-256 integrity hash
- `src/cli.ts` — CLI entry point: arg parsing, output formatting
- `src/action.ts` — GitHub Action wrapper, reads inputs and calls validatePaths
- `src/validate.test.ts` — v1 test suite (node:test). Run with `npm test`
- `src/spec.test.ts` — v2 spec system tests (31 tests)
- `examples/CLAUDE.md.spec.ts` — Example CLAUDE.md specification
- `examples/SKILL.md.spec.ts` — Example SKILL.md specification
- `action.yml` — GitHub Action metadata and input definitions
- `tsconfig.json` — TypeScript strict-mode configuration
- `package.json` — Dependencies: cosmiconfig, typescript (dev), prettier (dev)
- `.claude/settings.json` — PostToolUse hook that validates CLAUDE.md on every edit
- `skills/` — Claude Code skills (enforce-rules-format, audit-feedback-loop, pr-to-lint-rule)
- `research/` — Product research: competitive landscape, feature ideas, executable specs design

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

TypeScript strict-mode codebase (`src/`). Two systems:

**v1 (validate):** Core engine in `src/validate.ts`. Line-by-line parsing of markdown files. Validates annotations, cross-references linters, checks links. Exports: `parseClaudeMd`, `validate`, `readClaudeMd`, `validatePaths`, `loadConfig`, `findInstructionFiles`, `validateStructure`, `resolveSchema`, `STRUCTURE_PRESETS`, `RULE_PACKS`. All types in `src/types.ts`. Configured via `.vigilesrc.json`.

**v2 (spec/compile):** Spec system in `src/spec.ts`, compiler in `src/compile.ts`. TypeScript `.spec.ts` files compile to markdown instruction files. Three rule types: `enforce()` (linter-backed), `prove()` (vigiles-owned checks), `guidance()` (prose). Template literal types ensure linter names and tool names are type-safe. Generated files carry a SHA-256 hash for tamper detection. See `research/executable-specs.md` for full design.

v1 rules (togglable in `.vigilesrc.json` under `rules`):

- `require-annotations` — every rule marker needs an enforcement annotation. **v2 equivalent:** eliminated by construction (TS types force `enforce`/`prove`/`guidance`)
- `max-lines` — caps file length. **v2 equivalent:** build constraint on compiled output
- `require-rule-file` — validates referenced linter rules exist and are enabled. **v2 equivalent:** absorbed into `enforce()` compilation
- `require-structure` — validates markdown structure via mdschema. **v2 equivalent:** compiler controls output structure
- `no-broken-links` — checks relative markdown links resolve. **v2 equivalent:** `file()` and `ref()` verified at compile time

## Rules

### Run `npm run fmt:check` before committing markdown changes

**Enforced by:** `code-review`
**Why:** Inline code spans in markdown need surrounding spaces to render correctly (e.g., `` `foo` or `bar` `` not `` `foo`or`bar` ``). Run `npm run fmt:check` after editing README.md or other markdown files to catch formatting issues before they reach GitHub.

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
