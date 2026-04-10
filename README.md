<p align="center">
  <img src="logo.png" width="140" alt="vigiles logo" />
</p>

<h1 align="center">vigiles</h1>

<p align="center">
  <em>Quis custodiet ipsos custodes?</em> — Who watches the watchmen?
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vigiles"><img src="https://img.shields.io/npm/v/vigiles?color=orange" alt="npm version" /></a>
  <a href="https://github.com/zernie/vigiles/actions"><img src="https://img.shields.io/github/actions/workflow/status/zernie/vigiles/ci.yml?branch=main" alt="CI" /></a>
  <a href="https://github.com/zernie/vigiles/blob/main/LICENSE"><img src="https://img.shields.io/github/license/zernie/vigiles" alt="License" /></a>
</p>

---

Compiles typed TypeScript specs to AI instruction files (CLAUDE.md, SKILL.md). Your project's conventions as TypeScript — type-checked at authoring time, proven at build time, compiled to markdown for agents to read.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## Quick Start

```bash
npx vigiles compile
```

That's it. Finds `CLAUDE.md.spec.ts`, type-checks it, verifies linter rules and file references, and compiles to `CLAUDE.md` with a SHA-256 integrity hash.

```
Compiling: CLAUDE.md.spec.ts → CLAUDE.md
  Rules:          4
  Enforced:       2 (verified against eslint)
  Proven:         1
  Guidance:       1
  References:     3 file(), 1 cmd(), 1 ref() — all valid
  Hash:           sha256:a1b2c3...
========================================
Done.
```

## How It Works

```
spec.ts  →  compile  →  .md
```

1. **Author** — Write rules in TypeScript. The type system forces every rule into one of three categories: `enforce()`, `check()`, or `guidance()`. No rule can be left unannotated.

2. **Compile** — `vigiles compile` resolves every `enforce()` claim against the real linter API, validates every `file()` / `cmd()` / `ref()` reference, and emits markdown. `vigiles check` runs `check()` assertions against your codebase.

3. **Read** — Agents consume the compiled `.md` files. A SHA-256 hash at the bottom detects manual edits. `vigiles check` verifies integrity in CI.

## CLAUDE.md Spec Format

```typescript
// CLAUDE.md.spec.ts
import { claude, enforce, guidance, check, every } from "vigiles/spec";

export default claude({
  commands: {
    "npm run build": "Compile TypeScript to dist/",
    "npm test": "Build and run all tests",
  },

  keyFiles: {
    "src/validate.ts": "Core validation engine",
    "src/cli.ts": "CLI entry point",
  },

  rules: {
    // Delegated to ESLint — vigiles verifies it's real & enabled
    "no-console": enforce(
      "eslint/no-console",
      "Use structured logger for Datadog.",
    ),

    // Checked by vigiles — filesystem assertion no single linter handles
    "test-pairing": check(
      every("src/**/*.controller.ts").has("{name}.test.ts"),
      "Every controller must have tests.",
    ),

    // Guidance — compiles to **Guidance only** in output
    "research-first": guidance("Google unfamiliar APIs first."),
  },
});
```

### Three Rule Types

**`enforce(linter, reason)`** — Delegated to an external linter. vigiles verifies the rule exists and is enabled in your project config at compile time. If the rule is disabled or the linter isn't installed, compilation fails.

```typescript
"no-console": enforce("eslint/no-console", "Use structured logger."),
"snake-case": enforce("ruff/N815", "PEP 8 naming conventions."),
"unused-imports": enforce("clippy/unused_imports", "Keep imports clean."),
```

**`check(assertion, reason)`** — A filesystem assertion that vigiles runs directly. Scoped to what no single linter handles: file pairing, structural conventions across directories.

```typescript
"test-pairing": check(
  every("src/**/*.controller.ts").has("{name}.test.ts"),
  "Every controller must have tests.",
),
```

**`guidance(reason)`** — Prose-only advice. Compiles to `**Guidance only**` in the output. No verification, no assertions.

