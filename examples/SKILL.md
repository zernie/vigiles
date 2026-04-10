<!-- vigiles:sha256:da271d5e41e8e90e compiled from examples/SKILL.md.spec.ts -->

---

name: pr-to-lint-rule
description: Convert a recurring PR review comment into an automated lint rule with tests and CLAUDE.md annotation
disable-model-invocation: true
argument-hint: <description of recurring PR feedback>

---

Convert a recurring PR review comment into an automated lint rule.

## Arguments

$ARGUMENTS — A natural language description of the pattern to enforce. Examples:

- "we keep telling people not to import directly from antd, use our design system barrel file instead"
- "people forget to use our custom logger instead of console.log"
- "don't use unwrap() in production code, use expect() or proper error handling"
- "API route handlers must use the withAuth wrapper"

## Instructions

You are generating an automated lint rule from a recurring code review pattern. Follow these steps:

### Step 1: Detect the Project Language and Toolchain

Look at the repository to determine:

- **Primary language** (JS/TS, Python, Rust, Go, Ruby, etc.)
- **Linter in use** (ESLint, Ruff, Clippy, golangci-lint, RuboCop, etc.)
- **Testing framework** (Vitest, Jest, pytest, cargo test, etc.)
- **Existing custom rules** (to match conventions)

**If the language or linter cannot be confidently detected**, **ask the user** which language and linter to target before generating anything.

### Step 2: Generate the Lint Rule

Based on the detected (or user-specified) language, generate the appropriate rule type.

For JavaScript/TypeScript, generate an ESLint rule using the AST visitor pattern with `meta` and `create(context)`.

### Step 3: Update `CLAUDE.md`

Add the annotation block. See [enforce-rules-format](skills/enforce-rules-format/SKILL.md) for the correct format.

### Step 4: Verify

Run `npm test` to ensure the new rule and tests pass.
