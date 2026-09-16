# Spec Format Reference

vigiles specs are TypeScript files (`*.spec.ts`) that compile to markdown instruction files. The spec is the source of truth; the markdown is a build artifact.

## Why a spec? — what markdown can't do

Be honest about what a spec is **not** for. The reference checks — does this
`file()` exist, is this linter rule enabled, is this `cmd()` a real script — do
**not** need a spec. vigiles runs them on a plain CLAUDE.md via inline
[`<!-- vigiles:enforce -->` comments](markdown-mode.md), on purpose, as the
on-ramp. If verification is all you want, **stay in markdown**.

A spec earns its place when you cross from **declaring** your harness to
**testing it as code** — the things a string format structurally cannot give you:

1. **A typed _contract with structure_, not a string.** A subagent's
   `result(okShape, errShape)` is a discriminated union of typed fields. It
   compiles to a `vigiles:ok`/`err` block the runtime emits and a test parses with
   **`assertAgentOk`** — a real assertion, **no LLM judge** (see
   [railway-subagents.md](railway-subagents.md)). A frontmatter `description:` is a
   flat string; it can't carry a multi-field outcome, and a test has nothing
   deterministic to parse. **This is the differentiator** — the substrate the
   [Test](harness-testing.md) and [Measure](measuring-skills.md) tiers build on.
2. **Checked by a compiler you already run.** Tool names and rule IDs get a red
   squiggle at edit time via the generated `.d.ts`, before any vigiles command.
   (The JSON-Schema generator gives frontmatter LSP autocomplete too, so this part
   is _partially_ replicable in YAML — but only for flat name fields, not a
   structured contract.)
3. **It compiles and composes.** One spec → CLAUDE.md _and_ AGENTS.md
   byte-identical; `railway()`/`delegate()` resolve targets across sibling specs at
   compile time. Markdown is inert per-file text — it can't fan out or compose.

So: **markdown declares; a spec is testable as code.** Reach for a spec exactly
when you want `result()` → `assertAgentOk`. The rest is the field reference.

### Enforce vs. verify

A spec gives you a `tools` allowlist and a `purity` floor. It's tempting to read
those as "the same thing the tests check, twice." They are **not** — they answer
different questions:

| Layer              | What it is                                                                              | When it runs            | What it guarantees                                                            |
| ------------------ | --------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| **Enforce** (gate) | the `purity` floor / `tools` allowlist → a `PreToolUse` rail that **denies** a bad call | **runtime**, every call | the disallowed action is **impossible in the loop** — deterministic, no model |
| **Verify** (test)  | `assertAgentOk`, `wrote`/`didNotWrite`, `notTool`                                       | **author-time / CI**    | the harness **does its job** and **stays in its lane** — a different property |

The gate **prevents**; the test **proves behaviour**. A test is not re-checking
the gate — you use `notTool`/`didNotWrite` to verify a _prose_ instruction that
has no runtime enforcement (can the agent be talked out of it?), or to assert the
wiring fires, never to second-guess `decidePurityGate`. Where you have a floor,
trust it: it's a structural guarantee, not a probabilistic one. Where you only
have prose, the test is how you find out it leaks — and that's the signal to add a
floor. See [harness-testing.md](harness-testing.md).

## CLAUDE.md Specs

Use `claude()` to define a CLAUDE.md spec. Export it as the default export.

```ts
import { instructionFile, enforce, guidance, file, cmd, ref, prose } from "vigiles/spec";

export default instructionFile({
  target: "CLAUDE.md",          // or "AGENTS.md", or ["CLAUDE.md", "AGENTS.md"]
  sections: { ... },
  keyFiles: { ... },
  commands: { ... },
  rules: { ... },
  maxSectionLines: 30,          // optional: cap per-section line count
});
```

### `target`

`string | string[]` -- Output filename(s). Defaults to `"CLAUDE.md"`. Also used as the `# Heading` in compiled output. Pass an array to compile one spec to multiple targets:

```ts
target: ["CLAUDE.md", "AGENTS.md"],  // emits both from one spec
```

### `sections`

