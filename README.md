# agent-lint

Validate your CLAUDE.md, audit your feedback loops, and generate lint rules from PR comments.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## Why

AI coding agents work best when they get deterministic feedback — linters, type checkers, CI. Without it, they drift from conventions and produce code that "works" but doesn't fit your codebase.

`agent-lint` helps you close the feedback loop:

1. **CI-enforced CLAUDE.md validation** — every rule must be enforced by a linter or explicitly marked as guidance-only
2. **Repo maturity audit** — score how well your feedback loops support AI-assisted development
3. **Lint rule generation** — turn recurring PR review comments into automated enforcement

## GitHub Action

Add CLAUDE.md validation to your CI:

```yaml
# .github/workflows/claude-md.yml
name: Validate CLAUDE.md
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zernie/agent-lint@v1
```

Multiple files (monorepo):

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "CLAUDE.md,packages/api/CLAUDE.md,packages/web/CLAUDE.md"
```

Follow symlinks (e.g. shared CLAUDE.md symlinked into subdirectories):

```yaml
- uses: zernie/agent-lint@v1
  with:
    paths: "CLAUDE.md,packages/api/CLAUDE.md"
    follow-symlinks: "true"
```

CLI usage (no GitHub Actions):

```bash
node validate.mjs CLAUDE.md
node validate.mjs CLAUDE.md packages/api/CLAUDE.md --follow-symlinks
```

### CLAUDE.md Format

The action checks that every `###` heading has either an `**Enforced by:**` annotation or a `**Guidance only**` marker:

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

Rules missing both annotations cause the action to fail.

## Claude Code Skills

### `/audit-feedback-loop`

Scans your repo and scores its feedback loop maturity:

| Level | Name                 | Description                                                         |
| ----- | -------------------- | ------------------------------------------------------------------- |
| 0     | Vibes                | No CI, no linters, no CLAUDE.md                                     |
| 1     | Guardrails           | CI + standard linters, no custom rules                              |
| 2     | Architecture as Code | Custom lint rules + enforced CLAUDE.md                              |
| 3     | The Organism         | CI + custom rules + visual tests + observability + scheduled agents |

Works with any language — detects ESLint, Ruff, Clippy, golangci-lint, RuboCop, and more.

### `/pr-to-lint-rule`

Takes a natural language description of a recurring PR comment and generates:

- A lint rule for your language/toolchain (ESLint, Ruff, Clippy, go/analysis, etc.)
- Test cases
- Integration instructions
- A CLAUDE.md annotation block

Example:

```
/pr-to-lint-rule we keep telling people not to import directly from antd, use our design system barrel file instead
```

### Installing Skills

Clone this repo and copy the skills into your project:

```bash
git clone https://github.com/zernie/agent-lint.git /tmp/agent-lint
cp -r /tmp/agent-lint/.claude/skills/ .claude/skills/
rm -rf /tmp/agent-lint
```

Or manually copy the `.claude/skills/audit-feedback-loop/` and `.claude/skills/pr-to-lint-rule/` directories into your project's `.claude/skills/`.

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
