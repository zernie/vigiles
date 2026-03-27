# /audit-feedback-loop

Scan the current repository and score its feedback loop maturity for AI-assisted development.

## Instructions

Analyze this repository and score its **feedback loop maturity** using the levels below. Check for each signal, then output a summary report.

### Maturity Levels

**Level 0 — Vibes**
No CI config, no custom lint rules, no CLAUDE.md. The AI agent is flying blind.

**Level 1 — Guardrails**
Has CI + standard linters, but no custom rules. The agent gets basic feedback but can't learn project-specific conventions.

**Level 2 — Architecture as Code**
Has custom lint rules, CLAUDE.md rules have enforcement annotations. The agent gets rich, project-specific feedback.

**Level 3 — The Organism**
Has CI + custom rules + screenshot tests + observability + scheduled agent tasks. The entire development loop is instrumented.

### Signals to Check

Scan the repository for the following and note which exist:

1. **CI Configuration**: Look for `.github/workflows/`, `.circleci/`, `Jenkinsfile`, `.gitlab-ci.yml`, etc.
2. **Linter Config**: Look for `eslint.config.*`, `.eslintrc*`, `biome.json`, `.prettierrc*`, `deno.json`
3. **Custom Lint Rules**: Look for custom ESLint plugins in `eslint-rules/`, `eslint-plugin-*`, or rule definitions in the eslint config
4. **CLAUDE.md**: Check if `CLAUDE.md` exists at the repo root
5. **CLAUDE.md Enforcement**: If CLAUDE.md exists, check if rules have `**Enforced by:**` annotations
6. **Screenshot/Visual Tests**: Look for Playwright (`playwright.config.*`), Cypress (`cypress.config.*`), Chromatic, Percy configs
7. **Observability**: Search for imports of `@sentry/`, `dd-trace`, `@datadog/`, `newrelic`, `@opentelemetry/` in source files
8. **Scheduled Agent Tasks**: Look for cron patterns in CI configs, `.github/workflows/` with `schedule:` triggers, or references to scheduled Claude Code tasks

### Output Format

```
## Feedback Loop Audit

**Repository:** <repo name>
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

Be specific about file paths and what you found. Give actionable recommendations.
