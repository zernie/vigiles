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

Validates that every rule in your CLAUDE.md is backed by a real linter — or explicitly marked as guidance-only. Cross-references enforcement claims against actual linter configurations (ESLint, Ruff, Clippy, Pylint, RuboCop, Stylelint).

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## Quick Start

```bash
npx vigiles
```

That's it. Finds `CLAUDE.md`, validates every rule has an enforcement annotation, and checks that referenced linters actually exist in your project.

```
Validation Report: CLAUDE.md
========================================
  Total rules:    4
  Enforced:       3
  Guidance only:  1
  Disabled:       0
  Missing:        0
  Linters:        eslint (292 built-in rules)
========================================

All rules have enforcement annotations.
```

## How It Works

vigiles does two things:

**1. Validates rule annotations** — every `###` heading or `- [ ]` checkbox in your instruction file must have `**Enforced by:** \`linter/rule\``or`**Guidance only**`. Near-miss typos like `**Enforced By:**` (wrong case) get a helpful "did you mean?" message.

**2. Verifies linters exist and are enabled** — checks that referenced linters are actually installed and that the specific rules are enabled in your config. ESLint and Stylelint are checked via Node API. Ruff, Clippy, Pylint, and RuboCop are checked via CLI.

## Instruction File Format

Every rule needs an enforcement annotation:

```markdown
### Always use barrel file imports

**Enforced by:** `eslint/no-restricted-imports`
**Why:** Prevents import path drift during refactoring.

### Use Tailwind spacing scale, no magic numbers

**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency across the design system.
```

Both `###` headings and `- [ ]` checkboxes are recognized as rules by default:

```markdown
- [ ] No console.log in production
      **Enforced by:** `eslint/no-console`

- [x] Prefer named exports over default exports
      **Guidance only** — cannot be mechanically enforced
```

To skip validation for a specific rule:

```markdown
### Legacy rule that doesn't fit the format

<!-- vigiles-disable -->
```

## Linter Rule Validation

When a rule says `**Enforced by:** \`eslint/no-console\``, vigiles checks that `no-console` is a real ESLint rule **and** that it's enabled in your config. This catches typos, references to removed rules, disabled rules, and linters that were never set up.

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

For custom or unsupported linters, configure a `rulesDir` to check that rule files exist:

```json
{
  "linters": {
    "my-tool": { "rulesDir": "tools/my-tool/rules/" }
  }
}
```

Set `require-rule-file` to `false` to disable all linter rule checking, or `"catalog-only"` to only check that rules exist in the linter catalog without verifying they're enabled in project config.

## Configuration

vigiles works with zero configuration. It validates `CLAUDE.md` by default. Optionally create a `.vigilesrc.json` to override:

```json
{
  "files": ["CLAUDE.md", "AGENTS.md"],
  "rules": {
    "max-lines": 300
  }
}
```

