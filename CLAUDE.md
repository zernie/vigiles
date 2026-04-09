# CLAUDE.md

vigiles — compile typed TypeScript specs to AI instruction files (CLAUDE.md, SKILL.md). Your project's conventions as TypeScript — type-checked at authoring time, proven at build time, compiled to markdown for agents to read.

## Positioning

vigiles compiles `.spec.ts` files to instruction files. The spec is the source of truth. The markdown is a build artifact. Nobody else does this — other tools lint markdown after the fact. vigiles eliminates the problem at the source.

The linter cross-referencing engine is the core moat: `enforce("eslint/no-console")` verifies the rule exists AND is enabled in your ESLint config. Same for Ruff, Clippy, Pylint, RuboCop, and Stylelint. No other tool resolves rules against 6 linter APIs.

## Key Files

- `src/spec.ts` — Type system and builder functions (`enforce`, `guidance`, `prove`, `claude`, `skill`, `file`, `cmd`, `ref`)
- `src/compile.ts` — Compiler: spec → markdown with SHA-256 hash, linter verification, reference validation
- `src/linters.ts` — Linter cross-referencing engine (ESLint, Stylelint, Ruff, Clippy, Pylint, RuboCop)
- `src/cli.ts` — CLI: `compile`, `check`, `init` commands
- `src/action.ts` — GitHub Action wrapper
- `src/spec.test.ts` — Test suite (node:test)
- `examples/CLAUDE.md.spec.ts` — Example CLAUDE.md spec
- `examples/SKILL.md.spec.ts` — Example SKILL.md spec
- `research/` — Design docs: executable-specs.md, feature-ideas.md, competitive-landscape.md

## Commands

- `npm run build` — Compile TypeScript to dist/
- `npm test` — Build and run all tests
- `npm run fmt` — Format with prettier
- `npm run fmt:check` — Check formatting
- `npx vigiles compile` — Compile all .spec.ts → .md files
- `npx vigiles check` — Verify compiled file hashes
- `npx vigiles init` — Scaffold a starter spec

## Architecture

Three rule types in specs: `enforce()` (delegated to external linter), `prove()` (vigiles-owned static check), `guidance()` (prose only). Template literal types ensure linter names and tool names are type-safe.

Compilation: spec.ts → compiler reads spec, validates references (file paths via existsSync, npm scripts via package.json, linter rules via linter APIs), generates markdown with SHA-256 integrity hash.

Core modules: `src/spec.ts` (types + builders), `src/compile.ts` (compiler), `src/linters.ts` (6-linter cross-referencing engine). The linter engine is extracted from v1 and reused — it's the moat.

## Principles

### Never skip or disable tests

**Enforced by:** `code-review`
**Why:** All tests must pass. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), install the tool, don't skip the test.

### Zero config by default

**Enforced by:** `code-review`
**Why:** `vigiles compile` should work with just a .spec.ts file. Config exists only for overrides (maxRules, catalogOnly).

## Rules

### Run `npm run fmt:check` before committing

**Enforced by:** `code-review`
**Why:** Inline code spans in markdown need surrounding spaces to render correctly.

### Never include session links in commits or PRs

**Guidance only** — cannot be mechanically enforced
**Why:** This is a public repo. Claude Code session URLs are private.
