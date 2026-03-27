---
name: enforce-rules-format
description: Validate and fix enforcement annotations in CLAUDE.md and other agent instruction files so CI passes
disable-model-invocation: true
---

Validate that every rule in the project's agent instruction files has a proper enforcement annotation, and fix any that are missing.

## Instructions

### Step 1: Discover Instruction Files

Look for agent instruction files in the repository:

- `CLAUDE.md` (Claude Code)
- `AGENTS.md` (OpenAI Codex)
- `.cursorrules` (Cursor)
- Any other markdown files the user has configured for agent instructions

Check the repo root and common subdirectory locations (e.g. `packages/*/CLAUDE.md` in monorepos).

### Step 2: Validate Each File

For each instruction file found, scan for `###` headings (level-3 markdown headers). Each heading represents a rule and **must** have one of these annotations in the lines between it and the next `###` heading:

**Option A — Enforced rule:**

```markdown
### Rule title

**Enforced by:** `linter/rule-name`
**Why:** One sentence explaining the reason.
```

**Option B — Guidance-only rule:**

```markdown
### Rule title

**Guidance only** — explanation of why it cannot be mechanically enforced
**Why:** One sentence explaining the reason.
```

Rules missing both annotations will cause CI validation to fail.

### Step 3: Report Findings

Output a summary for each file:

```
## <filename>

| Line | Rule | Status |
|------|------|--------|
| 5 | Always use barrel file imports | Enforced (`eslint/no-restricted-imports`) |
| 12 | Use Tailwind spacing scale | Guidance only |
| 18 | No magic numbers in configs | MISSING |

Total: X rules — Y enforced, Z guidance, N missing
```

If all rules have annotations, report success and stop.

### Step 4: Fix Missing Annotations

For each rule missing an annotation:

1. **Check the project's linter configuration** — look for ESLint, Ruff, Clippy, golangci-lint, RuboCop, or other linter configs to find a rule that enforces this convention
2. If a matching linter rule exists, suggest: `**Enforced by:** \`linter/rule-name\``
3. If no linter can mechanically enforce the rule, suggest: `**Guidance only** — <reason>`
4. If you are unsure whether a linter rule exists, **ask the user** rather than guessing

Present all suggested fixes and **ask the user for confirmation** before writing any changes.

### Step 5: Verify

After making fixes, run validation to confirm CI will pass:

```bash
node validate.mjs <file>
```

Report the validation result. If it still fails, return to Step 4 for the remaining issues.
