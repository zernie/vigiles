---
name: strengthen
description: Upgrade guidance() rules to enforce() by finding existing linter rules that match
disable-model-invocation: true
---

Scan spec files for `guidance()` rules and suggest `enforce()` replacements backed by real linter rules.

## Instructions

### Step 0: Choose Mode

Ask the user:

> **Auto or interactive?**
>
> - **Auto** — I'll apply all safe changes (direct replacements where the rule is already enabled), commit, and show you the diff. Risky changes (require config edits or plugin installs) go in a summary for you to review.
> - **Interactive** — I'll present each suggestion and you pick which ones to apply.

Default to interactive if the user doesn't specify.

### Step 1: Discover What's Installed

Run `npx vigiles generate-types` to get the full list of enabled linter rules in the project. Read `.vigiles/generated.d.ts` to see every rule available across all detected linters.

Note which linter prefixes appear in the generated types (e.g., `EslintRule`, `RuffRule`). You'll only need reference docs for detected linters.

### Step 2: Find All Guidance Rules

Find all `.spec.ts` files in the project (`**/*.md.spec.ts`). For each file, identify every `guidance()` rule.

### Step 3: Match Against Generated Types (Fast Path)

For each guidance rule, check if an enabled rule in `.vigiles/generated.d.ts` directly matches. This is the fast, deterministic path — no doc reading needed.

Look for:

- **Exact rule name in text** — guidance says "no-console" and `no-console` is in EslintRule
- **Semantic match** — guidance says "don't use console.log" and `no-console` is available
- **Rule description match** — guidance says "unused variables" and `no-unused-vars` or `@typescript-eslint/no-unused-vars` is available

If a match is found and the rule is in the generated types (meaning it's already enabled), this is a **direct replacement** — no config changes needed.

### Step 4: Read Linter Docs (Slow Path)

For guidance rules that didn't match in Step 3, read the linter reference docs for the project's detected linters:

- ESLint → `../linter-docs/eslint.md`
- Stylelint → `../linter-docs/stylelint.md`
- Ruff → `../linter-docs/ruff.md`
- Pylint → `../linter-docs/pylint.md`
- RuboCop → `../linter-docs/rubocop.md`
- Clippy → `../linter-docs/clippy.md`

**Only read docs for linters the project actually uses.** Skip docs for linters with no rules in generated types.

Check the plugin tables and decision matrices. The guidance text may describe a pattern covered by:

- A plugin rule that's installed but not enabled
- A plugin that's not installed yet
- A `no-restricted-*` config pattern (see Step 4b)

### Step 4b: `no-restricted-*` Patterns

Many guidance rules can be enforced via built-in linter config without a custom rule. This is the most common strengthen pattern — "don't do X" maps to a restriction config.

**ESLint:**

```js
// "Don't import from internal modules"
"no-restricted-imports": ["error", {
  patterns: [{ group: ["src/internal/*"], message: "Use the public API." }]
}],

// "Don't call console.log"
"no-restricted-syntax": ["error", {
  selector: 'CallExpression[callee.object.name="console"]',
  message: "Use the project logger."
}],

// "Don't use moment.js"
"no-restricted-imports": ["error", {
  paths: [{ name: "moment", message: "Use dayjs instead." }]
}],
```

**Ruff:**

```toml
# "Don't use os.system"
[tool.ruff.lint.flake8-tidy-imports.banned-api]
"os.system".msg = "Use subprocess.run instead."
```

**RuboCop:**

```yaml
# "Don't use puts in production" — if Rails/Output doesn't fit
Custom/NoPuts:
  Enabled: true
```

When suggesting a `no-restricted-*` change:

1. Show the exact config edit needed (which file, which section)
2. Show the `enforce()` rule that references it
3. Note that this changes linter config, not just the spec

### Step 5: Present Suggestions

Group the output into tiers:

**Tier 1: Direct replacements** (rule already enabled — zero risk)

```typescript
// Before
"no-console": guidance("Use structured logger instead of console.log"),
// After
"no-console": enforce("eslint/no-console", "Use structured logger instead of console.log"),
```

**Tier 2: Config-backed** (rule exists but needs config options)

```typescript
// Spec change:
"no-moment": enforce("eslint/no-restricted-imports", "Use dayjs instead of moment."),

// Config change needed (eslint.config.mjs):
"no-restricted-imports": ["error", {
  paths: [{ name: "moment", message: "Use dayjs instead." }]
}],
```

**Tier 3: Plugin install needed**

```
"cognitive-complexity": guidance("Keep functions simple")
→ Install eslint-plugin-sonarjs, enable sonarjs/cognitive-complexity
→ enforce("eslint/sonarjs/cognitive-complexity", "Keep functions simple")
```

**Tier 4: No match** (stays as guidance, or candidate for `/pr-to-lint-rule`)

```
"research-first": guidance("Google unfamiliar APIs first.")
→ No linter rule can enforce this. Stays as guidance.
→ Want me to run /pr-to-lint-rule to create a custom rule?
```

### Step 6: Apply Changes

**In auto mode:**

1. Apply all Tier 1 changes (edit spec files, replace `guidance()` with `enforce()`)
2. Run `npm run build && npx vigiles compile` to verify each change compiles
3. If any compilation fails, revert that specific change and report the error
4. Commit all successful changes
5. Present Tier 2-4 as a summary for the user to review

**In interactive mode:**

1. Present all tiers
2. Ask the user which suggestions to apply
3. For approved Tier 2 changes: edit the linter config, then edit the spec
4. Run `npm run build && npx vigiles compile` to verify
5. If compilation fails, report the error and revert

**For Tier 4 (no match):** Ask the user if they want to run `/pr-to-lint-rule` for any of the unmatched rules to create custom rules.
