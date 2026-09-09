# What Changes With vigiles

## Claude Code

|                                        | Without vigiles              | With vigiles                                                                             |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| **Instructions**                       | Hand-written CLAUDE.md       | Compiled from `.spec.ts` (build artifact)                                                |
| **Linter rule references**             | Trust-based (nobody checks)  | Verified at compile time against real config                                             |
| **File paths**                         | Rot silently when renamed    | `file()` references checked against filesystem                                           |
| **Commands**                           | Stale scripts go unnoticed   | `cmd()` references checked against package.json                                          |
| **Direct edits to CLAUDE.md**          | Anyone can, nobody knows     | PreToolUse hook blocks edits, redirects to spec                                          |
| **Linter config changes**              | CLAUDE.md drifts out of sync | PostToolUse hook auto-regenerates types                                                  |
| **Spec edits**                         | N/A                          | PostToolUse hook auto-compiles to markdown                                               |
| **guidance → enforce upgrades**        | Manual guesswork             | `/strengthen` reads per-linter docs, suggests upgrades                                   |
| **New lint rules from PR feedback**    | Copy-paste from review       | The `pr-to-lint-rule` skill generates the rule + tests via `@vigiles/rule-enforcer`      |
| **Does a skill/plugin actually help?** | Unknown — stars + vibes      | A/B measured on real tasks: bill + correctness ([measuring-skills](measuring-skills.md)) |
| **CI**                                 | Nothing to verify            | `vigiles lint` catches hash drift, disabled rules, stale refs                            |

## Codex

|                               | Without vigiles                         | With vigiles                           |
| ----------------------------- | --------------------------------------- | -------------------------------------- |
| **Instructions**              | Hand-written AGENTS.md                  | Compiled from `.spec.ts`               |
| **Linter rule references**    | Trust-based                             | Verified at compile time               |
| **File paths / commands**     | Rot silently                            | Checked at compile time                |
| **Direct edits to AGENTS.md** | Undetected                              | CI catches hash mismatch               |
| **Hooks**                     | Hand-written `[hooks]` in `config.toml` | Compiled to that same native TOML      |
| **CI**                        | Nothing to verify                       | Same `vigiles lint` pipeline as Claude |

