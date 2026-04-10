---
name: generate-rule
description: Add a new enforce(), check(), or guidance() rule to an existing spec file
disable-model-invocation: true
argument-hint: <description of the rule to add>
---

Add a new rule to an existing `CLAUDE.md.spec.ts` (or create one if it doesn't exist).

## Arguments

$ARGUMENTS — A natural language description of what the rule should enforce. Examples:

- "no console.log in production code"
- "every controller needs a test file"
- "always use the custom logger instead of console"
- "imports should go through barrel files"
- "don't use moment.js, we're migrating to dayjs"

## Instructions

### Step 1: Find the Spec File

Look for `CLAUDE.md.spec.ts` in the repo root. If it doesn't exist:

1. Check if there's a hand-written `CLAUDE.md` — if so, suggest running the `migrate-to-spec` skill first
2. If no CLAUDE.md either, suggest running `npx vigiles init` to scaffold one

### Step 2: Classify the Rule

Based on the user's description, determine the rule type:

**enforce()** — if a linter rule can back it:

1. Check the project's linter configs (ESLint, Ruff, Clippy, Pylint, RuboCop, Stylelint)
2. Search for an existing rule that matches the convention
3. Verify the rule is enabled: `npx vigiles check` will confirm during compilation
4. Also check if an architectural tool (ast-grep, Dependency Cruiser, Steiger) has a relevant rule

**check()** — if it's a filesystem structural convention:

- "every X needs a Y" → `check(every("glob").has("pattern"), "why")`
- Only use for file pairing patterns. Don't try to check code content — that's a linter's job.

**guidance()** — if it can't be mechanically enforced:

- Subjective conventions ("prefer composition over inheritance")
- Process rules ("ask before deleting files")
- Context ("we're migrating from X to Y")

If uncertain whether a linter rule exists, **ask the user** rather than guessing.

### Step 3: Generate the Rule

Create a rule entry in the spec. Use kebab-case for the rule ID derived from the description.

Example outputs:

```typescript
// enforce — backed by ESLint
"no-console": enforce("eslint/no-console", "Use structured logger for observability."),

// check — filesystem assertion
"controller-tests": check(
  every("src/**/*.controller.ts").has("{name}.controller.test.ts"),
  "Every controller must have a co-located test file.",
),

// guidance — cannot be mechanically enforced
"research-before-implementing": guidance(
  "Google unfamiliar APIs before implementing. Check if a well-maintained library exists.",
),
```

### Step 4: Add to Spec

Read the existing spec file and add the new rule to the `rules` object. Maintain alphabetical ordering if the existing rules are alphabetical, otherwise append at the end.

Import any new builders needed (e.g., `check` and `every` if this is the first `check()` rule).

### Step 5: Compile and Verify

```bash
npm run build
npx vigiles compile
```

If compilation fails (e.g., linter rule doesn't exist), report the error and suggest alternatives.

Show the user the updated spec and the compiled CLAUDE.md diff.
