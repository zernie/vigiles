<!-- vigiles:sha256:320615eea8f67a84 compiled from CLAUDE.md.spec.ts -->

# CLAUDE.md

## Positioning

vigiles compiles `.spec.ts` files to instruction files (CLAUDE.md, AGENTS.md, or any markdown target). The spec is the source of truth. The markdown is a build artifact. Nobody else does this — other tools lint markdown after the fact. vigiles eliminates the problem at the source.

The linter cross-referencing engine is the core moat: `enforce("@typescript-eslint/no-floating-promises")` verifies the rule exists AND is enabled in your linter config. Same for ESLint, Ruff, Clippy, Pylint, RuboCop, and Stylelint. No other tool resolves rules against 6 linter APIs.

`generate-types` is the second moat: scans all 6 linter APIs, package.json, and project files to emit a `.d.ts` with type unions. The TS compiler then PROVES references are valid at authoring time — typos become type errors, not runtime surprises.

vigiles does NOT do architectural linting. Use ast-grep, Dependency Cruiser, Steiger, or eslint-plugin-boundaries for that. vigiles can reference their rules via `enforce()`.

## Architecture

Three rule types in specs:

- `enforce()` — delegated to external tool (linter, ast-grep, dependency-cruiser). vigiles verifies the rule exists and is enabled.
- `check()` — vigiles-owned filesystem assertion (e.g., `every("src/**/*.controller.ts").has("{name}.test.ts")`). Scoped to what no other tool handles.
- `guidance()` — prose only, compiles to `**Guidance only**` in markdown.

Template literal types ensure linter names (`eslint/`, `ruff/`, etc.) are type-safe. Branded types (`VerifiedPath`, `VerifiedCmd`, `VerifiedRef`) distinguish verified references from raw strings.

Compilation: spec.ts → compiler reads spec, validates references (file paths via existsSync, npm scripts via package.json, linter rules via linter APIs), generates markdown with SHA-256 integrity hash.

Core modules: `src/spec.ts` (types + builders), `src/compile.ts` (compiler), `src/linters.ts` (6-linter cross-referencing engine), `src/generate-types.ts` (type generator).

## Key Files

- `src/spec.ts` — Type system and builder functions (enforce, guidance, check, claude, skill, file, cmd, ref)
- `src/compile.ts` — Compiler: spec → markdown with SHA-256 hash, linter verification, reference validation
- `src/linters.ts` — Linter cross-referencing engine (ESLint, Stylelint, Ruff, Clippy, Pylint, RuboCop)
- `src/generate-types.ts` — Type generator: scans linters/package.json/filesystem → emits .d.ts
- `src/cli.ts` — CLI: compile, check, init, setup, generate-types, discover, strengthen, adopt
- `src/action.ts` — GitHub Action wrapper
- `src/spec.test.ts` — Spec + compiler test suite (node:test)
- `src/validate.test.ts` — Validation test suite (node:test)
- `src/cli.test.ts` — CLI integration + E2E test suite (node:test)
- `CLAUDE.md.spec.ts` — This file — the source of truth for CLAUDE.md
- `examples/SKILL.md.spec.ts` — Example SKILL.md spec
- `research/adoption-strategy.md` — Adoption strategy: zero-config setup, progressive enforcement, agent workflows
- `research/competitive-landscape.md` — Competitive landscape: rule-porter, rulesync, vibe-cli, Ruler
- `research/executable-specs.md` — Design doc: executable spec system
- `research/feature-ideas.md` — Feature ideas: plugin API, custom rules, exhaustive coverage
- `research/ai-code-quality.md` — Research: AI code quality patterns
- `docs/agent-workflows.md` — Agent-specific workflows (Claude Code, Codex, multi-agent, Cursor)
- `docs/agent-setup.md` — Non-interactive agent setup guide (hooks via settings.json)
- `docs/spec-format.md` — Spec format reference (target, sections, rules)
- `docs/linter-support.md` — Linter support details (6 linters + generate-types)

## Commands

- `npm run build` — Compile TypeScript to dist/
- `npm test` — Build and run all tests
- `npm run fmt` — Format with prettier
- `npm run fmt:check` — Check formatting

## Rules

### Never Skip Tests

**Guidance only** — All tests must pass. If a test requires a CLI tool (pylint, rubocop, ruff, clippy), install the tool, don't skip the test.

### Zero Config By Default

**Guidance only** — `vigiles compile` should work with just a .spec.ts file. Config exists only for overrides (maxRules, maxTokens).

### Dont Reimplement Linters

**Guidance only** — Architectural linting belongs in ast-grep/Dependency Cruiser/Steiger. Per-file code rules belong in ESLint/Ruff/Clippy. vigiles owns: compilation, linter cross-referencing, type generation, filesystem assertions, and stale reference detection.

### Smooth Adoption

**Guidance only** — `npx vigiles setup && npx skills add zernie/vigiles` must work on first run with zero config. The wizard auto-detects the project, creates specs, generates types, compiles, and wires CI. After install the agent edits specs automatically — no workflow change required. Start permissive (guidance rules, `require-spec: false` available), tighten over time. See `research/adoption-strategy.md`.

### Format Before Commit

**Guidance only** — Run `npm run fmt:check` before committing. Inline code spans in markdown need surrounding spaces to render correctly.

### No Session Links

**Guidance only** — This is a public repo. Claude Code session URLs are private and must not appear in commits or PRs.
