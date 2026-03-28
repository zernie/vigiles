# agent-lint

Zero-config validation for AI agent instruction files. Ensures every rule in your CLAUDE.md, AGENTS.md, or .cursorrules is backed by a real linter — or explicitly marked as guidance-only.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## Table of Contents

- [Why](#why)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Instruction File Format](#instruction-file-format)
- [Agent Detection](#agent-detection)
- [Linter Rule Validation](#linter-rule-validation)
- [Configuration](#configuration)
- [CLI](#cli)
- [Organizing Rules](#organizing-rules)
- [GitHub Action](#github-action)
- [Installing Skills](#installing-skills)
- [Maturity Levels](#maturity-levels)
- [License](#license)

## Why

AI coding agents work best with deterministic feedback — linters, type checkers, CI. Without it, they drift from conventions and produce code that "works" but doesn't fit your codebase.

The problem: teams write rules in CLAUDE.md or AGENTS.md like "always use barrel imports" but never wire them to actual linters. The rules rot. The agent ignores them. Nobody notices until the codebase diverges.

On bigger teams this gets worse — different engineers use different agents (Claude Code, Cursor, Codex, Copilot), each with its own instruction file format. Without validation, some agents get well-maintained rules while others get stale or missing files. `agent-lint` detects every agent tool configured in your repo and ensures each one has an up-to-date, properly annotated instruction file.

`agent-lint` closes this gap:

1. **Every rule must cite its enforcer** — `**Enforced by:** \`eslint/no-restricted-imports\``or`**Guidance only**`
2. **Referenced linters must actually exist** — auto-detects ESLint, Ruff, Clippy, RuboCop, and more from your project
3. **Missing instruction files are caught** — detects Claude Code, Cursor, Codex, Copilot, Windsurf, and Cline from their config directories
4. **Errors show inline on PRs** — just like ESLint, annotations appear on the affected lines

No config files needed. No dependencies beyond your existing linters.

## Quick Start

```bash
npx agent-lint
```

That's it. agent-lint auto-detects which AI tools you use, finds their instruction files, validates every rule has an enforcement annotation, and checks that referenced linters actually exist in your project.

```
Detected agents: Claude Code (.claude)

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

agent-lint does three things automatically:

**1. Detects your AI tools** — scans for `.claude/`, `.cursor/`, `.windsurf/`, and other config directories. If a tool is configured but its instruction file is missing, that's an error.

**2. Validates rule annotations** — every `###` heading or `- [ ]` checkbox in your instruction files must have `**Enforced by:** \`linter/rule\``or`**Guidance only**`.

**3. Verifies linters exist** — checks that referenced linters are actually installed. ESLint and Stylelint are checked via Node API. Ruff, Clippy, Pylint, and RuboCop are checked via CLI. No extra dependencies are installed — agent-lint only checks tools already in your project.

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

<!-- agent-lint-disable -->
```

## Agent Detection

In a team where some engineers use Claude Code, others use Cursor, and CI runs Codex, you need instruction files for all of them. agent-lint detects which tools are configured and requires their instruction files to exist:

| Tool           | Detected by                       | Required file                     |
| -------------- | --------------------------------- | --------------------------------- |
| Claude Code    | `.claude/` directory              | `CLAUDE.md`                       |
| Cursor         | `.cursor/` directory              | `.cursorrules`                    |
| Windsurf       | `.windsurf/` directory            | `.windsurfrules`                  |
| OpenAI Codex   | `AGENTS.md` file                  | `AGENTS.md`                       |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/copilot-instructions.md` |
| Cline          | `.clinerules` file                | `.clinerules`                     |

If `.claude/` exists but `CLAUDE.md` doesn't, agent-lint errors — so when someone adds a new agent tool to the repo, CI catches the missing instruction file before it ships.

To explicitly require specific tools across the team (even without their config directories):

```json
{
  "agents": ["Claude Code", "Cursor"]
}
```

## Linter Rule Validation

When a rule says `**Enforced by:** \`eslint/no-console\``, agent-lint checks that `no-console` is a real ESLint rule. This catches typos, references to removed rules, and linters that were never set up.

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

Set `require-rule-file` to `false` to disable all linter rule checking.

## Configuration

agent-lint works with zero configuration. Optionally create a `.agent-lintrc.json` to override defaults:

```json
{
  "rules": {
    "max-lines": 300
  }
}
```

| Option        | Default                      | Description                                                   |
| ------------- | ---------------------------- | ------------------------------------------------------------- |
| `ruleMarkers` | `["headings", "checkboxes"]` | Which rule marker types to recognize                          |
| `linters`     | `{}`                         | Per-linter config for rule file validation                    |
| `agents`      | `null` (auto-detect)         | List of agent tool names to require, or `null` to auto-detect |

### Rules

| Rule                  | Default  | Description                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| `require-annotations` | `true`   | Every rule marker must have `**Enforced by:**` or `**Guidance only**`             |
| `max-lines`           | `500`    | Maximum number of lines allowed per file. Set a number for custom limit.          |
| `require-rule-file`   | `"auto"` | Validates that referenced linter rules actually exist. Auto-detects linter tools. |

## CLI

```bash
# Auto-detect agents and validate their instruction files
npx agent-lint

# Validate specific files
npx agent-lint CLAUDE.md AGENTS.md

# Glob pattern
npx agent-lint "**/*.md"

# Follow symlinks
npx agent-lint --follow-symlinks

# Override rule markers
npx agent-lint --markers=headings
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

Auto-detects agents and instruction files. Errors appear as inline annotations on the PR diff — just like ESLint.

Override with action inputs:

```yaml
- uses: zernie/agent-lint@main
  with:
    paths: "CLAUDE.md,packages/*/CLAUDE.md"
    max-lines: "300"
    require-rule-file: "auto"
```

### Action Inputs

All inputs can also be set via `.agent-lintrc.json`. Action inputs take precedence.

| Input                 | Default     | Description                                                 |
| --------------------- | ----------- | ----------------------------------------------------------- |
| `paths`               | auto-detect | Comma-separated paths or glob patterns to validate          |
| `follow-symlinks`     | `false`     | Follow symbolic links when reading files                    |
| `markers`             | from config | Comma-separated rule marker types: `headings`, `checkboxes` |
| `require-annotations` | `true`      | Require enforcement annotations on rules                    |
| `max-lines`           | `500`       | Max lines per file (number or `false` to disable)           |
| `require-rule-file`   | `auto`      | Validate linter rules exist (`auto`, `true`, or `false`)    |
| `linters`             | `{}`        | JSON object mapping linter names to config                  |

### Action Outputs

| Output     | Description                              |
| ---------- | ---------------------------------------- |
| `total`    | Total number of rules found              |
| `enforced` | Rules with `**Enforced by:**` annotation |
| `guidance` | Rules marked `**Guidance only**`         |
| `disabled` | Rules with `<!-- agent-lint-disable -->` |
| `missing`  | Rules missing enforcement annotations    |
| `valid`    | `true` if all rules have annotations     |

## Supported Tools

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