`Record<string, string | InstructionFragment[]>` -- Named prose sections. Each key becomes a `## Heading` in the compiled output (first letter uppercased). Values are either plain strings or tagged templates via `prose` with embedded `file()`, `cmd()`, and `ref()` references.

Each section (and each subagent section) is length-guarded at compile time: a single section over a **generous 200-line default** is rejected as a likely content dump (TypeScript types can't bound a string's length, so the cap lives in the compiler — the ESLint `max-len` precedent). Override per spec with `maxSectionLines` (tighter to enforce your own limit, larger for an intentionally long section); `maxTokens` caps the whole compiled file.

### Budget warnings: what the line guard cannot see

Two checks run beside the line guard and print as **warnings** — they never fail a compile, because a budget that blocks adoption of a file you already have is a budget people turn off.

| check                              | default               | why                                                                                                                                                                                                                |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| per-entry, `keyFiles` / `commands` | **200 characters**    | An entry is a _pointer_ — what the file is for, so a reader knows whether to open it. The explanation belongs in that file's own header, where it is read when someone opens the file instead of on every request. |
| per-section, characters            | **15 000 characters** | Lines do not measure cost. One real section here was **24 lines and 20 416 characters** — it passed a 200-_line_ gate with two orders of magnitude to spare.                                                       |

Both are tunable (`0` disables): pass `maxEntryChars` / `maxSectionChars` as compile options.

Why these two shapes and not a total: an instruction file grows one unremarkable entry at a time, and nobody removes one. A total tells you "too big" long after you could act, and names no offender; a per-entry budget names the row at the moment it is added. For the whole-file number — everything the harness loads _without being asked_, which is the figure that actually bills you — run `vigiles audit` and read `Always-loaded instructions`.

<!-- vigiles:ignore -->

```ts
sections: {
  architecture: `Three rule types: enforce(), guard(), and guidance().`,
  setup: prose`See ${file("docs/setup.md")} and run ${cmd("npm install")}.`,
}
```

### `keyFiles`

`Record<string, string>` -- File paths mapped to descriptions. Each path is verified via `existsSync` at compile time. Compiles to a bullet list under `## Key Files`.

```ts
keyFiles: {
  "src/spec.ts": "Type system and builder functions",
  "src/compile.ts": "Compiler: spec to markdown with SHA-256 hash",
}
```

### `commands`

`Record<string, string>` -- Commands mapped to descriptions. `npm run <script>` and `npm <lifecycle>` commands are verified against `package.json` scripts at compile time. Compiles to a bullet list under `## Commands`.

```ts
commands: {
  "npm run build": "Compile TypeScript to dist/",
  "npm test": "Build and run all tests",
}
```

### `rules`

