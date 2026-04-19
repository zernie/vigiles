# Runtime Spec Enforcement

## The Gap

vigiles currently operates at two points:

1. **Compile time** — validate the spec (linter rules exist, files resolve, commands are in package.json)
2. **Audit time** — validate the output (hash intact, inputs fresh)

Missing: **runtime** — validate agent behavior as it happens.

The spec declares "never modify package-lock.json directly" as a guidance rule. The agent reads that. But nothing stops the agent from ignoring it. The spec is advice, not policy.

## Three Layers of Runtime Enforcement

### Layer 1: Passive observation (what did the agent do?)

After an agent session, diff the workspace against the spec's expectations:

- Agent wrote to files not referenced in any spec → flag
- Agent ran commands not declared in any spec → flag
- Files referenced via `file()` were modified → track
- Linter config changed → spec may need recompile

This is post-hoc analysis. No blocking, no execution risk. Read the git diff, compare against the spec's declared surface area.

**What it catches:** Agents that ignore the spec, drift between agent behavior and spec intent, files modified without corresponding spec updates.

**What it doesn't catch:** Real-time violations, issues within a session before commit.

### Layer 2: Hook-based policy enforcement (prevent violations as they happen)

Claude Code hooks provide PreToolUse and PostToolUse events. PreToolUse fires before a tool call executes and can block it (exit 2) or modify it (updatedInput). PostToolUse fires after and can inject context.

Hook stdin receives full tool call details:

| Tool  | Key fields available                    |
| ----- | --------------------------------------- |
| Edit  | `file_path`, `old_string`, `new_string` |
| Write | `file_path`, `content`                  |
| Bash  | `command`, `description`                |
| Read  | `file_path`                             |
| Grep  | `pattern`, `path`                       |
| Glob  | `pattern`, `path`                       |

This is enough to enforce spec-derived policies in real time:

**File access control.** The spec declares `keyFiles`. A PreToolUse hook can allowlist or denylist writes based on those declarations:

```typescript
// Spec declares:
keyFiles: {
  "src/compile.ts": "Compiler — core, modify with care",
  "src/spec.ts": "Type system — readonly",
}

// Hook policy derived from spec:
// - Write/Edit to "src/spec.ts" → DENY (declared readonly)
// - Write/Edit to file not in keyFiles and not *.spec.ts → WARN
```

**Compiled output protection.** Already implemented — the PreToolUse hook blocks direct edits to compiled `.md` files and redirects to the `.spec.ts` source. This is the simplest form of spec-derived enforcement.

**Command allowlisting.** The spec declares `commands`. A PreToolUse hook on Bash can warn when the agent runs commands not in the spec:

```
Spec declares: npm test, npm run build, npm run fmt
Agent runs: npm run deploy
Hook: WARN — "npm run deploy" is not declared in the spec. Proceed?
```

This isn't about blocking dangerous commands (that's the harness's job). It's about flagging when the agent does something the spec didn't anticipate — a signal that the spec may be incomplete.

**Linter rule enforcement.** PostToolUse on Edit/Write can run the relevant linter on the modified file. If a spec says `enforce("eslint/no-console")` and the agent writes `console.log`, the hook catches it before commit. This is scoped linting — only the modified file, only the enforced rules.

### Layer 3: Skill contracts (declare what a skill touches)

Skills today are unstructured markdown. They tell the agent what to do but don't declare their side effects. A skill contract makes side effects explicit:

```typescript
skill({
  name: "strengthen",
  description: "Upgrade guidance rules to enforce rules",
  body: "...",
  contract: {
    reads: ["*.spec.ts", "eslint.config.*", ".eslintrc.*"],
    writes: ["*.spec.ts"],
    commands: ["npx vigiles compile"],
    modifiesSpecs: true,
  },
});
```

The contract is verifiable:

- **At compile time:** Do the declared reads/writes reference files that exist?
- **At runtime (via hooks):** Did the skill only touch the files it declared? A PreToolUse hook compares each tool call against the active skill's contract. Write to a file outside `writes`? Block or warn.
- **Post-session:** Did the skill's actual behavior match its contract? Diff the workspace against the declaration.

