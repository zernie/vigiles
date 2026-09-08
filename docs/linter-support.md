# Linter Cross-Referencing

> **Scope:** this page is about **`enforce()` cross-reference verification** — checking that a rule
> you NAME actually exists + is enabled (11 linters: ESLint, Ruff, Pylint, Clippy, Stylelint,
> RuboCop, Detekt, Ktlint, Checkstyle, golangci-lint, Cedar). It is **NOT** the prose→rule
> _routing_ map (which auto-maps freeform prose to a rule and supports ESLint + Pylint + Ruff
> route-only). Don't conflate the two — see `research/rule-enforceability.md` for
> routing/synthesis coverage.

vigiles verifies that every `enforce()` rule in your spec actually exists and is enabled in your project. The rule name is resolved against the linter's own catalog rather than matched as a string, and the enabled state is read out of your config -- so a rule that is real but switched off is reported as clearly as one that was never real.

## How It Works

When you write:

```ts
enforce("eslint/no-console", "Use the project logger instead.");
```

vigiles does two things at compile time:

1. **Existence check** -- verifies the rule `no-console` exists in ESLint (via `builtinRules` or plugin resolution).
2. **Config check** -- loads your ESLint flat config, calls `calculateConfigForFile`, and confirms the rule's severity is not `0` / `"off"`.

If either check fails, compilation fails with a clear error:

```
Error: Rule "no-consloe" not found in eslint
Error: Rule "no-console" is disabled in eslint config
```

The reference format is `<linter>/<rule>` -- e.g., `eslint/no-console`, `ruff/F401`, `clippy/needless_return`.

## Supported Linters

| Linter        | Detection      | Existence Check                                          | Config Check                                                                         |
| ------------- | -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ESLint        | `node_modules` | Node API (`builtinRules` + plugin resolution)            | Loads flat config, checks severity > 0                                               |
| Stylelint     | `node_modules` | Node API (`rules` export)                                | Loads config, checks rule value is not `null`                                        |
| Ruff          | `PATH`         | CLI (`ruff rule <name>`)                                 | Parses `ruff check --show-settings` for enabled codes                                |
| Clippy        | `PATH`         | CLI (`cargo clippy --explain <name>`)                    | Parses `Cargo.toml` `[lints.clippy]` section                                         |
| Pylint        | `PATH`         | CLI (`pylint --help-msg=<name>`)                         | Runs `pylint --list-msgs-enabled`                                                    |
| RuboCop       | `PATH`         | CLI (`rubocop --show-cops <name>`)                       | Parses `Enabled: true/false` from output                                             |
| Detekt        | `PATH`         | CLI (`detekt --generate-config` default-catalog parse)   | Parses `detekt.yml` / `detekt-config.yml` / `config/detekt/detekt.yml` for `active:` |
| Ktlint        | `PATH`         | Reference format only (`<ruleset>:<rule-id>`) — see note | Parses `.editorconfig` `ktlint_<ruleset>_<rule-id> = enabled\|disabled` properties   |
| Checkstyle    | `PATH`         | CLI (probe config naming the module — see note)          | Parses `checkstyle.xml` `<module name="...">` whitelist (+ `severity` `ignore`)      |
| golangci-lint | `PATH`         | CLI (`golangci-lint help linters` listing)               | Runs `golangci-lint linters`, splits enabled/disabled-by-your-configuration sections |
| Cedar         | Filesystem     | Scan `.cedar/` and `cedar/` for `@id("...")`             | Presence == enabled (no separate config layer)                                       |

Node-based linters (ESLint, Stylelint) are resolved via `createRequire` from the project's `node_modules`. CLI-based linters (Ruff, Clippy, Pylint, RuboCop, Detekt, Ktlint, Checkstyle, golangci-lint) must be available on `PATH`. Cedar policies are read directly from `.cedar` files — no external tool required.

## JVM and Go Linters

