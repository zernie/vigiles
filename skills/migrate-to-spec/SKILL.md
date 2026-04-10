---
name: migrate-to-spec
description: Convert an existing hand-written CLAUDE.md into a typed .spec.ts file for incremental adoption
disable-model-invocation: true
argument-hint: <path to CLAUDE.md, defaults to CLAUDE.md>
---

Convert an existing hand-written CLAUDE.md (or AGENTS.md) into a typed `CLAUDE.md.spec.ts` file. This is the incremental adoption path — you keep your existing instruction file as the starting point and get type safety going forward.

## Instructions

### Step 1: Read the Existing File

Read the target instruction file (default: `CLAUDE.md` in the repo root). If the user specified a path, use that.

Also check if vigiles is installed: look for `vigiles` in `package.json` devDependencies. If not, suggest:

```bash
npm install -D vigiles
```

### Step 2: Parse the Structure

Identify these sections in the markdown:

- **Commands** — lines like `` `npm run build` — description `` or ``- `command` — description``
- **Key files** — lines like `` `src/foo.ts` — description `` listing important files
- **Rules** — `###` headings with `**Enforced by:**` or `**Guidance only**` annotations
- **Prose sections** — everything else (positioning, architecture, principles, etc.)

For each rule, classify it:

- Has `**Enforced by:** \`linter/rule\``→`enforce("linter/rule", "why")`
- Has `**Enforced by:** \`code-review\``or similar non-linter →`guidance("...")`
- Has `**Guidance only**` → `guidance("...")`
- Has no annotation → mark as TODO for the user to classify

### Step 3: Generate the Spec File

Create `CLAUDE.md.spec.ts` (or the appropriate name based on the source file) with this structure:

```typescript
import {
  claude,
  enforce,
  guidance,
  check,
  every,
  file,
  cmd,
  ref,
  instructions,
} from "vigiles/spec";

export default claude({
  sections: {
    // Prose sections here
  },

  keyFiles: {
    // Key files here
  },

  commands: {
    // Commands here
  },

  rules: {
    // Rules here
  },
});
```

**Important guidelines:**

- Use `file()` refs in sections where file paths appear in backticks — this enables stale reference detection
- Use `cmd()` refs for any `npm run` commands mentioned in sections
- Convert `**Enforced by:** \`code-review\``rules to`guidance()` — code review is not a mechanical enforcement
- For rules with no annotation, add a `// TODO: classify as enforce() or guidance()` comment
- Keep rule IDs as kebab-case versions of the heading text
- Preserve the `**Why:**` text as the second argument to `enforce()` or `guidance()`
- If sections reference other files or skills, use `ref()` for cross-references

### Step 4: Verify the Spec Compiles

Run:

```bash
npm run build
npx vigiles compile CLAUDE.md.spec.ts
```

Compare the compiled output against the original file. Key differences are expected (formatting, section ordering), but all rules, commands, key files, and prose content should be preserved.

### Step 5: Present the Result

Show the user:

1. The generated spec file
2. How many rules were converted (enforce vs guidance vs TODO)
3. How many file/cmd refs were added for stale reference detection
4. The command to compile: `npx vigiles compile`
5. The command to verify: `npx vigiles check`

Ask if they want you to write the file. If yes, also suggest adding to `.gitignore` or updating CI to run `vigiles compile` and `vigiles check`.

### Step 6: Optional — Set Up CI

If the user wants CI integration, suggest adding to their GitHub Actions workflow:

```yaml
- name: Compile specs
  run: npx vigiles compile
- name: Verify integrity
  run: npx vigiles check
```

Or using the vigiles GitHub Action:

```yaml
- uses: zernie/vigiles@main
  with:
    command: check
```