```typescript
"research-first": guidance("Google unfamiliar APIs first."),
"small-prs": guidance("Keep PRs under 400 lines when possible."),
```

## SKILL.md Spec Format

Skill specs use `file()`, `cmd()`, and `ref()` tagged template helpers to embed verified references inside prose instructions:

```typescript
// skills/deploy/SKILL.md.spec.ts
import { skill, file, cmd, ref, instructions } from "vigiles/spec";

export default skill({
  name: "deploy",
  description: "Deploy the application to production",
  body: instructions`
    1. Check ${file("infra/terraform/main.tf")} for the current config.
    2. Run ${cmd("npm run deploy:staging")} to deploy to staging first.
    3. Follow the rollback procedure in ${ref("skills/rollback/SKILL.md")}.
    4. Verify health checks pass in ${file("scripts/health-check.sh")}.
  `,
});
```

`file()` verifies the path exists on disk. `cmd()` verifies the script exists in `package.json` or as an executable. `ref()` verifies the referenced instruction file exists. If any reference is stale — a file was renamed, a script was removed — compilation fails with a clear error pointing to the exact line.

## Linter Cross-Referencing

When a rule says `enforce("eslint/no-console", ...)`, vigiles checks that `no-console` is a real ESLint rule **and** that it's enabled in your config. This catches typos, references to removed rules, disabled rules, and linters that were never set up.

Supported linters are auto-detected from your project — **no extra dependencies are installed**:

| Linter    | Detection                     | Method                              |
| --------- | ----------------------------- | ----------------------------------- |
| ESLint    | `eslint` in `node_modules`    | Node API (`builtinRules` + plugins) |
| Stylelint | `stylelint` in `node_modules` | Node API (`rules` export)           |
| Ruff      | `ruff` on PATH                | CLI (`ruff rule <name>`)            |
| Clippy    | `cargo` on PATH               | CLI (`cargo clippy --explain`)      |
| Pylint    | `pylint` on PATH              | CLI (`pylint --help-msg`)           |
| RuboCop   | `rubocop` on PATH             | CLI (`rubocop --show-cops`)         |

ESLint plugin rules are also supported — use `eslint/<plugin>/<rule>` (e.g., `eslint/import/no-unresolved`) or the plugin name directly (e.g., `@typescript-eslint/no-explicit-any`). The plugin package must be installed in `node_modules`.

## Configuration

vigiles works with zero configuration. Optionally create a `vigiles.config.ts` for overrides:

```typescript
// vigiles.config.ts
import { defineConfig } from "vigiles";

export default defineConfig({
  maxRules: 30,
});
```

| Option     | Default | Description                                              |
| ---------- | ------- | -------------------------------------------------------- |
| `maxRules` | `30`    | Maximum number of rules per compiled file. Keeps focused |

## CLI

```bash
# Compile all specs to markdown
npx vigiles compile

# Verify hashes, validate hooks/skills, run assertions
npx vigiles check

# Scaffold a new spec
npx vigiles init

# Scaffold from an existing CLAUDE.md (future)
npx vigiles init --from-claude-md
```

| Command          | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `compile`        | Compile `.spec.ts` files to `.md` with linter verification and hashing |
| `check`          | Verify SHA-256 hashes, validate references, run `check()` assertions   |
| `init`           | Scaffold a new `CLAUDE.md.spec.ts` from scratch                        |
| `generate-types` | Emit `.vigiles/generated.d.ts` with type unions from project state     |
| `discover`       | Scan linter configs and report which rules are undocumented            |
| `adopt`          | Detect manual edits to compiled files and show diff                    |

Exit codes: `0` on success, `1` if compilation or checks fail.

## Organizing Specs

In a monorepo, use **progressive disclosure** — universal rules at the root, context-specific rules in subdirectories:

