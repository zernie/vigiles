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

Your CLAUDE.md says "don't use `any`" and references a lint rule to enforce it. But someone disabled that rule to unblock a deadline three months ago. Your agent still thinks there's a safety net. Is there?

vigiles compiles typed TypeScript specs to AI instruction files (CLAUDE.md, AGENTS.md, or any markdown target). Every linter reference is verified. Every file path is checked. Every command is validated. If something is stale, broken, or disabled — you find out at compile time, not when the agent ignores it.

Companion repo for [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need).

## The Problem

Hand-written CLAUDE.md files rot silently. Here's what they actually look like:

```markdown
## Code Style

Never use `any` — the `@typescript-eslint/no-explicit-any` rule
catches this. Always use `unknown` and narrow with type guards.
See `src/utils/type-helpers.ts` for project utilities.

## Testing

Run `npm run typecheck` before submitting. Every service in
src/services/ should have a corresponding test file.
```

Reads fine. Four things are wrong:

1. `@typescript-eslint/no-explicit-any` — disabled to unblock a deadline, never re-enabled
2. `src/utils/type-helpers.ts` — renamed to `src/utils/narrowing.ts` last quarter
3. `npm run typecheck` — script removed from package.json
4. Service/test pairing — no automated check, just a hope

The agent reads this, trusts it, and writes code based on stale claims nobody verified.

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
    "src/utils/narrowing.ts": "Type guard utilities",
    // ✗ "src/utils/type-helpers.ts" → compile error: file not found
  },

  rules: {
    "no-explicit-any": enforce(
      "@typescript-eslint/no-explicit-any",
      "Use unknown and narrow with type guards.",
    ),
    // ✗ if rule is disabled in config → compile error

    "test-pairing": check(
      every("src/**/*.service.ts").has("{name}.test.ts"),
      "Every service must have tests.",
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
npx vigiles setup
```

That's it. The wizard creates a spec, scans your linters, generates types, compiles to markdown, and adds a CI step to your workflow if one exists. For AGENTS.md (Codex, GitHub Copilot): `npx vigiles setup --target=AGENTS.md`.

Already have a hand-written CLAUDE.md? Install the plugin and ask your agent to run the `migrate-to-spec` skill:

```bash
npx skills add zernie/vigiles
```

## Three Rule Types

**`enforce()`** — delegated to a linter. vigiles verifies the rule exists in the catalog AND is enabled in your project config. A disabled rule is a compile error.

```typescript
"no-any":    enforce("@typescript-eslint/no-explicit-any", "Use unknown and narrow."),
"no-print":  enforce("ruff/T201", "Use logging module."),
"no-unwrap": enforce("clippy/unwrap_used", "Use expect() with context."),
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

The generated file does two things:

**1. Standalone types** for direct import:

```typescript
// .vigiles/generated.d.ts (auto-generated, DO NOT EDIT)
declare module "vigiles/generated" {
  export type EslintRule = "no-console" | "no-unused-vars" | ...;
  export type RuffRule = "E501" | "F401" | "T201" | ...;
  export type NpmScript = "build" | "test" | "fmt" | ...;
  export type ProjectFile = "src/spec.ts" | "src/compile.ts" | ...;
}
```

**2. Automatic narrowing** of `enforce()`, `file()`, and `cmd()` via declaration merging:

```typescript
// Also in generated.d.ts — augments vigiles/spec automatically
declare module "vigiles/spec" {
  interface KnownLinterRules {
    eslint: "no-console" | "no-unused-vars" | ...;
    "@typescript-eslint": "no-floating-promises" | "no-explicit-any" | ...;
    ruff: "E501" | "F401" | "T201" | ...;
  }
  interface KnownProjectFiles { files: "src/spec.ts" | ...; }
  interface KnownNpmScripts { scripts: "build" | "test" | ...; }
}
```

With this file present, `enforce("eslint/no-consolee")` is a red squiggle in your editor — not a runtime surprise. Without it, everything falls back to broad types and still works.

**Commit this file to git.** It should be checked in so that:

- Editors pick up the types immediately (no setup step for new contributors)
- CI can verify it's fresh: `npx vigiles generate-types --check`
- Anyone cloning the repo gets autocomplete and type checking out of the box

Re-run `vigiles generate-types` when you add/remove linter rules, npm scripts, or source files. [Details →](docs/linter-support.md#generate-types)

## CLI

```bash
npx vigiles setup                   # One-command setup: init + types + compile
npx vigiles compile               # Compile .spec.ts → .md
npx vigiles check                 # Verify hashes + run assertions
npx vigiles init [--target=X.md]  # Scaffold a spec
npx vigiles generate-types        # Emit .d.ts from project state
npx vigiles generate-types --check  # Verify .d.ts is up to date
npx vigiles discover              # Show undocumented linter rules
npx vigiles adopt                 # Detect manual edits, show diff
```

## GitHub Action

```yaml
- uses: zernie/vigiles@main # runs `check` by default
- uses: zernie/vigiles@main
  with:
    command: compile # compile specs in CI
```

To verify generated types are fresh in CI:

```yaml
- run: npx vigiles generate-types --check
```

## Claude Code Plugin

**Install the plugin.** Without it, you're responsible for manually running `compile` and `generate-types`. With it, the agent works with fresh instruction files automatically.

```bash
npx skills add zernie/vigiles
```

The plugin provides two hooks:

- **PreToolUse** (Edit/Write) — blocks direct edits to compiled `.md` files and redirects the agent to the `.spec.ts` source
- **PostToolUse** (Edit/Write) — auto-runs `generate-types` on linter config changes, `compile` on `.spec.ts` changes

## Validation

`vigiles check` validates instruction files. One rule: `require-spec` (enabled by default) — checks that every CLAUDE.md/AGENTS.md has a corresponding `.spec.ts` file.

```bash
npx vigiles check    # errors if CLAUDE.md has no CLAUDE.md.spec.ts
```

Disable per-file with an HTML comment:

```markdown
<!-- vigiles-disable require-spec -->

# CLAUDE.md

...
```

Or in `.vigilesrc.json`:

```json
{ "rules": { "require-spec": false } }
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

## Output Targets

By default, specs compile to `CLAUDE.md`. Set `target` to compile to other instruction file formats:

```typescript
// AGENTS.md.spec.ts — single target
export default claude({
  target: "AGENTS.md",
  rules: { ... },
});

// CLAUDE.md.spec.ts — multiple targets from one spec
export default claude({
  target: ["CLAUDE.md", "AGENTS.md"],
  rules: { ... },
});
```

```bash
$ npx vigiles compile
✓ CLAUDE.md.spec.ts → CLAUDE.md, AGENTS.md
```

The compiler, linter cross-referencing, and all validations work identically — only the output filename and heading change. Use sync tools like [rule-porter](https://github.com/nichochar/rule-porter) or [rulesync](https://github.com/dyoshikawa/rulesync) to convert the compiled markdown to non-markdown formats (`.cursorrules`, Copilot, etc.).

## Enforcing Spec Shape with `satisfies`

Use TypeScript's `satisfies` keyword to enforce that your specs always include certain sections or rules:

```typescript
// Define your project's required spec shape
type ProjectSpec = {
  sections: {
    architecture: string;
    testing: string;
  };
  commands: Record<string, string>;
  rules: Record<string, Rule>;
};

// TypeScript errors if you forget a required section
export default claude({
  sections: {
    architecture: "...",
    testing: "...",
    // ✗ Remove 'testing' → "Property 'testing' is missing"
  },
  commands: {
    "npm test": "Run all tests",
  },
  rules: { ... },
} satisfies ProjectSpec);
```

This is a convention you can adopt per-project — define what a "complete" spec looks like for your team, and the compiler enforces it at type-check time.

## Related Tools

vigiles doesn't try to do everything:

- **Architectural linting** — [ast-grep](https://ast-grep.github.io/), [Dependency Cruiser](https://github.com/sverweij/dependency-cruiser), [Steiger](https://github.com/feature-sliced/steiger). Reference their rules via `enforce()`.
- **File sync** — [Ruler](https://github.com/intellectronica/ruler), [rulesync](https://github.com/dyoshikawa/rulesync), [block/ai-rules](https://github.com/block/ai-rules). vigiles compiles the source; sync tools distribute.
- **Markdown linting** — [markdownlint](https://github.com/DavidAnson/markdownlint). vigiles generates the markdown; structure is correct by construction.
- **Prose quality** — [Vale](https://vale.sh). Different concern.

## License

[MIT](LICENSE)
