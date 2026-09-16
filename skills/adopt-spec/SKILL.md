---
name: adopt-spec
description: Adopt a typed .spec.ts for an existing hand-written CLAUDE.md — start from the file you already have, non-destructively
disable-model-invocation: true
argument-hint: <path to CLAUDE.md, defaults to CLAUDE.md>
---

Start a typed `CLAUDE.md.spec.ts` from an existing hand-written CLAUDE.md (or AGENTS.md). This is the non-destructive adoption path — you keep your existing instruction file as the starting point and get type safety going forward.

## Adoption rules

Adoption is the **safe, faithful on-ramp — never an upgrade in disguise.** These are non-negotiable:

- **Faithful.** Preserve every rule, command, key file, and prose section as-is. Invent nothing — the spec must compile back to ~the user's existing file.
- **Non-destructive.** Never edit the original `CLAUDE.md` / `AGENTS.md`. Only write the new `.spec.ts`. Never auto-`compile` over the file — switching it to spec-managed is a separate, explicit step the user runs with a diff to review.
- **Don't escalate enforcement.** Keep `guidance()` as `guidance()`. Upgrading to `enforce()` has a cost (config/plugins, possible false positives) and is a separate opt-in step — the `strengthen` skill. Adoption is **not** turning on strict / `workflow` gating.
- **Reversible.** `vigiles eject <file>` hands the file back as plain hand-owned markdown anytime — it's never a one-way door. Tell the user this.
- **Ask before writing.** Present the generated spec and a conversion summary first; write only on the user's yes.
- **A lighter touch exists.** For no spec at all, inline `<!-- vigiles:enforce ... -->` comments are verified by `vigiles lint` with the same engine.

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
    // Key files here. A path maps to ONE LINE saying what the file is for —
    // aim for 120 characters, never exceed ~200. The entry is a pointer, not a
    // summary: how the file works belongs in its own header comment, which is
    // read when someone opens it. This file is loaded on every request, so a
    // paragraph here is paid for every turn. Prune a stale neighbour whenever
    // you add one; `vigiles audit` prints the running total as
    // `Always-loaded instructions`.
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
5. The command to verify: `npx vigiles lint`

Ask if they want you to write the file. If yes, also suggest adding to `.gitignore` or updating CI to run `vigiles compile` and `vigiles lint`.

### Step 6: Optional — Set Up CI

If the user wants CI integration, suggest adding to their GitHub Actions workflow:

```yaml
- name: Compile specs
  run: npx vigiles compile
- name: Verify references + integrity
  run: npx vigiles lint
```

Or using the vigiles GitHub Action:

```yaml
- uses: zernie/vigiles@v1
  with:
    command: lint
```
