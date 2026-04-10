# vigiles Adoption Strategy

Goal: **`npx vigiles setup && npx skills add zernie/vigiles` works on first run with zero config. The agent starts editing specs automatically — no workflow change required. Start permissive, tighten over time.**

### Adoption Principles

1. **Works on first run.** Setup must succeed in any project without configuration. Auto-detect everything. Create reasonable defaults. Don't block on missing tools.
2. **Zero workflow change.** After plugin install, the agent edits specs instead of markdown. The user doesn't need to learn a new workflow — they say "update CLAUDE.md" and the plugin handles the redirect.
3. **Start permissive, tighten later.** First run creates `guidance()` rules (no enforcement). User upgrades to `enforce()` as they add linter rules. `require-spec: false` available for incremental migration.
4. **Every surface tells you the next step.** `vigiles check` says "run setup." The hook says "edit the spec." The wizard says "install the plugin." No dead ends.

---

## Scope: What vigiles Does vs. Doesn't

vigiles compiles typed TypeScript specs to **markdown instruction files** (CLAUDE.md, AGENTS.md). It verifies linter rules, file paths, and commands at compile time. The compiled markdown is the artifact.

**vigiles handles:** CLAUDE.md (Claude Code), AGENTS.md (Codex, GitHub Copilot, any agent that reads AGENTS.md). These are both plain markdown — same compiler, same validation, different `target`.

**vigiles does NOT handle:** `.cursorrules`, `.copilot-instructions.md`, Windsurf format, or any non-markdown target. These have different structures. Use [rule-porter](https://github.com/nichochar/rule-porter) or [rulesync](https://github.com/dyoshikawa/rulesync) to convert compiled markdown to those formats. vigiles is the source; sync tools are the distribution layer.

**No symlinks needed.** AGENTS.md is a first-class target via `target: "AGENTS.md"` or `target: ["CLAUDE.md", "AGENTS.md"]`. The compiler outputs both from one spec.

---

## The Setup Wizard

`npx vigiles setup` is the single entry point. It does everything:

1. **Creates spec** — scaffolds `CLAUDE.md.spec.ts` (or `--target=AGENTS.md` variant)
2. **Generates types** — scans linters, package.json, project files → `.vigiles/generated.d.ts`
3. **Compiles** — spec → markdown with SHA-256 hash
4. **Adds CI step** — finds existing GHA workflow and appends `vigiles check` + `generate-types --check`
5. **Prompts plugin install** — prints `npx skills add zernie/vigiles` with explanation

After setup, the user edits the spec, runs `vigiles compile`, and commits. The plugin handles everything else automatically.

---

## Adoption Levels

### Level 0: Discovery

User runs `npx vigiles check` on an existing repo. `require-spec` fires: "No spec file found. Run `npx vigiles setup`." First nudge.

### Level 1: Setup

```bash
npx vigiles setup
```

One command. Creates spec, types, compiled markdown, CI step. The user has a working pipeline in under a minute.

### Level 2: Plugin

```bash
npx skills add zernie/vigiles
```

Two hooks activate:

- **PreToolUse**: Blocks direct edits to compiled `.md` files. Agent gets redirected to `.spec.ts`.
- **PostToolUse**: Auto-runs `generate-types` on config changes, `compile` on spec changes.

### Level 3: Multi-Target

```typescript
export default claude({
  target: ["CLAUDE.md", "AGENTS.md"],
  rules: { ... },
});
```

One spec, multiple outputs. For non-markdown formats, pipe through rule-porter.

### Level 4: Type Narrowing

Commit `.vigiles/generated.d.ts`. Now `enforce("eslint/no-consolee")` is a type error in the editor. Types narrow `enforce()`, `file()`, `cmd()` via declaration merging.

---

## Pain Points (Updated)

| Pain Point                        | Status    | Resolution                                      |
| --------------------------------- | --------- | ----------------------------------------------- |
| Multi-step installation           | Fixed     | `vigiles setup` does everything                 |
| No CI integration from wizard     | Fixed     | Wizard auto-adds GHA step                       |
| Plugin not mentioned as important | Fixed     | README and wizard both prompt it                |
| Agent edits compiled .md directly | Fixed     | PreToolUse hook blocks with redirect            |
| Cursor/Windsurf support           | Won't fix | Out of scope — use sync tools                   |
| Codex / AGENTS.md                 | Fixed     | First-class target                              |
| No interactive mode for agents    | Open      | `vigiles setup` works non-interactively already |

## README Structure

The README should have:

1. **Hook** — one compelling sentence
2. **Problem** — realistic example of rot
3. **Fix** — the spec that catches it
4. **Quick Start** — `npx vigiles setup` (one command)
5. **Three Rule Types** — enforce/check/guidance
6. **Verified References** — file/cmd/ref
7. **Type-Safe Rule References** — generate-types + narrowing
8. **CLI** — reference for all commands
9. **GitHub Action** — CI snippet
10. **Plugin** — what it does, install command
11. **Output Targets** — CLAUDE.md, AGENTS.md, multi-target
12. **Related Tools** — sync tools for non-markdown formats

No separate installation steps. The wizard IS the installation.
