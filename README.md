# agent-lint

ESLint for AI agents — validate your instruction files, audit your feedback loops, and generate lint rules from PR comments.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## Why

AI coding agents work best when they get deterministic feedback — linters, type checkers, CI. Without it, they drift from conventions and produce code that "works" but doesn't fit your codebase.

`agent-lint` helps you close the feedback loop:

1. **CI-enforced instruction file validation** — every rule must be enforced by a linter or explicitly marked as guidance-only
2. **Repo maturity audit** — score how well your feedback loops support AI-assisted development
3. **Lint rule generation** — turn recurring PR review comments into automated enforcement

Works with any AI agent instruction file — CLAUDE.md, AGENTS.md, .cursorrules, or your own convention.

## Instruction File Format

`agent-lint` validates that every `###` heading has either an `**Enforced by:**` annotation or a `**Guidance only**` marker:

```markdown
### Always use barrel file imports

**Enforced by:** `eslint/no-restricted-imports`
**Why:** Prevents import path drift during refactoring.

### No console.log in production

**Enforced by:** `eslint/no-console`
**Why:** Use the structured logger which routes to Datadog.

### Use Tailwind spacing scale, no magic numbers

**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency across the design system.
```

Rules missing both annotations cause validation to fail. This format works in any markdown file — CLAUDE.md, AGENTS.md, .cursorrules, or a custom file.

### Disabling Validation for a Rule

To skip validation for a specific rule, add an HTML comment below the heading:

```markdown
### Legacy rule that doesn't fit the format

<!-- agent-lint-disable -->
```

This works like `eslint-disable-next-line` — the rule is recognized but excluded from validation. Use sparingly.

## Installing Skills

Install skills for all your AI agents at once with [Vercel Skills](https://github.com/vercel-labs/skills):

```bash
npx skills add zernie/agent-lint
```

This auto-detects your installed agents and installs the skills for each one. Works with Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, and [many more](https://skills.sh).

### Available Skills

**`audit-feedback-loop`** — Scans your repo and scores its feedback loop maturity:

| Level | Name                 | Description                                                         |
| ----- | -------------------- | ------------------------------------------------------------------- |
| 0     | Vibes                | No CI, no linters, no CLAUDE.md                                     |
| 1     | Guardrails           | CI + standard linters, no custom rules                              |
| 2     | Architecture as Code | Custom lint rules + enforced CLAUDE.md                              |
| 3     | The Organism         | CI + custom rules + visual tests + observability + scheduled agents |

Works with any language — detects ESLint, Ruff, Clippy, golangci-lint, RuboCop, and more.

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

## Claude Code

Skills installed via `npx skills add` are available as `/audit-feedback-loop`, `/pr-to-lint-rule`, and `/enforce-rules-format`.

### Automatic Validation Hook

When installed as a plugin, agent-lint automatically registers a PostToolUse hook that validates CLAUDE.md after every file edit. If a rule is missing its annotation, the agent gets immediate feedback and can fix the format before it reaches CI.

To set this up manually instead (e.g. without the plugin), add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "node validate.mjs CLAUDE.md"
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

## OpenAI Codex

Codex uses `AGENTS.md` for agent instructions. Use the same enforcement annotation format, then validate:

```bash
node validate.mjs AGENTS.md
```

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "AGENTS.md"
```

## Cursor

Cursor uses `.cursorrules` for agent instructions. Use the same enforcement annotation format, then validate:

```bash
node validate.mjs .cursorrules
```

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: ".cursorrules"
```

## Other Tools

`agent-lint` works with any markdown file that follows the `###` heading + `**Enforced by:**` / `**Guidance only**` format. Pass any file path to the CLI or GitHub Action:

```bash
node validate.mjs my-instructions.md
```

You can validate multiple files across tools in a single run:

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "CLAUDE.md,AGENTS.md,.cursorrules"
```

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
      - uses: zernie/agent-lint@v1
```

By default the action validates `CLAUDE.md`. Pass `paths` to validate other files:

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "CLAUDE.md,AGENTS.md,.cursorrules"
```

Multiple files (monorepo):

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "CLAUDE.md,packages/api/CLAUDE.md,packages/web/CLAUDE.md"
```

Follow symlinks (e.g. shared instruction file symlinked into subdirectories):

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "CLAUDE.md,packages/api/CLAUDE.md"
    follow-symlinks: "true"
```

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
- uses: zernie/agent-lint@v1
  id: lint
- if: always()
  run: |
    echo "Total: ${{ steps.lint.outputs.total }}"
    echo "Enforced: ${{ steps.lint.outputs.enforced }}"
    echo "Missing: ${{ steps.lint.outputs.missing }}"
```

## CLI

```bash
node validate.mjs CLAUDE.md
node validate.mjs AGENTS.md .cursorrules
node validate.mjs CLAUDE.md packages/api/CLAUDE.md --follow-symlinks
```

## Maturity Levels

From the [article](https://zernie.com/blog/feedback-loop-is-all-you-need) — the four levels of feedback loop maturity:

### Level 0: Vibes

The agent writes code, you eyeball it. No automated checks.

### Level 1: Guardrails

Standard CI — default linter rules, type checking, basic tests. The agent gets red/green signals but can't learn your conventions.

### Level 2: Architecture as Code

Custom lint rules encode your team's decisions. CLAUDE.md rules reference actual enforcement. The agent understands _why_ things are done a certain way.

### Level 3: The Organism

Everything is instrumented. Visual regression tests catch UI drift. Observability SDKs flag runtime issues. Scheduled agents monitor and maintain. The codebase evolves with feedback at every layer.

## License

MIT