| Option        | Default                      | Description                                                                                          |
| ------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `extends`     | `"recommended"`              | Rule pack to use as base. `"recommended"` or `"strict"`. User overrides are merged on top.           |
| `files`       | `["CLAUDE.md"]`              | Instruction files to validate when no explicit paths are given                                       |
| `ruleMarkers` | `["headings", "checkboxes"]` | Which rule marker types to recognize                                                                 |
| `linters`     | `{}`                         | Per-linter config for rule file validation                                                           |
| `structures`  | `[]`                         | File-to-schema mappings for structure validation. See [Structure Validation](#structure-validation). |

### Rule Packs

Like ESLint's shared configs, vigiles ships with two rule packs:

```json
{
  "extends": "strict"
}
```

| Rule                  | `recommended` (default) | `strict`                              |
| --------------------- | ----------------------- | ------------------------------------- |
| `require-annotations` | `true`                  | `true`                                |
| `max-lines`           | `500`                   | `300`                                 |
| `require-rule-file`   | `"auto"`                | `"auto"`                              |
| `require-structure`   | `false`                 | `true`                                |
| `no-broken-links`     | `true`                  | `true`                                |
| `structures`          | `[]`                    | CLAUDE.md + SKILL.md (strict schemas) |

Override individual rules on top of either pack:

```json
{
  "extends": "strict",
  "rules": {
    "max-lines": 1000,
    "require-structure": false
  }
}
```

### Rules

| Rule                  | Description                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `require-annotations` | Every rule marker must have `**Enforced by:**` or `**Guidance only**`. Detects near-miss typos with "did you mean?" suggestions.                       |
| `max-lines`           | Maximum number of lines allowed per file. Set a number for custom limit, `false` to disable.                                                           |
| `require-rule-file`   | Validates that referenced linter rules exist and are enabled in project config. Use `"catalog-only"` to skip config checks.                            |
| `require-structure`   | Validates markdown structure against schemas via [mdschema](https://github.com/jackchuka/mdschema). See [Structure Validation](#structure-validation). |
| `no-broken-links`     | Checks that relative markdown links resolve to existing files. Skips external URLs, anchors, and mailto links.                                         |

## CLI

```bash
# Validate CLAUDE.md (default)
npx vigiles

# Validate specific files
npx vigiles CLAUDE.md AGENTS.md

# Glob pattern
npx vigiles "**/*.md"

# Follow symlinks
npx vigiles --follow-symlinks

# Override rule markers
npx vigiles --markers=headings
```

| Flag                            | Description                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `--follow-symlinks`             | Resolve and validate symlinked files. Without this flag, symlinks are skipped. |
| `--markers=headings,checkboxes` | Override which rule markers to recognize. Comma-separated.                     |

Exit codes: `0` on success, `1` if validation fails.

## Organizing Rules

In a monorepo, use **progressive disclosure** — universal rules at the root, context-specific rules in subdirectories:

```
CLAUDE.md                        # Universal: code style, PR conventions, testing
packages/
  api/
    CLAUDE.md                    # API-specific: error handling, DB conventions
  web/
    CLAUDE.md                    # Frontend-specific: component patterns, Tailwind usage
  shared/
    CLAUDE.md -> ../CLAUDE.md    # Symlink to share rules (use --follow-symlinks)
```

The `max-lines` rule (default: 500) nudges toward this pattern — oversized instruction files waste agent tokens on irrelevant rules.

## Structure Validation

Optionally enforce consistent markdown templates via [mdschema](https://github.com/jackchuka/mdschema):

```bash
npm install @jackchuka/mdschema
```

```json
{
  "rules": { "require-structure": true },
  "structures": [
    { "files": "CLAUDE.md", "schema": "claude-md" },
    { "files": "**/SKILL.md", "schema": "skill" }
  ]
}
```

Built-in presets: `"claude-md"`, `"claude-md:strict"`, `"skill"`, `"skill:strict"`. Or point to a custom `.mdschema.yml`. See [mdschema docs](https://github.com/jackchuka/mdschema) for the full schema format.

## GitHub Action

```yaml
# .github/workflows/vigiles.yml
name: Validate agent instructions
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zernie/vigiles@main
```

Errors appear as inline annotations on the PR diff.

Override with action inputs:

```yaml
- uses: zernie/vigiles@main
  with:
    paths: "CLAUDE.md,packages/*/CLAUDE.md"
    max-lines: "300"
    require-rule-file: "auto"
```

## Related Tools

vigiles validates instruction file **content** and **linter cross-references**. It doesn't try to do everything. Here's how it fits with the ecosystem:

**File sync across agents** — If your team uses multiple agents (Claude Code, Cursor, Copilot), use a sync tool to maintain one source of truth:

- [Ruler](https://github.com/intellectronica/ruler) — single `.ruler/` directory, auto-distributes to agent configs
- [rulesync](https://github.com/dyoshikawa/rulesync) — unified rule management, 10+ agent targets
- [block/ai-rules](https://github.com/block/ai-rules) — enterprise multi-agent rule management by Block

Configure vigiles to validate the source file: `"files": ["CLAUDE.md"]`. The sync tool handles distribution.

**Markdown formatting** — Use [markdownlint](https://github.com/DavidAnson/markdownlint) for formatting rules (trailing spaces, consistent lists, heading levels). vigiles doesn't check formatting — it checks semantics. Most teams already have markdownlint in their editor or CI. [CodeRabbit](https://coderabbit.ai) runs it automatically on PRs.

**Prose quality** — Use [Vale](https://vale.sh) for writing style rules. vigiles doesn't check prose.

**Claude Code ecosystem** — For validating hooks, MCP servers, plugins, and `.claude/` structure, see [claudelint](https://github.com/pdugan20/claudelint) or [cclint](https://github.com/carlrannaberg/cclint).

**Stale references** — For checking that file paths and npm scripts in AGENTS.md files are still valid, see [agents-lint](https://github.com/giacomo/agents-lint).

## Skills

Install skills for all your AI agents at once with [Vercel Skills](https://github.com/vercel-labs/skills):

```bash
npx skills add zernie/vigiles
```

**`audit-feedback-loop`** — Scores your repo's feedback loop maturity (see [Maturity Levels](#maturity-levels)).

**`pr-to-lint-rule`** — Converts a recurring PR comment into a lint rule + tests + CLAUDE.md annotation.

**`enforce-rules-format`** — Validates and fixes enforcement annotations in your instruction files.

## Maturity Levels

From the [article](https://zernie.com/blog/feedback-loop-is-all-you-need):

| Level | Name                 | Description                                                         |
| ----- | -------------------- | ------------------------------------------------------------------- |
| 0     | Vibes                | No CI, no linters, no CLAUDE.md                                     |
| 1     | Guardrails           | CI + standard linters, no custom rules                              |
| 2     | Architecture as Code | Custom lint rules + enforced CLAUDE.md                              |
| 3     | The Organism         | CI + custom rules + visual tests + observability + scheduled agents |

## License

[MIT](LICENSE)
