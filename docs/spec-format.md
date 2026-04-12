# Spec Format Reference

vigiles specs are TypeScript files (`*.spec.ts`) that compile to markdown instruction files. The spec is the source of truth; the markdown is a build artifact.

## CLAUDE.md Specs

Use `claude()` to define a CLAUDE.md spec. Export it as the default export.

```ts
import { claude, enforce, guidance, file, cmd, ref, instructions } from "vigiles";

export default claude({
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

`Record<string, string | InstructionFragment[]>` -- Named prose sections. Each key becomes a `## Heading` in the compiled output (first letter uppercased). Values are either plain strings or tagged templates via `instructions` with embedded `file()`, `cmd()`, and `ref()` references.

```ts
sections: {
  architecture: `Two rule types: enforce() and guidance().`,
  setup: instructions`See ${file("docs/setup.md")} and run ${cmd("npm install")}.`,
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

`Record<string, Rule>` -- Rule ID mapped to an `enforce()` or `guidance()` rule. The ID is kebab-cased by convention and is converted to a Title Case `### Heading` in compiled output. See [Rule Types](#rule-types) below.

## SKILL.md Specs

Use `skill()` to define a SKILL.md spec. Compiles to markdown with YAML frontmatter.

```ts
import { skill, file, cmd, ref, instructions } from "vigiles";

export default skill({
  name: "pr-to-lint-rule",
  description: "Convert PR feedback into an automated lint rule",
  argumentHint: "<description of recurring PR feedback>",
  disableModelInvocation: true,
  body: instructions`
    Check ${file("eslint.config.ts")} for existing rules.
    Run ${cmd("npm test")} to verify.
    See ${ref("skills/other/SKILL.md")} for format.
  `,
});
```

| Field                    | Type                              | Required | Description                                         |
| ------------------------ | --------------------------------- | -------- | --------------------------------------------------- |
| `name`                   | `string`                          | yes      | Skill name (used in YAML frontmatter)               |
| `description`            | `string`                          | yes      | Short description (frontmatter)                     |
| `argumentHint`           | `string`                          | no       | Hint for the argument (frontmatter)                 |
| `disableModelInvocation` | `boolean`                         | no       | Disable model invocation flag (frontmatter)         |
| `body`                   | `string \| InstructionFragment[]` | yes      | Instruction body -- plain string or tagged template |

## Reference Helpers

Reference helpers create branded types that the compiler validates at compile time.

### `file(path)`

Returns a `FileRef` containing a `VerifiedPath`. The path is verified to exist via `existsSync` at compile time. Compiles to a backtick path in markdown: `` `path/to/file.ts` ``.

### `cmd(command)`

Returns a `CmdRef` containing a `VerifiedCmd`. For npm commands, the script is verified against `package.json` at compile time. Compiles to a backtick command: `` `npm run build` ``.

### `ref(path)`

Returns a `SkillRef` containing a `VerifiedRef`. The path is verified to exist at compile time. Compiles to a markdown link: `[dirname](path)`.

### `instructions`

Tagged template literal that interleaves strings and refs. Use it for `sections` values in `claude()` or the `body` of `skill()`.

```ts
instructions`Check ${file("tsconfig.json")} then run ${cmd("npm test")}.`;
// Returns InstructionFragment[] -- the compiler renders and validates each ref.
```

## Rule Types

### `enforce(linterRule, why)`

Declares a rule delegated to an external linter. The `linterRule` accepts template literal types:

- `${BuiltinLinter}/${string}` where BuiltinLinter is `eslint`, `stylelint`, `ruff`, `clippy`, `pylint`, or `rubocop`
- `@${scope}/${rule}` for scoped ESLint plugins (e.g., `@typescript-eslint/no-explicit-any`)

At compile time, vigiles verifies the rule exists in the linter's catalog and is enabled in the project's config. Compiles to `**Enforced by:** ` followed by the linter rule in backticks.

```ts
rules: {
  "no-console-log": enforce("eslint/no-console", "Use structured logger."),
  "no-print": enforce("ruff/T201", "Use logging module."),
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

## Branded Types

`VerifiedPath`, `VerifiedCmd`, and `VerifiedRef` are branded string types (`string & { readonly [__brand]: "..." }`). They distinguish compiler-verified references from raw strings.

- `file()` produces `FileRef` containing `VerifiedPath`
- `cmd()` produces `CmdRef` containing `VerifiedCmd`
- `ref()` produces `SkillRef` containing `VerifiedRef`

The compiler only accepts these branded types in path-sensitive positions. This prevents passing unverified strings where a verified reference is expected -- the TypeScript compiler catches the error at authoring time.

## Configuration

Create `vigiles.config.ts` with `defineConfig()`:

```ts
import { defineConfig } from "vigiles";

export default defineConfig({
  specs: "**/*.spec.ts", // glob pattern for spec discovery (default: "**/*.spec.ts")
  discover: true, // auto-discover linter rules for coverage reporting
  maxRules: 50, // maximum rules per spec file
  maxTokens: 2000, // maximum estimated tokens for compiled output (~4 chars/token)
});
```

| Option      | Type      | Description                                             |
| ----------- | --------- | ------------------------------------------------------- |
| `specs`     | `string`  | Glob pattern to discover spec files                     |
| `discover`  | `boolean` | Auto-discover linter rules for coverage reporting       |
| `maxRules`  | `number`  | Compilation fails if a spec exceeds this rule count     |
| `maxTokens` | `number`  | Compilation fails if estimated tokens exceed this limit |

## Hash Verification

Every compiled file starts with a SHA-256 integrity hash comment:

```
<!-- vigiles:sha256:a1b2c3d4e5f67890 compiled from CLAUDE.md.spec.ts -->
```

The hash covers the full compiled content (excluding the hash line itself), truncated to 16 hex characters.

### `vigiles audit`

Verifies that each compiled file's hash matches its content, reports linter rule coverage gaps, and suggests guidance rules that could be upgraded to `enforce()`. If someone manually edits the markdown, the hash will no longer match, and `vigiles audit` reports the file as modified. This ensures the spec remains the source of truth.
