<!-- vigiles:sha256:f683550dbdfab721 compiled from examples/CLAUDE.md.spec.ts -->

# CLAUDE.md

## Positioning

vigiles compiles `.spec.ts` files to instruction files (CLAUDE.md, AGENTS.md, or any markdown target). The spec is the source of truth. The markdown is a build artifact.

The linter cross-referencing engine is the core moat: `enforce("@typescript-eslint/no-floating-promises")` verifies the rule exists AND is enabled in your linter config. Same for ESLint, Ruff, Clippy, Pylint, RuboCop, and Stylelint.

`generate-types` is the second moat: scans all 6 linter APIs, package.json, and project files to emit a `.d.ts` with type unions. The TS compiler then PROVES references are valid at authoring time — typos become type errors, not runtime surprises.

## Architecture

Three rule types in specs: `enforce()` (delegated to external tool), `check()` (vigiles-owned filesystem assertion), `guidance()` (prose only).

Core modules: `src/spec.ts` (types + builders), `src/compile.ts` (compiler), `src/linters.ts` (6-linter cross-referencing engine), `src/generate-types.ts` (type generator).

## Key Files

- `src/spec.ts` — Type system and builder functions
- `src/compile.ts` — Compiler: spec → markdown with SHA-256 hash
- `src/linters.ts` — Linter cross-referencing engine (6 linters)
- `src/generate-types.ts` — Type generator: project state → .d.ts
- `src/cli.ts` — CLI: compile, check, init, generate-types, discover, adopt

## Commands

- `npm run build` — Compile TypeScript to dist/
- `npm test` — Build and run all tests
- `npm run fmt` — Format with prettier
- `npm run fmt:check` — Check formatting

## Rules

### Zero Config By Default

**Guidance only** — vigiles compile should work with just a .spec.ts file. Config exists only for overrides (maxRules, maxTokens, catalogOnly).

### Never Skip Tests

**Guidance only** — All tests must pass. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), install the tool, don't skip the test.

### Dont Reimplement Linters

**Guidance only** — Architectural linting belongs in ast-grep/Dependency Cruiser/Steiger. Per-file code rules belong in ESLint/Ruff/Clippy. vigiles owns: compilation, linter cross-referencing, type generation, filesystem assertions, and stale reference detection.

### Format Before Commit

**Guidance only** — Run `npm run fmt:check` before committing. Inline code spans in markdown need surrounding spaces to render correctly.

### No Session Links

**Guidance only** — This is a public repo. Claude Code session URLs are private and must not appear in commits or PRs.
