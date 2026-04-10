---
name: enforce-rules-format
description: Validate that all rules have proper enforcement classification (enforce/check/guidance)
disable-model-invocation: true
---

Validate that every rule in the project's instruction files has a proper enforcement classification, and fix any that are missing.

## Instructions

### Step 1: Detect Format

Check which format the project uses:

**v2 (spec-based):** Look for `CLAUDE.md.spec.ts` or any `*.spec.ts` files. If found, this is a v2 project — rules must use `enforce()`, `check()`, or `guidance()`.

**v1 (hand-written):** Look for `CLAUDE.md`, `AGENTS.md`, `.cursorrules`. If found without a spec file, this is a v1 project — rules need `**Enforced by:**` or `**Guidance only**` annotations.

### Step 2: Validate

**For v2 specs:**

The TypeScript type system already prevents unannotated rules — you can't create a rule without calling `enforce()`, `check()`, or `guidance()`. So focus on:

1. Do `enforce()` rules reference real linter rules? Run `npx vigiles compile` to check.
2. Are there guidance rules that COULD be `enforce()`? Check linter configs for matching rules.
3. Are there `check()` assertions that could be delegated to a linter? Suggest `enforce()` instead.

```bash
npx vigiles compile
npx vigiles discover
```

**For v1 hand-written files:**

Scan for `###` headings. Each must have one of:

- `**Enforced by:** \`linter/rule-name\``
- `**Guidance only** — reason`
- `<!-- vigiles-disable -->`

Report missing annotations with a summary table.

### Step 3: Fix Issues

For each issue found:

1. Check the project's linter configuration for matching rules
2. Suggest `enforce("linter/rule")` (v2) or `**Enforced by:** \`linter/rule\`` (v1)
3. If no linter rule exists, suggest `guidance()` (v2) or `**Guidance only**` (v1)
4. **Ask the user** before making changes

### Step 4: Suggest Migration

If the project uses v1 format, suggest migrating to v2 specs for type safety:

> Your rules could benefit from type-safe specs. Run the `migrate-to-spec` skill to convert your CLAUDE.md to a typed .spec.ts file.

### Step 5: Verify

Run the appropriate command:

```bash
# v2
npx vigiles compile && npx vigiles check

# validate
npx vigiles check
```

Report the validation result.