This is the allowlist pattern from the guardrails literature applied to skills. Default-deny: if the contract doesn't declare it, the skill shouldn't do it.

**Challenge:** Claude Code doesn't currently expose which skill is active to hooks. The hook receives `tool_name` and `tool_input` but not "this tool call was triggered by skill X." Without that context, contract enforcement requires the skill itself to declare its scope at session start (e.g., write a `.vigiles/active-contract.json` that hooks read).

## What vigiles Can Generate from Specs

The spec already contains enough information to derive runtime policies. No new syntax needed for basic enforcement:

| Spec declaration                                                     | Derived policy                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `file("src/api.ts")` in keyFiles                                     | Allow reads. Warn on writes if not in a known skill.                 |
| Compiled `.md` has vigiles hash                                      | Block writes (already implemented).                                  |
| `cmd("npm test")`                                                    | Allowlisted command.                                                 |
| `enforce("eslint/no-console")`                                       | PostToolUse: run `eslint --rule no-console` on modified `.ts` files. |
| `guidance("don't modify lockfile")`                                  | Can't enforce mechanically — it's guidance. But could warn.          |
| `keyFiles` with description containing "readonly" or "do not modify" | Block writes via PreToolUse.                                         |

The last one is interesting: vigiles could parse keyFiles descriptions for intent signals ("readonly", "do not modify", "generated", "build artifact") and derive write policies. This is heuristic, not type-safe — but the spec author controls the descriptions, so false positives are self-inflicted and fixable.

A more principled approach: extend the keyFiles API with explicit access modes:

```typescript
keyFiles: {
  "src/compile.ts": { desc: "Compiler", access: "read-write" },
  "src/spec.ts": { desc: "Type system", access: "readonly" },
  "dist/": { desc: "Build output", access: "none" },
}
```

## Hook Generation

vigiles could compile specs to both markdown AND hook configurations:

```bash
vigiles compile --hooks
```

Output: a `.claude/hooks/vigiles-policy.json` that the user merges into `.claude/settings.json`. The hooks enforce the spec-derived policies without the user writing hook scripts manually.

Example generated hook (PreToolUse on Edit/Write):

```json
{
  "matcher": "Edit|Write",
  "command": "node .vigiles/enforce.mjs"
}
```

Where `.vigiles/enforce.mjs` is a generated script that:

1. Reads the tool input from stdin (file_path, etc.)
2. Loads the sidecar manifest to know which specs exist and what they declare
3. Checks the file against spec-derived policies (readonly files, compiled outputs, contract scope)
4. Exits 0 (allow), 2 (block), or outputs a warning via systemMessage

This keeps the spec as the single source of truth. The hooks are derived artifacts, like the compiled markdown.

## Differential Analysis (Post-Session)

After an agent session, `vigiles audit --diff` could compare the workspace state against spec expectations:

```
Session analysis:
  Files modified by agent:
    src/compile.ts       — in keyFiles (CLAUDE.md) ✓
    src/freshness.ts     — in keyFiles (CLAUDE.md) ✓
    src/utils/helper.ts  — NOT in any spec ⚠
    package.json         — tracked input (CLAUDE.md) — spec may need recompile

  Commands executed:
    npm test             — in spec ✓
    npm run build        — in spec ✓
    npm run deploy       — NOT in any spec ⚠

  Spec freshness after session:
    CLAUDE.md            — stale (package.json changed)
```

This requires either git diff (comparing before/after) or hook-collected logs (recording every tool call during the session). Git diff is simpler and doesn't require hooks to be installed.

## Competitive Landscape

| Tool/Platform                | Approach                                       | Deterministic        | Scope                          |
| ---------------------------- | ---------------------------------------------- | -------------------- | ------------------------------ |
| Claude Code permission modes | Allowlist by tool type (plan/acceptEdits/auto) | Yes                  | Coarse — all files or no files |
| Superagent                   | Runtime threat detection, tool call filtering  | Partial (ML + rules) | API-level, enterprise          |
| AWS Bedrock Guardrails       | Content filtering, topic denial                | No (ML-based)        | Cloud-only                     |
| Claude Code hooks (raw)      | User-written shell scripts per event           | Yes                  | Flexible but manual            |
| vigiles (proposed)           | Spec-derived policies compiled to hooks        | Yes                  | Scoped to spec surface area    |