Codex reads hooks from `[hooks]` in `config.toml`, and vigiles compiles to that native format — `src/adapters/codex/codex.test.ts` asserts such a block loads with `${PLUGIN_ROOT}` expanded. What is _not_ claimed here is auto-recompilation on edit: run `vigiles compile` before committing, and CI catches drift. (This row read "Codex has no hook or plugin system" until 2026-09-09, contradicted by this repo's own adapter, which declares `shellHooks: true`.)

## What's Deterministic vs What's Not

**Everything vigiles compiles and lints is deterministic** — same input, same output, no LLM in the loop. The non-deterministic parts (authoring specs, suggesting upgrades, writing custom rules) are agent skills that run outside the compilation pipeline.

| Check                            | Deterministic? | How                                                                                  |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Linter rule exists               | ✅ Yes         | Node API (`builtinRules`) or CLI (`ruff rule`, `rubocop --show-cops`)                |
| Linter rule is enabled in config | ✅ Yes         | `calculateConfigForFile` (ESLint), `--show-settings` (Ruff), `--show-cops` (RuboCop) |
| Cedar policy exists              | ✅ Yes         | Scan `.cedar/` and `cedar/` for `@id("...")` annotations, with filename fallback     |
| File path exists                 | ✅ Yes         | `fs.existsSync`                                                                      |
| npm script exists                | ✅ Yes         | Parsed from `package.json`                                                           |
| SHA-256 hash matches             | ✅ Yes         | Recompute and compare                                                                |
| Duplicate rule detection         | ✅ Yes         | Normalized Compression Distance (NCD) with fixed threshold                           |
| Orphan docs detection            | ✅ Yes         | Scan configured doc directories for `.md` files no other markdown references         |
| guidance → enforce suggestion    | ❌ No          | Agent reads linter docs, reasons about intent — `/strengthen` skill                  |
| PR comment → lint rule           | ❌ No          | `pr-to-lint-rule` drives `@vigiles/rule-enforcer` behind its blind-gold trust gate   |
| Spec content authoring           | ❌ No          | Agent or human writes the spec — vigiles verifies it                                 |

## What vigiles Does and Doesn't Validate in Markdown

vigiles validates vigiles-specific things in `.md` files: `<!-- vigiles:enforce ... -->` comments (inline mode) and `vigiles:` YAML frontmatter rules (frontmatter mode) — both on by default. It can also validate `enforce("...")` / `file("...")` / `cmd("...")` / `ref("...")` calls inside fenced TS/JS code blocks, but that one is **opt-in** (`doc-refs`, default off — see below). Same engines used for `.spec.ts` references.

Out of scope — use other tools:

| Concern                              | Use instead                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Markdown formatting / structure      | [markdownlint](https://github.com/DavidAnson/markdownlint)                      |
| TS / JS syntax in code blocks        | [eslint-plugin-markdown](https://github.com/eslint/eslint-plugin-markdown)      |
| TS type-checking of code blocks      | [twoslash](https://shikijs.github.io/twoslash/) (TS official docs, Astro, etc.) |
| Markdown link validity (URLs, paths) | [markdown-link-check](https://github.com/tcort/markdown-link-check)             |
| Spell / prose / grammar              | [Vale](https://vale.sh/), [alex](https://github.com/get-alex/alex)              |

**Opt-in as of 2026-08-19 (`doc-refs`, default off).** Measured across two real repositories —
2 582 markdown files, 52 builder refs — this pass produced **0 true positives**, and every error it
had ever raised was false: design prose sketching an API that doesn't exist yet, and a third-party
`CLAUDE.md` vendored as benchmark data. The cause is structural, not a threshold: a fenced block in
prose is a _drawing_ of config, and the pass read it as config. Turn it on with
`{"rules": {"doc-refs": "error"}}` where markdown genuinely is the source. Full measurement and the
known gap: [docs/rules/doc-refs.md](rules/doc-refs.md).

**What counts as a ref (2026-08-19).** Blocks are PARSED, not pattern-matched. A ref is a call
whose callee is a bare `enforce` / `file` / `cmd` / `ref` identifier with a string-literal first
argument. That means a method call on some other object (`ctx.file("OUT")`), a mention inside a
comment (`// cmd("npm test")`), and a string containing one (`'cmd("x")'`) are all NOT refs — none
of them is a call expression to the builder. Until this release those three were matched by a
regex and reported as broken refs; `\b` sits happily after a `.`, and a regex has no notion of a
comment or a string literal. Parsing makes all three inexpressible rather than individually
excused.

**Scope (when enabled).** The pass reads `**/*.md` from the repo root and honours the top-level `exclude` in
`.vigilesrc.json`, so vendored or benchmark markdown (a third-party `CLAUDE.md` captured verbatim
as test data) can be kept out of it. Before 2026-08-19 `exclude` was not applied here at all, which
meant a repository vendoring other people's markdown had no way to reach a clean `lint` — and a
lint that cannot exit 0 gets its exit code discarded, at which point it gates nothing.

Illustrative code blocks (typo demos, template placeholders, speculative refs in design docs) opt out via `<!-- vigiles:ignore -->` immediately before the fence, or `<!-- vigiles:ignore-file -->` anywhere in a file that's entirely illustrative. Placeholders containing `<` or `>` are auto-skipped. Refs that can't be verified because the underlying tool isn't installed (e.g. `pylint/X` on a machine without pylint) are reported separately from real errors.

## What vigiles composes with

vigiles owns one thing: compile-time verification of typed specs against real
linter configs, filesystems, and `package.json`, plus testing the harness those
specs describe. Everything else, compose:

- **Architectural linting** — [ast-grep](https://ast-grep.github.io/), [Dependency Cruiser](https://github.com/sverweij/dependency-cruiser), [Steiger](https://github.com/feature-sliced/steiger). Reference their rules via `enforce()`.
- **File sync across agents** — [Ruler](https://github.com/intellectronica/ruler), [rulesync](https://github.com/dyoshikawa/rulesync), [block/ai-rules](https://github.com/block/ai-rules). vigiles compiles the source; sync tools distribute. For non-markdown formats (`.cursorrules`, Copilot), [rule-porter](https://github.com/nichochar/rule-porter) or rulesync convert the compiled output.
- **Markdown linting** — [markdownlint](https://github.com/DavidAnson/markdownlint). vigiles generates markdown; structure is correct by construction.
- **Code-block linting in docs** — [eslint-plugin-markdown](https://github.com/eslint/eslint-plugin-markdown) for syntax, [twoslash](https://shikijs.github.io/twoslash/) for TS type-checking.
- **Prose quality** — [Vale](https://vale.sh). Different concern.
- **Runtime LLM rule checking** — opposite paradigm: those tools send your code to a model on every check (tokens, non-reproducible verdicts); vigiles compiles once and checks deterministically forever after with `eslint`, `ruff`, `tsc`, Cedar evaluation.

Specs compile to `CLAUDE.md` by default; set `target: "AGENTS.md"` or
`target: ["CLAUDE.md", "AGENTS.md"]` for multiple outputs from one spec. See the
[spec format reference](spec-format.md).

## Flow

```
                        DETERMINISTIC                          AGENT-ASSISTED
                  ┌─────────────────────────┐          ┌──────────────────────────┐
                  │                         │          │                          │
  .spec.ts ──────┤  vigiles compile         │          │  /strengthen             │
       │         │    ✓ linter rules exist   │          │    guidance → enforce    │
       │         │    ✓ rules enabled        │          │                          │
       │         │    ✓ file paths valid     │          │  /pr-to-lint-rule        │
       │         │    ✓ commands valid       │          │    rule synthesis skill  │
       │         │    → CLAUDE.md + hash     │          │                          │
       │         └─────────────────────────┘          │  /edit-spec              │
       │                                               │    agent edits .spec.ts  │
       │         ┌─────────────────────────┐          └──────────────────────────┘
       └────────▶│  vigiles lint           │                     │
                 │    ✓ hash integrity      │                     │
                 │    ✓ inline rule checks  │                     ▼
                 │    ✓ duplicate detection │          ┌──────────────────────────┐
                 │    ✓ orphan docs check   │          │  hooks (Claude Code)     │
                 │    ✓ coverage gaps       │          │    auto-compile on edit  │
                 └─────────────────────────┘          │    auto-regen types      │
                                                       │    block direct md edits │
                                                       └──────────────────────────┘
```