```
CLAUDE.md.spec.ts                # Universal: code style, PR conventions, testing
packages/
  api/
    CLAUDE.md.spec.ts            # API-specific: error handling, DB conventions
  web/
    CLAUDE.md.spec.ts            # Frontend-specific: component patterns, Tailwind usage
  shared/
    CLAUDE.md.spec.ts            # Shared library conventions
```

Each spec compiles independently. `check()` assertions in each spec run against that spec's working directory by default, so `every("src/**/*.ts")` in `packages/api/CLAUDE.md.spec.ts` matches files under `packages/api/src/`.

## GitHub Action

```yaml
# .github/workflows/vigiles.yml
name: Compile and check agent instructions
on: [push, pull_request]
jobs:
  vigiles:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zernie/vigiles@main
```

The action runs `vigiles check` by default — verifying hashes, references, and assertions. Errors appear as inline annotations on the PR diff.

To compile and commit updated markdown on push:

```yaml
- uses: zernie/vigiles@main
  with:
    command: compile
```

## Skills

Install skills for all your AI agents at once with [Vercel Skills](https://github.com/vercel-labs/skills):

```bash
npx skills add zernie/vigiles
```

### Adoption & Migration

**`migrate-to-spec`** — Convert an existing hand-written CLAUDE.md into a typed `.spec.ts` file. The incremental adoption path — parses your existing sections, rules, commands, and key files into a typed spec with `file()`/`cmd()` refs for stale reference detection.

**`generate-rule`** — Add a new `enforce()`, `check()`, or `guidance()` rule to an existing spec. Detects the right rule type: checks linter configs for matching rules, suggests `check()` for filesystem patterns, falls back to `guidance()` for subjective conventions.

### Validation & Audit

**`enforce-rules-format`** — Validates that all rules have proper enforcement classification. Works with both v2 specs and v1 hand-written files. Suggests migration to specs for v1 projects.

**`audit-feedback-loop`** — Scores your repo's feedback loop maturity (see [Maturity Levels](#maturity-levels)). Detects v2 specs and generated types as higher-maturity signals.

**`pr-to-lint-rule`** — Converts a recurring PR review comment into a lint rule + tests + spec annotation. Supports ESLint, Ruff, Clippy, Go analyzers, and RuboCop.

## Maturity Levels

From the [article](https://zernie.com/blog/feedback-loop-is-all-you-need):

| Level | Name                 | Description                                                         |
| ----- | -------------------- | ------------------------------------------------------------------- |
| 0     | Vibes                | No CI, no linters, no CLAUDE.md                                     |
| 1     | Guardrails           | CI + standard linters, no custom rules                              |
| 2     | Architecture as Code | Custom lint rules + enforced CLAUDE.md                              |
| 3     | The Organism         | CI + custom rules + visual tests + observability + scheduled agents |

## Related Tools

vigiles compiles typed specs to instruction files and cross-references linter claims. It doesn't try to do everything. Here's how it fits with the ecosystem:

**File sync across agents** — If your team uses multiple agents (Claude Code, Cursor, Copilot), use a sync tool to maintain one source of truth:

- [Ruler](https://github.com/intellectronica/ruler) — single `.ruler/` directory, auto-distributes to agent configs
- [rulesync](https://github.com/dyoshikawa/rulesync) — unified rule management, 10+ agent targets
- [block/ai-rules](https://github.com/block/ai-rules) — enterprise multi-agent rule management by Block

**Markdown formatting** — Use [markdownlint](https://github.com/DavidAnson/markdownlint) for formatting rules (trailing spaces, consistent lists, heading levels). [CodeRabbit](https://coderabbit.ai) runs it automatically on PRs.

**Prose quality** — Use [Vale](https://vale.sh) for writing style rules.

**Claude Code ecosystem** — For validating hooks, MCP servers, plugins, and `.claude/` structure, see [claudelint](https://github.com/pdugan20/claudelint) or [cclint](https://github.com/carlrannaberg/cclint).

**Stale references** — For checking that file paths and npm scripts in AGENTS.md files are still valid, see [agents-lint](https://github.com/giacomo/agents-lint).

## License

[MIT](LICENSE)
