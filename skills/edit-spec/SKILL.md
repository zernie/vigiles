---
name: edit-spec
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
description: Edit a vigiles .spec.ts to change a compiled instruction file (CLAUDE.md / AGENTS.md) — add, modify, or remove a rule, section, command, or key file. Use whenever you need to change a CLAUDE.md/AGENTS.md that carries a vigiles hash (edit the spec, never the artifact), including adding a new enforce()/check()/guidance() rule.
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

If no spec exists: if there's a hand-written `CLAUDE.md`, suggest the
`adopt-spec` skill; otherwise suggest `npx vigiles init` to scaffold one.

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

**Adding a rule** (this absorbs the old `generate-rule` skill):

- **Classify the rule** from the request:
  - `enforce()` — a linter rule can back it. Check the project's linter configs
    (ESLint, Ruff, Clippy, Pylint, RuboCop, Stylelint) for a matching rule; also
    consider an architectural tool (ast-grep, Dependency Cruiser, Steiger). If
    uncertain whether a rule exists, **ask the user** rather than guessing.
  - `check()` — a filesystem structural convention ("every X needs a Y"). Only
    for file-pairing; never for code content.
  - `guidance()` — can't be mechanically enforced (subjective conventions,
    process rules, migration context).
- For `enforce()`: use the real linter rule name (e.g. `eslint/no-console`,
  `@typescript-eslint/no-explicit-any`, `ruff/T201`).
- Add to the `rules` object with a kebab-case key derived from the intent,
  preserving alphabetical order if the existing rules are alphabetical. Import
  any new builders needed (e.g. `check` and `every` for the first `check()`).

**Updating a section:**

- Edit the string in `sections`. Sections are plain strings or tagged template literals with `file()`, `cmd()`, `ref()` for verified references
- Do NOT add `#` or `##` headers inside sections — they break the document structure

**Adding a key file or command:**

- Add to `keyFiles` or `commands`. The compiler verifies these exist at compile time
- For commands: must match a script in `package.json`
- For key files: must exist on disk
- 🔴 **KEEP THE DESCRIPTION TO ONE LINE — aim for 120 characters, never exceed
  ~200.** A `keyFiles` entry is a POINTER: what the file is for, so a reader knows
  whether to open it. The explanation of how it works belongs in that file's own
  header comment, where it is read when someone is actually in the file. An
  instruction file is loaded on EVERY request, so a paragraph here is paid for
  every turn, forever, by every reader — including the ones who never touch that
  file.
- **This list only ever grows unless you shrink it.** Every session adds entries
  and none removes them, so before adding, check whether a NEARBY entry is now
  stale (the file moved, the role changed, the description restates its header)
  and fix it in the same edit. Adding without ever pruning is how an instruction
  file reaches four times its harness's budget — `vigiles audit` reports that
  number as `Always-loaded instructions`, so check it when you touch this list.

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
npx vigiles lint
```

If the vigiles plugin is installed (`/plugin marketplace add zernie/vigiles` then `/plugin install vigiles@vigiles`, or `npx vigiles init`), the PostToolUse hook recompiles automatically after you save the spec.

## Important

- **Do what's asked; don't silently escalate enforcement.** Add the rule the user asked for. If making it an `enforce()` would need a linter-config edit or a plugin install (a cost), or if it could fail a clean CI, **say so and let the user choose** — don't change linter config or flip on strict / `workflow` gating on your own. A pure win (a rule that's already enabled) you can just apply. The `strengthen` skill owns `guidance()` → `enforce()` upgrades.
- **Never edit CLAUDE.md or AGENTS.md directly** — they have a vigiles hash comment and are build artifacts
- **The spec is TypeScript** — you get type checking, autocomplete, and verified references
- **`enforce()` rules are verified** — the compiler checks the rule exists AND is enabled in your linter config
- **Sections must not contain `#` or `##` headers** — use separate named sections instead
