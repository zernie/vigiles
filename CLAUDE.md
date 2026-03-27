# CLAUDE.md — Example

This is an example CLAUDE.md showing the enforcement annotation format that `agent-lint validate` checks for.

### Always use barrel file imports

**Enforced by:** `eslint/no-restricted-imports`
**Why:** Prevents import path drift during refactoring. All public APIs should be imported from the barrel file, not from internal module paths.

### No console.log in production

**Enforced by:** `eslint/no-console`
**Why:** Use the structured logger (`logger.error`, `logger.info`) which routes to Datadog. Raw console output is invisible in production.

### Use Tailwind spacing scale, no magic numbers

**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency across the design system. Use spacing scale values (`p-4`, `m-8`) instead of arbitrary values (`p-[24px]`).

### API route handlers must use withAuth wrapper

**Enforced by:** `eslint/agent-lint/require-with-auth`
**Why:** Unauthenticated routes are the #1 security risk. The `withAuth` wrapper handles session validation, CSRF, and rate limiting.

### Test files must import from test-utils barrel

**Enforced by:** `eslint/no-restricted-imports`
**Why:** Our `test-utils` re-exports `@testing-library/react` with app-level providers pre-configured. Direct imports cause test isolation failures.