The gap: Claude Code hooks are powerful but manual. Users write ad-hoc shell scripts. There's no tool that generates hook policies from a structured declaration. vigiles is in a unique position because it already has the structured declaration (the spec) and a compilation pipeline (spec → artifacts). Adding hooks as a compilation target is architecturally natural.

## Scope and Risks

### What to build

1. **Compiled output protection** — already exists (PreToolUse blocks edits to hashed `.md` files).
2. **Post-session differential analysis** — `vigiles audit --diff` compares workspace state against spec surface area. Read-only, zero risk.
3. **Hook generation from specs** — `vigiles compile --hooks` emits hook configurations derived from keyFiles, commands, and enforce rules. User reviews and installs.
4. **Scoped linting on modified files** — PostToolUse runs enforced linter rules on files the agent just modified. Read-only analysis, no execution of arbitrary commands.

### What NOT to build

1. **Arbitrary command execution** — vigiles should never run user-defined commands. Linter invocation is scoped and well-understood; running `npm test` is not.
2. **Content filtering / prompt injection detection** — ML territory. Superagent, Bedrock Guardrails, and similar tools handle this. Not vigiles's domain.
3. **Full sandboxing** — OS-level isolation (bubblewrap, containers) is infrastructure, not a linter concern.
4. **Blocking by default** — Hooks should warn, not block, unless the user explicitly configures strict mode. Aggressive blocking makes the agent unusable. The first version should be observational.

### Risk: false sense of security

Hooks run in the same process context as the agent. A sufficiently capable agent could theoretically modify hook scripts or settings. Runtime enforcement is defense-in-depth, not a security boundary. The spec is a contract, not a jail.

## Implementation Phases

### Phase 1: Post-session audit (read-only, no hooks needed)

`vigiles audit --session` reads the git diff since the last commit (or a specified base) and reports:

- Files modified that aren't in any spec's keyFiles
- Commands in bash history that aren't in any spec's commands
- Specs that are now stale due to input changes

This works without hooks. It's git diff analysis against the sidecar manifests. Ship it as an audit subcommand.

### Phase 2: Hook generation (compile target)

`vigiles compile --hooks` generates a `.vigiles/enforce.mjs` script and a hook configuration snippet. The user installs the hooks by merging into `.claude/settings.json`.

Initial policies:

- Block edits to compiled `.md` files (existing behavior, generated instead of hand-written)
- Warn on writes to files not in any spec's keyFiles
- Warn on bash commands not in any spec's commands

### Phase 3: Scoped linting hooks

PostToolUse on Edit/Write triggers scoped linter checks:

- Read the modified file path from stdin
- Check which spec's keyFiles contains this file
- Run the linter rules that spec declares via `enforce()`
- Report violations as additionalContext (the agent sees them and can fix)

This is the enforce() rules being enforced at runtime, not just documented.

### Phase 4: Skill contracts

Extend the `skill()` API with optional `contract` field. Compile skill contracts to hook policies that scope tool calls to the declared reads/writes/commands. This requires Claude Code to expose active-skill context to hooks, or a workaround via session state files.

## Open Questions

1. **Should hook generation be opt-in or default?** Recommendation: opt-in via `vigiles compile --hooks`. Hooks change agent behavior — that should be explicit.
2. **Warn or block?** Recommendation: warn by default, block for compiled output protection only. A `--strict` flag escalates warnings to blocks.
3. **How to handle subagents?** Claude Code hooks fire for subagent tool calls too (agent_id is in stdin). Should policies differ for Plan/Explore/Task subagents?
4. **Session boundary detection:** `vigiles audit --session` needs to know "what changed since the agent started." Git stash? Commit hash? Timestamp? The sidecar manifest's `compiledAt` timestamp could serve as the baseline.
5. **keyFiles access modes:** Should `readonly`/`read-write`/`none` be a first-class API, or should vigiles infer intent from descriptions? Recommendation: first-class API. Inference from prose is fragile.
6. **Contract enforcement without skill context:** If hooks can't know which skill is active, should the skill write a state file (`.vigiles/active-skill.json`) at start and clean up at end? This is brittle but workable.
