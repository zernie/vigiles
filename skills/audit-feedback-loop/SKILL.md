---
name: audit-feedback-loop
description: Scan the current repo and score its feedback loop maturity for AI-assisted development
disable-model-invocation: true
---

Scan the current repository and score its feedback loop maturity for AI-assisted development.

## Instructions

Analyze this repository and score its **feedback loop maturity** using the levels below. Check for each signal, then output a summary report.

### Maturity Levels

**Level 0 — Vibes**
No CI config, no linter rules, no CLAUDE.md. The AI agent is flying blind.

**Level 1 — Guardrails**
Has CI + standard linters, but no custom rules. The agent gets basic feedback but can't learn project-specific conventions.

**Level 2 — Architecture as Code**
Has custom lint rules, CLAUDE.md rules have enforcement annotations. The agent gets rich, project-specific feedback.

**Level 3 — The Organism**
Has CI + custom rules + screenshot/visual tests + observability + scheduled agent tasks. The entire development loop is instrumented.

### Signals to Check

Scan the repository for the following and note which exist:

1. **CI Configuration**: Look for `.github/workflows/`, `.circleci/`, `Jenkinsfile`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, `.travis.yml`, etc.
2. **Linter Config** (language-aware):
   - **JS/TS**: `eslint.config.*`, `.eslintrc*`, `biome.json`, `.prettierrc*`, `deno.json`
   - **Python**: `pyproject.toml` (look for `[tool.ruff]`, `[tool.pylint]`, `[tool.flake8]`), `setup.cfg`, `.flake8`, `ruff.toml`
   - **Rust**: `clippy.toml`, `.clippy.toml`, `rustfmt.toml`
   - **Go**: `.golangci.yml`, `.golangci.yaml`
   - **Ruby**: `.rubocop.yml`
   - **Java/Kotlin**: `checkstyle.xml`, `pmd.xml`, `detekt.yml`
3. **Custom Lint Rules**: Look for custom plugins, rule directories, or inline rule definitions in linter configs
   - JS/TS: `eslint-plugin-*`, `eslint-rules/` directories
   - Python: custom Ruff/Pylint plugins, AST-based checks
   - Rust: custom Clippy lints
   - Go: custom analyzers
4. **CLAUDE.md**: Check if `CLAUDE.md` exists at the repo root
5. **CLAUDE.md Enforcement**: If CLAUDE.md exists, check if rules have `**Enforced by:**` annotations
6. **Screenshot/Visual Tests**: Look for Playwright (`playwright.config.*`), Cypress (`cypress.config.*`), Chromatic, Percy, BackstopJS configs
7. **Observability**: Search for imports/usage of `@sentry/`, `dd-trace`, `@datadog/`, `newrelic`, `@opentelemetry/`, `sentry_sdk`, `structlog`, `tracing` (Rust), `opentelemetry` in source files
8. **Scheduled Agent Tasks**: Look for cron patterns in CI configs, `.github/workflows/` with `schedule:` triggers, or references to scheduled Claude Code tasks

### Output Format

```
## Feedback Loop Audit

**Repository:** <repo name>
**Primary language(s):** <detected languages>
**Score: Level X — <Name>**

### Signals Found
- [x] CI Configuration: <details>
- [ ] Custom Lint Rules: not found
- [x] CLAUDE.md: found, 5 enforced / 2 guidance / 1 missing
...

### Recommendations
1. <Most impactful next step to level up>
2. <Second recommendation>
3. <Third recommendation>

### How to Level Up
<Specific, actionable advice for reaching the next maturity level>
```

Be specific about file paths and what you found. Give actionable recommendations tailored to the project's language and toolchain.
