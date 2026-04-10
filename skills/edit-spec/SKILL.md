---
name: edit-spec
description: Edit a vigiles spec file to update instruction files (CLAUDE.md, AGENTS.md)
disable-model-invocation: true
argument-hint: <what to change — e.g., "add a rule about error handling" or "update the testing section">
---

Edit a `.spec.ts` file to update the project's instruction files. The spec is the source of truth — CLAUDE.md and AGENTS.md are compiled build artifacts that must not be edited directly.

## Arguments

$ARGUMENTS — What the user wants to change. Examples:

- "add a rule about always using the custom logger"
- "update the architecture section"
- "add src/services/auth.ts to key files"
- "add npm run lint to commands"
- "change the testing guidance"

## Instructions

### Step 1: Find the Spec

Look for spec files in the repo root:

- `CLAUDE.md.spec.ts` — source for CLAUDE.md
- `AGENTS.md.spec.ts` — source for AGENTS.md
- Any `*.spec.ts` matching instruction files

If no spec exists, suggest: `npx vigiles setup`

### Step 2: Read and Understand the Spec

Read the spec file. It's a TypeScript file that exports a `claude()` call with these fields:

```typescript
import { claude, enforce, guidance, check, every } from "vigiles/spec";

export default claude({
  // Optional: output target (defaults to "CLAUDE.md")
  target: "CLAUDE.md",
  // or multi-target:
  // target: ["CLAUDE.md", "AGENTS.md"],

  // Prose sections — become ## headings in compiled output
  sections: {
    positioning: "What this project does...",
    architecture: "How the codebase is structured...",
  },

  // File paths verified to exist at compile time
  keyFiles: {
    "src/index.ts": "Main entry point",
  },

  // Commands verified against package.json
  commands: {
    "npm run build": "Compile the project",
    "npm test": "Run all tests",
  },

  // Rules — three types
  rules: {
    // enforce() — backed by a linter rule, verified to exist AND be enabled
    "no-any": enforce(
      "@typescript-eslint/no-explicit-any",
      "Use unknown and narrow with type guards.",
    ),

    // check() — filesystem assertion run by vigiles
    "test-pairing": check(
      every("src/**/*.service.ts").has("{name}.test.ts"),
      "Every service must have tests.",
    ),

    // guidance() — prose only, no enforcement
    "research-first": guidance("Google unfamiliar APIs before implementing."),
  },
});
```

### Step 3: Make the Changes

Based on what the user asked for:

**Adding a rule:**

- Determine the type: `enforce()` if a linter rule exists, `check()` for filesystem conventions, `guidance()` for prose-only
- For `enforce()`: find the actual linter rule name (e.g., `eslint/no-console`, `@typescript-eslint/no-explicit-any`, `ruff/T201`)
- Add to the `rules` object with a descriptive key

**Updating a section:**

- Edit the string in `sections`. Sections are plain strings or tagged template literals with `file()`, `cmd()`, `ref()` for verified references
- Do NOT add `#` or `##` headers inside sections — they break the document structure

**Adding a key file or command:**

- Add to `keyFiles` or `commands`. The compiler verifies these exist at compile time
- For commands: must match a script in `package.json`
- For key files: must exist on disk

### Step 4: Compile

After editing the spec, run:

```bash
npx vigiles compile
```

This regenerates the compiled instruction file(s). Review the output for any errors:

- `stale-file` — a key file path doesn't exist
- `stale-command` — a command isn't in package.json
- `invalid-rule` — a linter rule doesn't exist or is disabled
- `section-has-header` — a section contains `#` headers (break into separate named sections)

### Step 5: Verify

```bash
npx vigiles check
```

If the PostToolUse hook is installed (via `npx skills add zernie/vigiles`), compilation happens automatically after you save the spec.

## Important

- **Never edit CLAUDE.md or AGENTS.md directly** — they have a vigiles hash comment and are build artifacts
- **The spec is TypeScript** — you get type checking, autocomplete, and verified references
- **`enforce()` rules are verified** — the compiler checks the rule exists AND is enabled in your linter config
- **Sections must not contain `#` or `##` headers** — use separate named sections instead
