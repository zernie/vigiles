<p align="center">
  <img src="logo.png" width="140" alt="vigiles logo" />
</p>

<h1 align="center">vigiles</h1>

<p align="center">
  <em>Quis custodiet ipsos custodes?</em> — Who watches the watchmen?
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vigiles"><img src="https://img.shields.io/npm/v/vigiles?color=orange" alt="npm version" /></a>
  <a href="https://github.com/zernie/vigiles/actions"><img src="https://img.shields.io/github/actions/workflow/status/zernie/vigiles/ci.yml?branch=main" alt="CI" /></a>
  <a href="https://github.com/zernie/vigiles/blob/main/LICENSE"><img src="https://img.shields.io/github/license/zernie/vigiles" alt="License" /></a>
</p>

---

Your CLAUDE.md says `eslint/no-console` is enforced. But is that rule actually enabled in your ESLint config? Your agent thinks there's a safety net. Is there?

vigiles compiles typed TypeScript specs to AI instruction files. Every linter reference is verified. Every file path is checked. Every command is validated. If something is stale, broken, or disabled — you find out at compile time, not when the agent ignores it.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## The Problem

Hand-written CLAUDE.md files rot silently:

```markdown
### Use the structured logger ← but what IS the structured logger?

**Enforced by:** `eslint/no-console` ← disabled in config 3 months ago
**Why:** Routes to Datadog.

### Always import from barrel files

**Enforced by:** `eslint/no-restricted-imports` ← typo: rule is no-restricted-syntax
**Why:** Prevents path drift.

Check `src/utils/logger.ts` for the API. ← file was renamed to telemetry.ts
Run `npm run typecheck` to verify. ← script was removed last sprint
```

Four silent failures. The agent reads this, trusts it, and produces code based on lies.

## The Fix

Write your conventions as TypeScript. The compiler catches the lies.

```typescript
// CLAUDE.md.spec.ts
import { claude, enforce, guidance, check, every } from "vigiles/spec";

export default claude({
  commands: {
    "npm run build": "Compile TypeScript to dist/",
    "npm test": "Build and run all tests",
    // ✗ "npm run typecheck" → compile error: script not in package.json
  },

  keyFiles: {
    "src/utils/telemetry.ts": "Structured logger API",
    // ✗ "src/utils/logger.ts" → compile error: file not found
  },

  rules: {
    "no-console": enforce(
      "eslint/no-console",
      "Use structured logger for Datadog.",
    ),
    // ✗ enforce("eslint/no-consolee") → type error: not a valid rule
    // ✗ if rule is disabled in config → compile error

    "test-pairing": check(
      every("src/**/*.controller.ts").has("{name}.test.ts"),
      "Every controller must have tests.",
    ),

    "research-first": guidance("Google unfamiliar APIs first."),
  },
});
```

```bash
$ npx vigiles compile

✓ CLAUDE.md.spec.ts → CLAUDE.md
  3 rules (1 linter-verified, 1 filesystem check, 1 guidance)
  ~180 tokens
```

The spec is the source of truth. CLAUDE.md is a build artifact.

## Quick Start

```bash
# Start from scratch
npx vigiles init            # creates CLAUDE.md.spec.ts
npx vigiles compile          # compiles to CLAUDE.md

# Or migrate an existing CLAUDE.md (via skill)
npx skills add zernie/vigiles
# then run the migrate-to-spec skill in your AI agent
```

## Three Rule Types

**`enforce()`** — delegated to a linter. vigiles verifies the rule exists and is enabled.

```typescript
"no-console": enforce("eslint/no-console", "Use structured logger."),
"no-print":   enforce("ruff/T201", "Use logging module."),
"no-unwrap":  enforce("clippy/unwrap_used", "Use expect() with context."),
```

Supports ESLint, Stylelint, Ruff, Clippy, Pylint, and RuboCop. [Full linter support details →](docs/linter-support.md)

**`check()`** — filesystem assertion that vigiles runs directly.

```typescript
"test-pairing": check(
  every("src/**/*.controller.ts").has("{name}.test.ts"),
  "Every controller must have tests.",
),
```

**`guidance()`** — prose advice. No enforcement pretended.

```typescript
"research-first": guidance("Google unfamiliar APIs first."),
```