`Record<string, Rule>` -- Rule ID mapped to an `enforce()`, `guard()`, or `guidance()` rule. The ID is kebab-cased by convention and is converted to a Title Case `### Heading` in compiled output. See [Rule Types](#rule-types) below.

## SKILL.md Specs

Use `skill()` to define a SKILL.md spec. Compiles to markdown with YAML frontmatter.

<!-- vigiles:ignore -->

```ts
import { skill, file, cmd, ref, prose } from "vigiles/spec";

export default skill({
  name: "example-skill",
  description: "Example skill for illustration",
  argumentHint: "<some argument>",
  disableModelInvocation: true,
  body: prose`
    Check ${file("eslint.config.ts")} for existing rules.
    Run ${cmd("npm test")} to verify.
    See ${ref("skills/other/SKILL.md")} for format.
  `,
});
```

| Field                    | Type                                                | Required | Description                                                                                                        |
| ------------------------ | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `name`                   | `string`                                            | yes      | Skill name (used in YAML frontmatter)                                                                              |
| `description`            | `string`                                            | yes      | Short description (frontmatter) -- the trigger surface, keep it short                                              |
| `argumentHint`           | `string`                                            | no       | Hint for the argument (frontmatter)                                                                                |
| `inputs`                 | `SkillInput[]`                                      | no       | Typed inputs via `input(name, hint)` -- compile to argument-hint + an `## Arguments` section                       |
| `disableModelInvocation` | `boolean`                                           | no       | Disable model invocation flag (frontmatter)                                                                        |
| `tools`                  | `string[]`                                          | no       | Allowed-tools contract (built-in or `mcp__server__tool`); omit = inherit all                                       |
| `purity`                 | `"pure" \| "bounded" \| "dangerously-unrestricted"` | no       | Side-effect floor (see [Purity & effects](#purity--effects))                                                       |
| `steps`                  | `SkillStep[]`                                       | no       | Gated pipeline via `step(do, { gate, retry })` -- compiles to `## Steps`. Use this OR `body`                       |
| `result`                 | `Gate`                                              | no       | Terminal postcondition gate (`cmd()`/`file()`/`project()`); compiles to `## Result`                                |
| `context`                | `"fork"`                                            | no       | Run as a forked subagent -- the prerequisite for `output`                                                          |
| `output`                 | `OutputContract`                                    | no       | A `result(okShape, errShape)` typed outcome -- **requires `context:"fork"`** (see [Railway](railway-subagents.md)) |
| `body`                   | `string \| InstructionFragment[]`                   | yes\*    | Instruction body -- plain string or tagged template (\*or use `steps`)                                             |
| `maxInlineCodeLines`     | `number`                                            | no       | Warn (non-blocking) when an inline fenced code block is longer than this, nudging it into a `file()` (default 20)  |

## Subagent (agent) Specs

Use `agent()` to define a subagent (`agents/<name>.md`) — a delegated worker with a
verified **tool contract** and, optionally, a typed **railway outcome**. The full
guide (typed outcomes, composing flat workers with `railway()`/`delegate()`,
asserting deterministically) is **[railway-subagents.md](railway-subagents.md)**;
this is the field reference.

<!-- vigiles:ignore -->

```ts
import { experimental_agent } from "vigiles/spec";
const { result } = experimental_agent;

export default experimental_agent({
  name: "code-reviewer",
  description: "Review a diff for correctness defects.",
  model: "opus",
  color: "pink",
  tools: ["Read", "Grep"], // allowlist — already excludes Write/Edit
  purity: "pure", // read-only floor (compile + runtime gate)
  output: result(
    { defects: "string[]", summary: "string" },
    { reason: "string" },
  ),
  body: "You are a careful code reviewer…",
});
```

> **`tools` vs `disallowedTools` — use ONE.** `tools` is an _allowlist_ (only these);
> `disallowedTools` is a _denylist_. Under a `tools` allowlist a tool not listed is
> already unavailable, so `disallowedTools` would be **redundant**. Reach for
> `disallowedTools` only when there's **no** allowlist (the agent inherits all tools)
> and you want to subtract a few — e.g. `experimental_agent({ name, description, disallowedTools: ["Bash"] })`.

| Field             | Type                                                | Required | Description                                                                                    |
| ----------------- | --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`            | `string`                                            | yes      | Subagent name (frontmatter; the dispatch handle)                                               |
| `description`     | `string`                                            | yes      | What it does — read by the orchestrator to decide when to delegate                             |
| `model`           | `string`                                            | no       | Model alias (`"sonnet"`/`"opus"`/`"haiku"`/`"inherit"`)                                        |
| `color`           | `string`                                            | no       | Subagent UI colour (frontmatter)                                                               |
| `tools`           | `string[]`                                          | no       | Allowed-tools contract — **verified** (typo/never-available flagged). Omit = inherit all       |
| `disallowedTools` | `string[]`                                          | no       | Deny-side contract — verified close-typo (a typo'd entry blocks nothing)                       |
| `purity`          | `"pure" \| "bounded" \| "dangerously-unrestricted"` | no       | Side-effect floor (see [Purity & effects](#purity--effects))                                   |
| `output`          | `OutputContract`                                    | no       | `result(okShape, errShape)` typed outcome → `## Output contract`; testable via `assertAgentOk` |
| `sections`        | `Record<string, string \| InstructionFragment[]>`   | no       | Named `##` system-prompt sections (same verified-ref rules as a CLAUDE.md)                     |
| `rules`           | `Record<string, Rule>`                              | no       | Rules the worker must follow → `## Rules`                                                      |
| `body`            | `string \| InstructionFragment[]`                   | no       | The lead "You are…" prose before any sections                                                  |

## Purity & effects

`purity` declares a unit's **side-effect floor**, enforced at compile (the tool
contract can't be looser than the floor) AND at runtime (a PreToolUse gate):

| Level                        | Allows                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `"pure"`                     | read-only tools only (no Write/Edit/Bash side effects)                                                      |
| `"bounded"`                  | + Write/Edit and command-gated Bash (read-only Bash allowed, mutating denied); bars MCP/unknown/inherit-all |
| `"dangerously-unrestricted"` | no enforcement (the loud-at-the-declaration escape hatch)                                                   |

`"pure"`/`"bounded"` require an explicit `tools` list — an absent list inherits ALL
tools and is a violation.

### Three layers of enforcement

The same floor is enforced at three points, weakest-author-effort first:

| Layer                | When                         | How                                                                                                                       |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Type** (authoring) | your spec's own `tsc`        | A typed `agent`/`skill` rejects a bad `purity`×`tools` combination at **edit time**, before any vigiles command runs.     |
| **Compile**          | `vigiles compile`            | `purityViolations` re-checks the declared `tools` against the floor and fails the compile.                                |
| **Runtime** (gate)   | every tool call, in the loop | the `PreToolUse` purity gate (`decidePurityGate`) denies a bad **live** call — including the command-level Bash decision. |

**The type layer is opt-in by import** and a strict ADDITION — it never replaces
the compile/runtime checks, which stay the universal backstop. Import `agent` /
`skill` from **`vigiles/claude-code`** to get the compile-time type error against
the Claude Code tool catalog:

```ts
import { experimental_agent } from "vigiles/claude-code";

experimental_agent({
  name: "r",
  description: "…",
  purity: "pure",
  tools: ["Read", "Bash"],
});
//                                                              ^^^^^^ tsc error — Bash is side-effecting
experimental_agent({
  name: "f",
  description: "…",
  purity: "bounded",
  tools: ["Read", "Bash", "Write"],
}); // OK — bounded admits Bash
experimental_agent({
  name: "x",
  description: "…",
  purity: "bounded",
  tools: ["mcp__s__t"],
});
//                                                              ^^^^^^^^^^^ tsc error — MCP is unknown-effect
```

The **core** `agent` / `skill` (from `vigiles/spec`, the default import) stay
**harness-agnostic and unconstrained** — they accept any `tools` at any purity,
exactly as before (backwards-compatible), and rely on the compile + runtime
checks. So an existing spec importing the core builder is unaffected.

> **The runtime gate remains the backstop for the command level.** A `bounded`
> unit may declare `Bash` (the type admits the _tool_), but whether a given Bash
> _command_ runs is decided at runtime by `decidePurityGate` / `isReadOnlyBash` —
> a read-only command is allowed, a mutating one denied. The type system cannot
> see the command string, so that decision is, and stays, the runtime gate's job.

## Reference Helpers

Reference helpers create branded types that the compiler validates at compile time.

### `file(path)`

Returns a `FileRef` containing a `VerifiedPath`. The path is verified to exist via `existsSync` at compile time. Compiles to a backtick path in markdown: `` `path/to/file.ts` ``.

### `cmd(command)`

Returns a `CmdRef` containing a `VerifiedCmd`. For npm commands, the script is verified against `package.json` at compile time. Compiles to a backtick command: `` `npm run build` ``.

### `ref(path)`

Returns a `SkillRef` containing a `VerifiedRef`. The path is verified to exist at compile time. Compiles to a markdown link: `[dirname](path)`.

### `dir(path)`

Returns a `DirRef` containing a `VerifiedDir`. The path is verified at compile time to exist **and be a directory** (a `dir()` pointing at a file is an error). Compiles to a backtick path: `` `src/core` ``. Use it so a spec that names a directory proves it's really there — the "architecture floats free" fix, where a plain string in prose rots silently.

### `glob(pattern)`

Returns a `GlobRef` containing a `VerifiedGlob`. The pattern is verified at compile time to match **at least one path** (`*` / `**` syntax, dotfiles included). Compiles to a backtick pattern: `` `src/**/*.test.ts` ``. Use it to prove a class of files exists where the instructions claim (e.g. tests, configs).

### `prose`

Tagged template literal that interleaves strings and refs. Use it for `sections` values in `claude()` or the `body` of `skill()`. A single prose section over a generous default (200 lines) is rejected as a likely dump — override with `maxSectionLines`, or split / move detail into a `file()`.

### Outcome & pipeline builders

- `result(okShape, errShape)` — a subagent's (or forked skill's) typed `Result<ok, err>` outcome. Field types: `"string" | "number" | "boolean" | "string[]"`. Full guide: **[railway-subagents.md](railway-subagents.md)**.
- `railway({ name, steps, recover, onError })` + `delegate(agent, task?)` — compose flat subagents into a success track with bounded recovery. See [railway-subagents.md](railway-subagents.md).
- `input(name, hint)` / `step(do, { gate, retry })` / `project(role)` — a skill's typed inputs, gated pipeline steps, and portable command gates.

```ts
prose`Check ${file("tsconfig.json")} then run ${cmd("npm test")}.`;
// Returns InstructionFragment[] -- the compiler renders and validates each ref.
```

## Rule Types

Three builders cover three kinds of constraints. The split mirrors a useful mental model for what a rule actually _is_:

- **Process rules** (build commands, env, package managers) — covered by `guard()` (reactive) and runtime hook policies elsewhere.
- **Source rules** (code patterns, style, API conventions) — covered by `enforce()` delegating to ESLint / Ruff / Clippy / etc.
- **Architectural rules** (boundaries, layering, file pairing) — covered by `enforce()` delegating to ast-grep / Dependency Cruiser / Steiger via the same `enforce()` API.
- **Prose-only intent** (anything semantic that can't be checked mechanically) — covered by `guidance()`. Lives in the spec for humans and agents to read; no compile-time verdict.

When you're writing a new rule, ask first which category it falls into. If the answer is "I'm not sure how to mechanically check it," that's a `guidance()` rule. If the answer is "some external tool already does this," that's an `enforce()` rule. If it's "vigiles itself should check this at compile or lint time," that's `enforce("vigiles/<name>", ...)` against the built-in catalog (currently `vigiles/orphan-docs`).

### `enforce(ref, why)`

Declares a rule delegated to an external linter or to a vigiles-internal check. The `ref` accepts template literal types:

- `${BuiltinLinter}/${string}` where BuiltinLinter is `eslint`, `stylelint`, `ruff`, `clippy`, `pylint`, `rubocop`, `cedar`, `detekt`, `ktlint`, `checkstyle`, or `golangci-lint`
- `@${scope}/${rule}` for scoped ESLint plugins (e.g., `@typescript-eslint/no-explicit-any`)
- `vigiles/${string}` for vigiles-internal assertions (e.g., `vigiles/orphan-docs`)

At compile time, vigiles verifies the rule exists and — for external linters — is enabled in the project's config. For Cedar, presence in a `.cedar` file counts as enabled. For `vigiles/<id>`, existence is checked against a built-in catalog and the actual check runs at lint time. Compiles to `**Enforced by:** ` followed by the rule reference in backticks.

```ts
rules: {
  "no-console-log": enforce("eslint/no-console", "Use structured logger."),
  "no-print": enforce("ruff/T201", "Use logging module."),
  "shell-allowlist": enforce("cedar/shell-allowlist", "Only npm test / npm build via shell."),
  "no-orphan-docs": enforce("vigiles/orphan-docs", "Every doc must be referenced."),
}
```

### `guidance(text)`

Declares a prose-only rule with no mechanical enforcement. Guidance rules still participate in the monotonicity proof system: once a rule exists, it can be strengthened ( `guidance` → `enforce` ) but never weakened or removed without an explicit allowlist.

```ts
rules: {
  "prefer-composition": guidance("Prefer composition over inheritance."),
}
```

Compiles to: `**Guidance only** -- <text>`.

### `guard(options, description)`

Declares a reactive rule that runs a command when watched files change. Used to wire spec-driven automation into agent hook engines (Claude Code PostToolUse, etc.) — the spec is the single source of truth for "what file changes trigger which command."

```ts
rules: {
  "recompile-on-spec-change": guard(
    { watch: "*.spec.ts", run: "npx vigiles compile" },
    "Recompile instruction files when any spec changes.",
  ),
  "regen-types-on-config-change": guard(
    {
      watch: ["eslint.config.*", "package.json", "pyproject.toml"],
      run: "npx vigiles generate types",
    },
    "Regenerate types when linter configs or package.json change.",
  ),
}
```

`watch` is a single glob pattern or an array. `run` is a shell command. Compiles to `**Guard:** ` followed by the watch pattern(s) and the command, plus the rationale on the next line.

## Branded Types

`VerifiedPath`, `VerifiedCmd`, and `VerifiedRef` are branded string types (`string & { readonly [__brand]: "..." }`). They distinguish compiler-verified references from raw strings.

- `file()` produces `FileRef` containing `VerifiedPath`
- `cmd()` produces `CmdRef` containing `VerifiedCmd`
- `ref()` produces `SkillRef` containing `VerifiedRef`
- `dir()` produces `DirRef` containing `VerifiedDir`
- `glob()` produces `GlobRef` containing `VerifiedGlob`

The compiler only accepts these branded types in path-sensitive positions. This prevents passing unverified strings where a verified reference is expected -- the TypeScript compiler catches the error at authoring time.

## Configuration

Create `vigiles.config.ts` with `defineConfig()`:

```ts
import { defineConfig } from "vigiles/spec";

export default defineConfig({
  specs: "**/*.spec.ts", // glob pattern for spec discovery (default: "**/*.spec.ts")
  discover: true, // auto-discover linter rules for coverage reporting
  maxRules: 50, // maximum rules per spec file
  maxTokens: 2000, // maximum estimated tokens for compiled output (~4 chars/token)
});
```

| Option      | Type                   | Description                                                                                                                                                                                                      |
| ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specs`     | `string`               | Glob pattern to discover spec files                                                                                                                                                                              |
| `discover`  | `boolean`              | Auto-discover linter rules for coverage reporting                                                                                                                                                                |
| `maxRules`  | `number`               | Compilation fails if a spec exceeds this rule count                                                                                                                                                              |
| `maxTokens` | `number`               | Compilation fails if estimated tokens exceed this limit                                                                                                                                                          |
| `orphans`   | `object`               | Opt-in orphan-docs scan (see below)                                                                                                                                                                              |
| `harness`   | `string` \| `string[]` | The harness(es) this repo targets — `"codex"`, or `["claude-code", "codex"]`. Selects the compile dialect; written by `init`. Omitted → auto-detect. See [CLI: compile](cli.md#compile-files--harness-selection) |

### Orphan-docs configuration

The orphan-docs check flags markdown files that no other markdown references. It is **opt-in**: it runs only when your `.vigilesrc.json` declares an `orphans` block, because "unreferenced" only signals rot in a hand-cross-linked corpus — not in a nav-managed doc site (Docusaurus/MkDocs), where the page graph lives in config. Its `include` defaults to `docs/`; add your own dirs (e.g. an internal `research/` notes tree) explicitly:

```json
{
  "orphans": {
    "include": ["docs/**/*.md", "wiki/**/*.md", "handbook/**/*.md"],
    "exclude": ["docs/legacy/**", "**/draft-*.md"]
  }
}
```

- `include` — glob patterns of `.md` files to scan. Defaults to `["docs/**/*.md"]`. Set to `[]` to opt in but scan nothing.
- `exclude` — glob patterns to skip within the include scope. Same shape as `tsconfig.json#exclude`.

`node_modules/**`, `dist/**`, `.vigiles/**`, and `.git/**` are always excluded.

## Hash Verification

Every compiled file starts with a SHA-256 integrity hash comment:

```
<!-- vigiles:sha256:a1b2c3d4e5f67890 compiled from CLAUDE.md.spec.ts -->
```

The hash covers the full compiled content (excluding the hash line itself), truncated to 16 hex characters.

### `vigiles lint`

Verifies that each compiled file's hash matches its content, reports linter rule coverage gaps, and suggests guidance rules that could be upgraded to `enforce()`. If someone manually edits the markdown, the hash will no longer match, and `vigiles lint` reports the file as modified. This ensures the spec remains the source of truth.
