# vigiles

> _Quis custodiet ipsos custodes?_ — Who watches the watchmen?
>
> **Vigiles** were the watchmen of ancient Rome. This tool watches your AI agent instruction files — the rules that watch over your codebase.

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
- [Structure Validation](#structure-validation)
- [GitHub Action](#github-action)
- [Installing Skills](#installing-skills)
- [Maturity Levels](#maturity-levels)
- [License](#license)

## Why

AI coding agents work best with deterministic feedback — linters, type checkers, CI. Without it, they drift from conventions and produce code that "works" but doesn't fit your codebase.

The problem: teams write rules in CLAUDE.md or AGENTS.md like "always use barrel imports" but never wire them to actual linters. The rules rot. The agent ignores them. Nobody notices until the codebase diverges.

On bigger teams this gets worse — different engineers use different agents (Claude Code, Cursor, Codex, Copilot), each with its own instruction file format. Without validation, some agents get well-maintained rules while others get stale or missing files. `vigiles` detects every agent tool configured in your repo and ensures each one has an up-to-date, properly annotated instruction file.

`vigiles` closes this gap:

1. **Every rule must cite its enforcer** — `**Enforced by:** \`eslint/no-restricted-imports\``or`**Guidance only**`
2. **Referenced linters must actually exist** — auto-detects ESLint, Ruff, Clippy, RuboCop, and more from your project
3. **Missing instruction files are caught** — detects Claude Code, Cursor, Codex, Copilot, Windsurf, and Cline from their config directories
4. **Errors show inline on PRs** — just like ESLint, annotations appear on the affected lines

No config files needed. No dependencies beyond your existing linters.

## Quick Start

```bash
npx vigiles
```

That's it. vigiles auto-detects which AI tools you use, finds their instruction files, validates every rule has an enforcement annotation, and checks that referenced linters actually exist in your project.

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

vigiles does three things automatically:

**1. Detects your AI tools** — scans for `.claude/`, `.cursor/`, `.windsurf/`, and other config directories. If a tool is configured but its instruction file is missing, that's an error.

**2. Validates rule annotations** — every `###` heading or `- [ ]` checkbox in your instruction files must have `**Enforced by:** \`linter/rule\``or`**Guidance only**`.

**3. Verifies linters exist** — checks that referenced linters are actually installed. ESLint and Stylelint are checked via Node API. Ruff, Clippy, Pylint, and RuboCop are checked via CLI. No extra dependencies are installed — vigiles only checks tools already in your project.

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

## Agent Detection

In a team where some engineers use Claude Code, others use Cursor, and CI runs Codex, you need instruction files for all of them. vigiles detects which tools are configured and requires their instruction files to exist:

| Tool           | Detected by                       | Required file                     |
| -------------- | --------------------------------- | --------------------------------- |
| Claude Code    | `.claude/` directory              | `CLAUDE.md`                       |
| Cursor         | `.cursor/` directory              | `.cursorrules`                    |
| Windsurf       | `.windsurf/` directory            | `.windsurfrules`                  |
| OpenAI Codex   | `AGENTS.md` file                  | `AGENTS.md`                       |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/copilot-instructions.md` |
| Cline          | `.clinerules` file                | `.clinerules`                     |

If `.claude/` exists but `CLAUDE.md` doesn't, vigiles errors — so when someone adds a new agent tool to the repo, CI catches the missing instruction file before it ships.

To explicitly require specific tools across the team (even without their config directories):

```json
{
  "agents": ["Claude Code", "Cursor"]
}
```

## Linter Rule Validation

When a rule says `**Enforced by:** \`eslint/no-console\``, vigiles checks that `no-console` is a real ESLint rule. This catches typos, references to removed rules, and linters that were never set up.

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

vigiles works with zero configuration. Optionally create a `.vigilesrc.json` to override defaults:

```json
{
  "rules": {
    "max-lines": 300
  }
}
```

| Option        | Default                      | Description                                                                                          |
| ------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `extends`     | `"recommended"`              | Rule pack to use as base. `"recommended"` or `"strict"`. User overrides are merged on top.           |
| `ruleMarkers` | `["headings", "checkboxes"]` | Which rule marker types to recognize                                                                 |
| `linters`     | `{}`                         | Per-linter config for rule file validation                                                           |
| `agents`      | `null` (auto-detect)         | List of agent tool names to require, or `null` to auto-detect                                        |
| `structures`  | `[]`                         | File-to-schema mappings for structure validation. See [Structure Validation](#structure-validation). |

### Rule Packs

Like ESLint's shared configs, vigiles ships with two rule packs. Set `"extends"` in `.vigilesrc.json` to select one — all rules from the pack apply, and any explicit `"rules"` you set override the pack defaults.

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
| `structures`          | `[]`                    | CLAUDE.md + SKILL.md (strict schemas) |

**`recommended`** is the zero-config default — catches missing annotations and oversized files. No structure validation, no extra dependencies.

**`strict`** turns everything on: tighter line limits, structure validation with the strict schema presets (heading hierarchy, required sections, frontmatter). Requires [mdschema](https://github.com/jackchuka/mdschema) for `require-structure`.

You can always override individual rules on top of either pack:

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

| Rule                  | Description                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `require-annotations` | Every rule marker must have `**Enforced by:**` or `**Guidance only**`                                                       |
| `max-lines`           | Maximum number of lines allowed per file. Set a number for custom limit.                                                    |
| `require-rule-file`   | Validates that referenced linter rules exist and are enabled in project config. Use `"catalog-only"` to skip config checks. |
| `require-structure`   | Validates markdown structure against schemas. See [Structure Validation](#structure-validation).                            |

## CLI

```bash
# Auto-detect agents and validate their instruction files
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

### Why

LLM agents treat every instruction file as novel — they'll add a `## Guidelines` section to one CLAUDE.md and `## Conventions` to another, skip heading levels, forget frontmatter on skills, and gradually drift each file into a unique snowflake. Across a team or monorepo this compounds: no two files follow the same template, making them harder for both humans and agents to navigate.

Structure validation enforces a consistent markdown template. Every CLAUDE.md gets the same sections. Every SKILL.md has frontmatter. Heading hierarchy stays clean. The agent gets deterministic feedback when it creates or edits instruction files — not a human code review two days later.

### Setup

Requires [mdschema](https://github.com/jackchuka/mdschema) (optional dependency — vigiles works without it, but this rule is skipped):

```bash
npm install @jackchuka/mdschema
```

Enable in `.vigilesrc.json`:

```json
{
  "rules": { "require-structure": true },
  "structures": [
    { "files": "CLAUDE.md", "schema": "claude-md" },
    { "files": "**/SKILL.md", "schema": "skill" }
  ]
}
```

Each entry maps a glob pattern to a schema. Schemas can be a built-in preset name or a path to a custom `.mdschema.yml` file.

### Glob-Based File Matching

Different schemas for different directories:

```json
{
  "rules": { "require-structure": true },
  "structures": [
    { "files": "CLAUDE.md", "schema": "claude-md" },
    {
      "files": "packages/api/**/CLAUDE.md",
      "schema": "./schemas/api-claude.yml"
    },
    { "files": "**/SKILL.md", "schema": "skill" }
  ]
}
```

### Built-in Presets

| Preset        | What it checks                                                                |
| ------------- | ----------------------------------------------------------------------------- |
| `"claude-md"` | Heading levels don't skip (h1 to h3), max depth 4. Freeform sections allowed. |
| `"skill"`     | Requires YAML frontmatter with a `description` field. Max heading depth 4.    |

Preset schemas are bundled in `schemas/`. You can copy and customize them.

### Custom Schemas

Create a `.mdschema.yml` file with the full [mdschema syntax](https://github.com/jackchuka/mdschema):

```yaml
# schemas/api-claude.yml
structure:
  - heading:
      pattern: "# .+"
    allow_additional: true
    children:
      - heading: "## Commands"
      - heading: "## Architecture"
      - heading: "## API Conventions"
        optional: true

heading_rules:
  no_skip_levels: true
  max_depth: 4

frontmatter:
  fields:
    - name: "description"
      required: true
```

mdschema supports required/optional sections, regex heading patterns, nested children, section count constraints (`min`/`max`), `allow_additional` for unlisted subsections, frontmatter field validation, word count rules, required text/code blocks per section, and link validation. See the [mdschema README](https://github.com/jackchuka/mdschema) for the full schema format.

You can also derive a schema from an existing file:

```bash
npx @jackchuka/mdschema derive CLAUDE.md -o schemas/claude-md.yml
```

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

Auto-detects agents and instruction files. Errors appear as inline annotations on the PR diff — just like ESLint.

Override with action inputs:

```yaml
- uses: zernie/vigiles@main
  with:
    paths: "CLAUDE.md,packages/*/CLAUDE.md"
    max-lines: "300"
    require-rule-file: "auto"
```

### Action Inputs

All inputs can also be set via `.vigilesrc.json`. Action inputs take precedence.

| Input                 | Default     | Description                                                                              |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `paths`               | auto-detect | Comma-separated paths or glob patterns to validate                                       |
| `follow-symlinks`     | `false`     | Follow symbolic links when reading files                                                 |
| `markers`             | from config | Comma-separated rule marker types: `headings`, `checkboxes`                              |
| `require-annotations` | `true`      | Require enforcement annotations on rules                                                 |
| `max-lines`           | `500`       | Max lines per file (number or `false` to disable)                                        |
| `require-rule-file`   | `auto`      | Validate linter rules exist and are enabled (`auto`, `catalog-only`, `true`, or `false`) |
| `linters`             | `{}`        | JSON object mapping linter names to config                                               |

### Action Outputs

| Output     | Description                              |
| ---------- | ---------------------------------------- |
| `total`    | Total number of rules found              |
| `enforced` | Rules with `**Enforced by:**` annotation |
| `guidance` | Rules marked `**Guidance only**`         |
| `disabled` | Rules with `<!-- vigiles-disable -->`    |
| `missing`  | Rules missing enforcement annotations    |
| `valid`    | `true` if all rules have annotations     |

## Supported Tools

### Claude Code Integration

Skills installed via `npx skills add` are available as `/audit-feedback-loop`, `/pr-to-lint-rule`, and `/enforce-rules-format`.

#### Automatic Validation Hook

When installed as a plugin, vigiles automatically registers a PostToolUse hook that validates CLAUDE.md after every file edit. If a rule is missing its annotation, the agent gets immediate feedback and can fix the format before it reaches CI.

To set this up manually instead (e.g. without the plugin), add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "npx vigiles CLAUDE.md"
      }
    ]
  }
}
```

Alternatively, install via the Claude Code plugin system:

```
/plugin marketplace add zernie/vigiles
/plugin install vigiles@vigiles
```

Or manually copy skills into your project's `.claude/skills/` directory.

## Installing Skills

Install skills for all your AI agents at once with [Vercel Skills](https://github.com/vercel-labs/skills):

```bash
npx skills add zernie/vigiles
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
