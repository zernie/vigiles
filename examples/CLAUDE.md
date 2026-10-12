<!-- vigiles:sha256:66d1a7b2e152a1cc compiled from examples/CLAUDE.md.spec.ts -->

# CLAUDE.md

## Positioning

vigiles compiles `.spec.ts` files to instruction files (CLAUDE.md, AGENTS.md, or any markdown target). The spec is the source of truth. The markdown is a build artifact.

The linter cross-referencing engine is the core of the tool: `enforce("@typescript-eslint/no-floating-promises")` verifies the rule exists AND is enabled in your linter config. Same across 11 catalogs — ESLint, Stylelint, Ruff, Clippy, Pylint, RuboCop, Cedar, detekt, ktlint, Checkstyle, and golangci-lint.

`generate-types` is the second half: scans all 11 catalog APIs, package.json, and project files to emit a `.d.ts` with type unions. The TS compiler then PROVES references are valid at authoring time — typos become type errors, not runtime surprises.

## Architecture

Three rule kinds in specs: `enforce()` (delegated to an external linter — vigiles verifies the rule exists and is enabled), `guard()` (a path→command guard, e.g. recompile when a spec changes), and `guidance()` (prose only).

A spec change starts in `src/core/spec.ts` (types + builders) and is compiled to markdown with a SHA-256 hash by `src/core/compile.ts`. Linter cross-referencing (11 catalogs incl. Cedar + JVM/Go) is `src/core/linters.ts`; the `.d.ts` that turns typos into type errors comes from `src/core/generate-types.ts`.

## Commands

- `npm run build` — Compile TypeScript to dist/
- `npm test` — Build and run all tests
- `npm run fmt` — Format with prettier
- `npm run fmt:check` — Check formatting

## Rules

### Zero Config By Default

**Guidance only** — vigiles compile should work with just a .spec.ts file. Config exists only for overrides (maxRules, maxTokens).

### Never Skip Tests

**Guidance only** — All tests must pass. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), install the tool, don't skip the test.

### Dont Reimplement Linters

**Guidance only** — Architectural linting belongs in ast-grep/Dependency Cruiser/Steiger. Per-file code rules belong in ESLint/Ruff/Clippy. vigiles owns: compilation, linter cross-referencing, type generation, and stale reference detection.

### Format Before Commit

**Guidance only** — Run `npm run fmt:check` before committing. Inline code spans in markdown need surrounding spaces to render correctly.

### No Session Links

**Guidance only** — This is a public repo. Claude Code session URLs are private and must not appear in commits or PRs.