## Verified References

`file()`, `cmd()`, and `ref()` catch stale references at compile time:

```typescript
import { claude, file, cmd, ref, instructions } from "vigiles/spec";

export default claude({
  sections: {
    architecture: instructions`
      Core engine in ${file("src/compile.ts")}.
      Run ${cmd("npm test")} to verify.
      See ${ref("skills/deploy/SKILL.md")} for deployment.
    `,
    // If any path is stale → compile error
  },
  // ...
});
```

Skill specs use the same helpers for verified references inside instructions. [Full spec format →](docs/spec-format.md)

## Type-Safe Rule References

`vigiles generate-types` scans your actual linter configs and emits a `.d.ts`:

```bash
$ npx vigiles generate-types

  eslint: 64 enabled rules
  ruff: 12 enabled rules
  npm scripts: 5
  project files: 42

✓ Generated .vigiles/generated.d.ts
```

The generated file contains type unions for every enabled rule, npm script, and project file:

```typescript
// .vigiles/generated.d.ts (auto-generated, DO NOT EDIT)
export type EslintRule = "no-console" | "no-unused-vars" | ...;
export type RuffRule = "E501" | "F401" | "T201" | ...;
export type NpmScript = "build" | "test" | "fmt" | ...;
export type ProjectFile = "src/spec.ts" | "src/compile.ts" | ...;
```

**Commit this file to git.** It should be checked in so that:

- Editors pick up the types immediately (no setup step for new contributors)
- CI can verify it's fresh: run `vigiles generate-types` and check for uncommitted changes
- Anyone cloning the repo gets autocomplete and type checking out of the box

Re-run `vigiles generate-types` when you add/remove linter rules, npm scripts, or source files. [Details →](docs/linter-support.md#generate-types)

## CLI

```bash
npx vigiles compile          # Compile .spec.ts → .md
npx vigiles check            # Verify hashes + run assertions
npx vigiles init             # Scaffold a CLAUDE.md.spec.ts
npx vigiles generate-types   # Emit .d.ts from project state
npx vigiles discover         # Show undocumented linter rules
npx vigiles adopt            # Detect manual edits, show diff
```

## GitHub Action

```yaml
- uses: zernie/vigiles@main # runs `check` by default
- uses: zernie/vigiles@main
  with:
    command: compile # compile specs in CI
```

## Skills

Install with [Vercel Skills](https://github.com/vercel-labs/skills): `npx skills add zernie/vigiles`

| Skill                  | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `migrate-to-spec`      | Convert a hand-written CLAUDE.md to a typed `.spec.ts`           |
| `generate-rule`        | Add a new `enforce()` / `check()` / `guidance()` rule to a spec  |
| `pr-to-lint-rule`      | Turn a recurring PR review comment into a lint rule + spec entry |
| `enforce-rules-format` | Validate all rules have enforcement classification               |
| `audit-feedback-loop`  | Score your repo's feedback loop maturity                         |

## Maturity Levels

From [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need):

| Level | Name                 | What it means                                                       |
| ----- | -------------------- | ------------------------------------------------------------------- |
| 0     | Vibes                | No CI, no linters, no CLAUDE.md                                     |
| 1     | Guardrails           | CI + standard linters, no custom rules                              |
| 2     | Architecture as Code | Custom lint rules + enforced CLAUDE.md                              |
| 3     | The Organism         | CI + custom rules + visual tests + observability + scheduled agents |

## Related Tools

vigiles doesn't try to do everything:

- **Architectural linting** — [ast-grep](https://ast-grep.github.io/), [Dependency Cruiser](https://github.com/sverweij/dependency-cruiser), [Steiger](https://github.com/feature-sliced/steiger). Reference their rules via `enforce()`.
- **File sync** — [Ruler](https://github.com/intellectronica/ruler), [rulesync](https://github.com/dyoshikawa/rulesync), [block/ai-rules](https://github.com/block/ai-rules). vigiles compiles the source; sync tools distribute.
- **Markdown linting** — [markdownlint](https://github.com/DavidAnson/markdownlint). vigiles generates the markdown; structure is correct by construction.
- **Prose quality** — [Vale](https://vale.sh). Different concern.

## License

[MIT](LICENSE)