The reference formats are `detekt/MagicNumber`, `ktlint/standard:no-wildcard-imports`, `checkstyle/MagicNumber`, and `golangci-lint/errcheck` (a golangci-lint "rule" is one of its bundled linters — that is golangci-lint's own unit of enablement).

Three of the four have no direct "does rule X exist" query, so vigiles asks the real tool the closest honest question:

- **Detekt** has no per-rule query, but `detekt --generate-config` exports the default config, which names every bundled rule — vigiles generates it once (into a temp dir), parses the rule keys, and checks your reference against that catalog. A rule from a third-party ruleset plugin won't be in the default catalog, so a rule named in your own detekt config is also accepted; if the catalog can't be generated at all, the check fails open rather than flagging every rule.
- **Ktlint** ships no rule catalog CLI at all (its only subcommands are `generateEditorConfig` and the git hooks), so the existence check is format-only: the reference must be a qualified `<ruleset>:<rule-id>`. The config check is real — it reads the `ktlint_<ruleset>_<rule-id> = enabled|disabled` properties (and the ruleset-level `ktlint_<ruleset>` fallback) from `.editorconfig`.
- **Checkstyle** has no module-listing command, so vigiles probes: it runs `checkstyle -c` with a tiny generated config naming your module (first as a `TreeWalker` child, then directly under `Checker` for file-level checks and filters). Only a module-instantiation error means the check doesn't exist; a style violation on the probe file proves it does. A checkstyle config is a whitelist, so for the enabled check a module absent from your `checkstyle.xml` is reported `disabled`.
- **golangci-lint** lists every supported linter via `golangci-lint help linters` (existence) and your effective set via `golangci-lint linters`, which prints `Enabled by your configuration linters:` / `Disabled by your configuration linters:` sections (config check, run in your project so it respects `.golangci.yml`/`.yaml`/`.toml`).

## Cedar Policies

Cedar is the policy language used by AWS Bedrock AgentCore (GA March 2026) and Vectimus to enforce deterministic constraints on agent tool calls at runtime. vigiles treats Cedar as a catalog of named rules the same way it treats ESLint — reference a policy by ID, vigiles verifies it exists in your project.

```ts
"shell-command-allowlist": enforce(
  "cedar/shell-allowlist",
  "Agents may only run npm test or npm build via shell.",
),
```

Default search directories: `.cedar/` and `cedar/` at the project root. Each `.cedar` file may contain one or more policies. Resolution rules:

1. **Annotated policies** (preferred). A policy ID is its `@id("...")` annotation:

   ```
   @id("shell-allowlist")
   permit (
     principal,
     action == Action::"shell_execute",
     resource
   ) when {
     resource.command in ["npm test", "npm run build"]
   };
   ```

2. **Filename fallback.** If a `.cedar` file has no `@id` annotations but contains at least one `permit`/`forbid` statement, the filename (minus `.cedar`) becomes the policy ID. So `.cedar/legacy-rule.cedar` resolves as `cedar/legacy-rule`.

Multiple policies per file are supported via annotations. Override the search path via `linters.cedar.rulesDir` in `vigiles.json`:

```json
{
  "linters": {
    "cedar": { "rulesDir": "policies/agent-core" }
  }
}
```

Cedar has no separate config layer the way ESLint does — a policy that exists in your bundle is, by definition, enabled. `checkLinterRule` returns `enabled: "enabled"` for any policy it finds, and surfaces edit-distance suggestions when you misspell a policy name.

## ESLint Plugin Support

Plugin rules are referenced directly by `<plugin>/<rule>` (no `eslint/` prefix). vigiles resolves the plugin package and checks its exported `rules` object.

**Scoped plugins** (`@scope/plugin`):

```ts
// Resolves @typescript-eslint/eslint-plugin, checks its "no-explicit-any" rule
enforce("@typescript-eslint/no-explicit-any", "Use `unknown` instead.");
```

Resolution order for `@scope/name`:

1. `@scope/eslint-plugin-name`
2. `@scope/eslint-plugin`

For bare scopes like `@typescript-eslint`, it resolves `@typescript-eslint/eslint-plugin`.

**Unscoped plugins**:

```ts
// Resolves eslint-plugin-sonarjs, checks its "cognitive-complexity" rule
enforce("sonarjs/cognitive-complexity", "Keep functions simple.");
```

Resolution: `sonarjs` becomes `eslint-plugin-sonarjs`.

Config-enabled checks for plugin rules go through ESLint's `calculateConfigForFile` with the full qualified name (e.g., `@typescript-eslint/no-explicit-any`), so they respect your flat config.

## Custom Linters

For tools not built in, use the `linters` config option in `vigiles.json` (or `package.json` under `"vigiles"`):

```json
{
  "linters": {
    "my-tool": {
      "rulesDir": "tools/my-tool/rules/"
    }
  }
}
```

vigiles checks if a file matching the rule name exists in the specified directory. For example, `enforce("my-tool/no-foo")` passes if `tools/my-tool/rules/no-foo.*` exists (any extension).

Multiple directories are supported via an array:

```json
{
  "linters": {
    "my-tool": {
      "rulesDir": ["tools/my-tool/rules/", "tools/my-tool/extra-rules/"]
    }
  }
}
```

Custom linters only support existence checks. Config-enabled status is always `"unknown"`.

## generate-types

`vigiles generate types` scans all 11 linter APIs, `package.json`, and project files, then emits `.vigiles/generated.d.ts` with type unions derived from your actual project state.

```sh
npx vigiles generate types
```

This produces a `.d.ts` file like:

```ts
/**
 * Auto-generated by `vigiles generate types`.
 * DO NOT EDIT -- re-run `vigiles generate types` to update.
 */

declare module "vigiles/generated" {
  /** 42 enabled eslint rules (via flat config). */
  export type EslintRule =
    | "no-console"
    | "no-debugger"
    | "@typescript-eslint/no-explicit-any"
    // ...

  /** 5 enabled ruff rules (via CLI). */
  export type RuffRule = "E501" | "F401" | "F841" | "I001" | "UP006";

  /** All enabled linter rules across all detected linters. */
  export type LinterRule = EslintRule | RuffRule;

  /** 8 npm scripts from package.json. */
  export type NpmScript = "build" | "test" | "lint" | "fmt" | "fmt:check" | ...;

  /** 23 project files. */
  export type ProjectFile = "src/cli.ts" | "src/compile.ts" | "src/linters.ts" | ...;
}
```

The TypeScript compiler then proves references are valid at authoring time. A typo like `enforce("eslint/no-consloe")` becomes a type error in your editor before you ever run `vigiles compile`. This shifts rule-reference validation from runtime to authoring time.

Discovery methods per linter:

- **ESLint** -- loads flat config via `calculateConfigForFile`, collects rules with severity > 0 (v9 and v10)
- **Stylelint** -- loads config via `createLinter` + `getConfigForFile`, collects non-null rules
- **Ruff** -- parses `ruff check --show-settings` for `linter.rules.enabled`
- **Pylint** -- parses `pylint --list-msgs-enabled`, extracts both IDs (`C0114`) and symbolic names
- **RuboCop** -- parses `rubocop --show-cops` output for cop names
- **Clippy** -- reads `Cargo.toml` `[lints.clippy]` section, excludes rules set to `"allow"`
- **Detekt** -- reads your detekt YAML config (`detekt.yml` / `detekt-config.yml` / `config/detekt/detekt.yml`), collects rule keys not set to `active: false`
- **Ktlint** -- reads `.editorconfig`, collects `ktlint_<ruleset>_<rule-id> = enabled` properties as `<ruleset>:<rule-id>`
- **Checkstyle** -- reads your checkstyle XML config, collects `<module name="...">` names (the config is the whitelist of enabled checks)
- **golangci-lint** -- parses the `Enabled by your configuration linters:` section of `golangci-lint linters`
- **Cedar** -- scans `.cedar/` and `cedar/` for files containing `@id("...")` annotations, with filename fallback for unannotated policies

Project files default to `src/**/*` but can be configured via `fileGlobs`.

## generate-schema

`vigiles generate types` gives authoring-time feedback to `.spec.ts` authors via the TypeScript compiler. For projects using markdown frontmatter instead of a typed spec, `vigiles generate schema` provides the same feedback without TypeScript:

```sh
npx vigiles generate schema
```

It runs the same rule discovery and emits `.vigiles/schema.json` — a JSON Schema whose `rule` field is an `enum` of every enabled rule. Point your markdown frontmatter at it with a modeline and your editor's built-in YAML language server autocompletes rule names and red-squiggles typos:

```yaml
---
# yaml-language-server: $schema=./.vigiles/schema.json
vigiles:
  enforce:
    - rule: eslint/no-consolee # red squiggle: not in the enum
      why: "..."
---
```

When no linter rules are discoverable, the `rule` field falls back to a freeform string so the schema never false-flags a valid reference. CI freshness check: `npx vigiles generate schema --check`. See [markdown mode](markdown-mode.md).

## Catalog-Only Mode

Set `catalogOnly: true` to skip config-enabled checks and only verify that rules exist in the linter's catalog:

```json
{
  "catalogOnly": true
}
```

In this mode, `checkLinterRule` returns `"unknown"` for the `enabled` field instead of loading linter configs. This is useful when:

- Full config loading is slow in CI (ESLint/Stylelint config resolution can take seconds)
- You only care that referenced rules are real, not that they are currently turned on
- The linter config is not available in the build environment

The option can be set in `vigiles.json`, `package.json` under `"vigiles"`, or via the `INPUT_CATALOG_ONLY` environment variable in the GitHub Action.
