# agent-lint

ESLint for AI agents — validate your instruction files, audit your feedback loops, and generate lint rules from PR comments.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## Table of Contents

- [Why](#why)
- [Quick Start](#quick-start)
- [Instruction File Format](#instruction-file-format)
- [Configuration](#configuration)
- [CLI](#cli)
- [Organizing Rules](#organizing-rules)
- [GitHub Action](#github-action)
- [Supported Tools](#supported-tools)
- [Installing Skills](#installing-skills)
- [Maturity Levels](#maturity-levels)
- [License](#license)

## Why

AI coding agents work best when they get deterministic feedback — linters, type checkers, CI. Without it, they drift from conventions and produce code that "works" but doesn't fit your codebase.

`agent-lint` helps you close the feedback loop:

1. **CI-enforced instruction file validation** — every rule must be enforced by a linter or explicitly marked as guidance-only
2. **Repo maturity audit** — score how well your feedback loops support AI-assisted development
3. **Lint rule generation** — turn recurring PR review comments into automated enforcement

Works with any AI agent instruction file — CLAUDE.md, AGENTS.md, .cursorrules, or your own convention.

## Quick Start

```bash
# Auto-discovers CLAUDE.md, AGENTS.md, .cursorrules, etc.
npx agent-lint
```

Example output when validation fails:

```
Validation Report: CLAUDE.md
========================================
  Total rules:    3
  Enforced:       1
  Guidance only:  0
  Disabled:       0
  Missing:        2
========================================

Rules missing enforcement annotations:
  Line 12: "No console.log in production"
  Line 18: "Use Tailwind spacing scale"

Add **Enforced by:** `<rule>` or **Guidance only** to each rule.
```

When all rules pass:

```
Validation Report: CLAUDE.md
========================================
  Total rules:    3
  Enforced:       2
  Guidance only:  1
  Disabled:       0
  Missing:        0
========================================

All rules have enforcement annotations.
```

## Instruction File Format

`agent-lint` validates that every rule has either an `**Enforced by:**` annotation or a `**Guidance only**` marker. Rules can be defined as `###` headings or markdown checkboxes:

**Headings format:**

```markdown
### Always use barrel file imports

**Enforced by:** `eslint/no-restricted-imports`
**Why:** Prevents import path drift during refactoring.

### Use Tailwind spacing scale, no magic numbers

**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency across the design system.
```

**Checkbox format** (enable with `"ruleMarkers": ["checkboxes"]` in config):

```markdown
- [ ] No console.log in production
      **Enforced by:** `eslint/no-console`
      **Why:** Use the structured logger which routes to Datadog.

- [x] Prefer named exports over default exports
      **Guidance only** — cannot be mechanically enforced
```

Rules missing both annotations cause validation to fail. This format works in any markdown file — CLAUDE.md, AGENTS.md, .cursorrules, or a custom file.

### Disabling Validation for a Rule

To skip validation for a specific rule, add an HTML comment below the heading:

```markdown
### Legacy rule that doesn't fit the format

<!-- agent-lint-disable -->
```

This works like `eslint-disable-next-line` — the rule is recognized but excluded from validation. Use sparingly.

## Configuration

agent-lint works with zero configuration. Optionally create a `.agent-lintrc.json` to override defaults:

```json
{
  "ruleMarkers": ["headings"],
  "rules": {
    "max-lines": 300
  }
}
```

| Option        | Default                      | Description                                                                                        |
| ------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `ruleMarkers` | `["headings", "checkboxes"]` | Which rule marker types to recognize: `headings`, `checkboxes`, or both                            |
| `linters`     | `{}`                         | Per-linter config for rule file validation (see [Linter Rule Validation](#linter-rule-validation)) |
| `agents`      | `null` (auto-detect)         | List of agent tool names to require, or `null` to auto-detect                                      |

### Rules

Rules are named checks that can be toggled individually. Set to `false` to disable.

| Rule                  | Default  | Description                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| `require-annotations` | `true`   | Every rule marker must have `**Enforced by:**` or `**Guidance only**`             |
| `max-lines`           | `500`    | Maximum number of lines allowed per file. Set a number for custom limit.          |
| `require-rule-file`   | `"auto"` | Validates that referenced linter rules actually exist. Auto-detects linter tools. |

### Linter Rule Validation

When `require-rule-file` is `"auto"` (the default), agent-lint automatically detects installed linters and validates that referenced rules exist:

| Linter    | Detection                     | Method                              |
| --------- | ----------------------------- | ----------------------------------- |
| ESLint    | `eslint` in `node_modules`    | Node API (`builtinRules` + plugins) |
| Stylelint | `stylelint` in `node_modules` | Node API (`rules` export)           |
| Ruff      | `ruff` on PATH                | CLI (`ruff rule <name>`)            |
| Clippy    | `cargo` on PATH               | CLI (`cargo clippy --explain`)      |
| Pylint    | `pylint` on PATH              | CLI (`pylint --help-msg`)           |
| RuboCop   | `rubocop` on PATH             | CLI (`rubocop --show-cops`)         |

ESLint plugin rules are also supported. Use `eslint/<plugin>/<rule>` for plugin rules referenced under the `eslint` linter (e.g., `eslint/import/no-unresolved`), or use the plugin name directly as the linter prefix (e.g., `@typescript-eslint/no-explicit-any`). The plugin package must be installed in `node_modules`.

For custom or unsupported linters, configure a `rulesDir` to check that rule files exist:

```json
{
  "linters": {
    "my-tool": { "rulesDir": "tools/my-tool/rules/" }
  }
}
```

Set `require-rule-file` to `false` to disable all rule file checking.

## CLI

```bash
# Auto-discover and validate all instruction files
npx agent-lint

# Validate a specific file
npx agent-lint CLAUDE.md

# Monorepo — validate across packages
npx agent-lint CLAUDE.md packages/api/CLAUDE.md packages/web/CLAUDE.md

# Glob pattern — validate all matching files
npx agent-lint "**/*.md"

# Follow symlinks
npx agent-lint --follow-symlinks

# Override rule markers
npx agent-lint --markers=headings
```

### Options

| Flag                            | Description                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `--follow-symlinks`             | Resolve and validate symlinked files. Without this flag, symlinks are skipped. |
| `--markers=headings,checkboxes` | Override which rule markers to recognize. Comma-separated.                     |

If no paths are provided, defaults to `CLAUDE.md`.

Exit codes: `0` on success, `1` if any rules are missing annotations.

## Organizing Rules

In a monorepo (or any project with subdirectories), use **progressive disclosure** — put universal rules at the root, and context-specific rules in subdirectory files. AI agents read the nearest instruction file plus all parent files, so rules naturally narrow as the agent moves deeper into the tree.

### Example structure

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

**Root file** (`CLAUDE.md`) — rules every agent should follow regardless of context:

- Code formatting and linting standards
- Git commit and PR conventions
- Testing requirements

**Subdirectory files** (`packages/api/CLAUDE.md`) — rules that only apply in that context:

- API error handling patterns
- Database query conventions
- Framework-specific idioms

### Validate all files at once

```bash
# Glob pattern — finds every CLAUDE.md in the tree
npx agent-lint "**/CLAUDE.md"

# Or list them explicitly
npx agent-lint CLAUDE.md packages/api/CLAUDE.md packages/web/CLAUDE.md
```

### Why this matters

The `max-lines` rule (default: 500 lines) exists because oversized instruction files hurt agent performance — the agent spends tokens parsing rules that aren't relevant to its current task. Progressive disclosure keeps each file focused, which means faster comprehension and fewer irrelevant rules applied.

## GitHub Action

```yaml
# .github/workflows/agent-lint.yml
name: Validate agent instructions
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zernie/agent-lint@main
```

By default the action auto-discovers instruction files (CLAUDE.md, AGENTS.md, .cursorrules, etc.). Pass `paths` to override:

Multiple files (monorepo):

```yaml
- uses: zernie/agent-lint@main
  with:
    paths: "CLAUDE.md,packages/api/CLAUDE.md,packages/web/CLAUDE.md"
```

Glob pattern:

```yaml
- uses: zernie/agent-lint@main
  with:
    paths: "**/CLAUDE.md"
```

Follow symlinks (e.g. shared instruction file symlinked into subdirectories):

```yaml
- uses: zernie/agent-lint@main
  with:
    paths: "CLAUDE.md,packages/api/CLAUDE.md"
    follow-symlinks: "true"
```

Enable checkbox markers:

```yaml
- uses: zernie/agent-lint@main
  with:
    markers: "headings,checkboxes"
```

Override rules (same options as `.agent-lintrc.json`):

```yaml
- uses: zernie/agent-lint@main
  with:
    max-lines: "300"
    require-rule-file: "auto"
    linters: '{"my-tool":{"rulesDir":"rules/"}}'
```

### Action Inputs

All inputs can also be set via `.agent-lintrc.json`. Action inputs override the config file.

| Input                 | Default     | Description                                                 |
| --------------------- | ----------- | ----------------------------------------------------------- |
| `paths`               | `CLAUDE.md` | Comma-separated paths or glob patterns to validate          |
| `follow-symlinks`     | `false`     | Follow symbolic links when reading files                    |
| `markers`             | from config | Comma-separated rule marker types: `headings`, `checkboxes` |
| `require-annotations` | `true`      | Require enforcement annotations on rules                    |
| `max-lines`           | `500`       | Max lines per file (number or `false` to disable)           |
| `require-rule-file`   | `auto`      | Validate linter rules exist (`auto`, `true`, or `false`)    |
| `linters`             | `{}`        | JSON object mapping linter names to config                  |

### Inline PR Annotations

Errors appear as inline annotations directly on the affected lines in the PR **Files** tab — just like ESLint. No extra tools or configuration needed.

### Action Outputs

The action sets the following outputs, accessible via `steps.<id>.outputs.<name>`:

| Output     | Description                              |
| ---------- | ---------------------------------------- |
| `total`    | Total number of rules found              |
| `enforced` | Rules with `**Enforced by:**` annotation |
| `guidance` | Rules marked `**Guidance only**`         |
| `disabled` | Rules with `<!-- agent-lint-disable -->` |
| `missing`  | Rules missing enforcement annotations    |
| `valid`    | `true` if all rules have annotations     |

```yaml
- uses: zernie/agent-lint@main
  id: lint
- if: always()
  run: |
    echo "Total: ${{ steps.lint.outputs.total }}"
    echo "Enforced: ${{ steps.lint.outputs.enforced }}"
    echo "Missing: ${{ steps.lint.outputs.missing }}"
```

## Supported Tools

`agent-lint` detects which AI coding tools are configured in your project and validates their instruction files. If a tool is detected but its instruction file is missing, that's an error — ensuring you don't forget to create one.

| Tool           | Detected by                       | Required file                     |
| -------------- | --------------------------------- | --------------------------------- |
| Claude Code    | `.claude/` directory              | `CLAUDE.md`                       |
| Cursor         | `.cursor/` directory              | `.cursorrules`                    |
| Windsurf       | `.windsurf/` directory            | `.windsurfrules`                  |
| OpenAI Codex   | `AGENTS.md` file                  | `AGENTS.md`                       |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/copilot-instructions.md` |
| Cline          | `.clinerules` file                | `.clinerules`                     |

To explicitly require specific tools (even without their config directories):

```json
{
  "agents": ["Claude Code", "Cursor"]
}
```

You can also pass explicit paths or globs:

```bash
npx agent-lint my-instructions.md
```

### Claude Code Integration

Skills installed via `npx skills add` are available as `/audit-feedback-loop`, `/pr-to-lint-rule`, and `/enforce-rules-format`.

#### Automatic Validation Hook

When installed as a plugin, agent-lint automatically registers a PostToolUse hook that validates CLAUDE.md after every file edit. If a rule is missing its annotation, the agent gets immediate feedback and can fix the format before it reaches CI.

To set this up manually instead (e.g. without the plugin), add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "npx agent-lint CLAUDE.md"
      }
    ]
  }
}
```

Alternatively, install via the Claude Code plugin system:

```
/plugin marketplace add zernie/agent-lint
/plugin install agent-lint@agent-lint
```

Or manually copy skills into your project's `.claude/skills/` directory.

## Installing Skills

Install skills for all your AI agents at once with [Vercel Skills](https://github.com/vercel-labs/skills):

```bash
npx skills add zernie/agent-lint
```

This auto-detects your installed agents and installs the skills for each one. Works with Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, and [many more](https://skills.sh).

### Available Skills

**`audit-feedback-loop`** — Scans your repo and scores its feedback loop maturity (see [Maturity Levels](#maturity-levels)). Works with any language — detects ESLint, Ruff, Clippy, golangci-lint, RuboCop, and more.

**`pr-to-lint-rule`** — Takes a natural language description of a recurring PR comment and generates:

- A lint rule for your language/toolchain (ESLint, Ruff, Clippy, go/analysis, etc.)
- Test cases
- Integration instructions
- A CLAUDE.md annotation block

Example:

```
/pr-to-lint-rule we keep telling people not to import directly from antd, use our design system barrel file instead
```

**`enforce-rules-format`** — Validates that every `###` rule in your instruction files has an `**Enforced by:**` or `**Guidance only**` annotation. Finds missing annotations, suggests fixes based on your linter config, and verifies the result passes validation.

Example:

```
/enforce-rules-format
```

## Maturity Levels

From the [article](https://zernie.com/blog/feedback-loop-is-all-you-need) — the four levels of feedback loop maturity:

| Level | Name                 | Description                                                         |
| ----- | -------------------- | ------------------------------------------------------------------- |
| 0     | Vibes                | No CI, no linters, no CLAUDE.md                                     |
| 1     | Guardrails           | CI + standard linters, no custom rules                              |
| 2     | Architecture as Code | Custom lint rules + enforced CLAUDE.md                              |
| 3     | The Organism         | CI + custom rules + visual tests + observability + scheduled agents |

**Level 0: Vibes** — The agent writes code, you eyeball it. No automated checks.

**Level 1: Guardrails** — Standard CI — default linter rules, type checking, basic tests. The agent gets red/green signals but can't learn your conventions.

**Level 2: Architecture as Code** — Custom lint rules encode your team's decisions. CLAUDE.md rules reference actual enforcement. The agent understands _why_ things are done a certain way.

**Level 3: The Organism** — Everything is instrumented. Visual regression tests catch UI drift. Observability SDKs flag runtime issues. Scheduled agents monitor and maintain. The codebase evolves with feedback at every layer.

## License

[MIT](LICENSE)
