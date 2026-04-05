# Contributing to vigiles

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- For full test coverage, you'll also need these linter CLIs on your PATH:
  - `ruff` and `pylint` (Python)
  - `rubocop` (Ruby)
  - `cargo` with `clippy` (Rust)

## Setup

```bash
git clone https://github.com/zernie/vigiles.git
cd vigiles
npm install
npm run build
```

## Project structure

```
src/
  types.ts          Type definitions (interfaces, type aliases)
  validate.ts       Core validation engine (parsing, config, linter checks)
  action.ts         GitHub Action wrapper (reads env vars, calls validatePaths)
  cli.ts            CLI entry point (arg parsing, output formatting)
  validate.test.ts  Test suite (node:test)
schemas/            Built-in mdschema YAML presets
skills/             Claude Code skills (enforce-rules-format, audit-feedback-loop, pr-to-lint-rule)
dist/               Compiled JavaScript output (git-ignored)
```

## Development workflow

### Build

```bash
npm run build        # Compile TypeScript → dist/
```

### Test

```bash
npm test             # Build + run all tests
```

Tests use Node.js built-in test runner (`node:test`) and `node:assert/strict`. No extra test framework needed.

### Format

```bash
npm run fmt          # Auto-format with Prettier
npm run fmt:check    # Check formatting (CI uses this)
```

### Type check

```bash
npx tsc --noEmit     # Type-check without emitting
```

### Run locally

```bash
npx vigiles CLAUDE.md                          # Validate a file
npx vigiles --markers=headings,checkboxes .    # Custom markers
npx vigiles                                    # Auto-discover instruction files
```

## TypeScript conventions

This project uses **TypeScript strict mode** with these compiler options enabled:

- `strict: true` (includes `strictNullChecks`, `noImplicitAny`, etc.)
- `noUncheckedIndexedAccess: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

### Guidelines

- **Explicit types** on all exported function signatures (parameters and return types).
- **No `any`** — use `unknown` and narrow with type guards when the type is truly unknown.
- Import types with `import type { ... }` when only used in type positions.
- Use `.js` extensions in import paths (required by Node16 module resolution).
- Keep the single-file core architecture — `validate.ts` contains all validation logic.

## Adding a new validation rule

1. Add the rule name and default value to `RulesConfig` in `src/types.ts`.
2. Add the default to `RULE_PACKS` in `src/validate.ts`.
3. Implement the check inside the `validate()` function.
4. Add tests in `src/validate.test.ts`.
5. Document the rule in `README.md` and `CLAUDE.md`.

## Adding a new linter resolver

1. Add a Node API resolver to `LINTER_RESOLVERS` (if the linter has a Node API).
2. Or add a CLI checker to `CLI_RULE_CHECKS` and map it in `CLI_TOOL_FOR_LINTER`.
3. Optionally add a config-enabled checker to `LINTER_CONFIG_CHECKERS`.
4. Add tests covering both existing and nonexistent rules.

## Pull requests

- Keep PRs focused — one feature or fix per PR.
- All tests must pass (`npm test`).
- Code must compile without errors (`npx tsc --noEmit`).
- Code must be formatted (`npm run fmt:check`).
- Update `CLAUDE.md` if you change exported APIs or add new rules.
- Write descriptive commit messages explaining _why_, not just _what_.

## Architecture decisions

- **Single-file core**: All validation logic lives in `validate.ts` for portability and minimal dependency surface.
- **Zero config by default**: vigiles works out of the box. Config exists only for overrides.
- **Two rule packs**: `"recommended"` (permissive defaults) and `"strict"` (tighter constraints).
- **Linter auto-detection**: No need to declare which linters you use — vigiles discovers them.
- **Agent auto-discovery**: Detects AI coding tools by their config directories and validates their instruction files exist.
