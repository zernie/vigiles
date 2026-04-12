# What Changes With vigiles

## Claude Code

|                                     | Without vigiles              | With vigiles                                                   |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| **Instructions**                    | Hand-written CLAUDE.md       | Compiled from `.spec.ts` (build artifact)                      |
| **Linter rule references**          | Trust-based (nobody checks)  | Verified at compile time against real config                   |
| **File paths**                      | Rot silently when renamed    | `file()` references checked against filesystem                 |
| **Commands**                        | Stale scripts go unnoticed   | `cmd()` references checked against package.json                |
| **Direct edits to CLAUDE.md**       | Anyone can, nobody knows     | PreToolUse hook blocks edits, redirects to spec                |
| **Linter config changes**           | CLAUDE.md drifts out of sync | PostToolUse hook auto-regenerates types                        |
| **Spec edits**                      | N/A                          | PostToolUse hook auto-compiles to markdown                     |
| **guidance → enforce upgrades**     | Manual guesswork             | `/strengthen` reads per-linter docs, suggests upgrades         |
| **New lint rules from PR feedback** | Copy-paste from review       | `/pr-to-lint-rule` generates rule + tests + spec entry         |
| **CI**                              | Nothing to verify            | `vigiles audit` catches hash drift, disabled rules, stale refs |

## Codex

|                               | Without vigiles                  | With vigiles                                            |
| ----------------------------- | -------------------------------- | ------------------------------------------------------- |
| **Instructions**              | Hand-written AGENTS.md           | Compiled from `.spec.ts`                                |
| **Linter rule references**    | Trust-based                      | Verified at compile time                                |
| **File paths / commands**     | Rot silently                     | Checked at compile time                                 |
| **Direct edits to AGENTS.md** | Undetected                       | CI catches hash mismatch                                |
| **Hooks / auto-compile**      | Not available (no plugin system) | Not available — run `vigiles compile` manually or in CI |
| **CI**                        | Nothing to verify                | Same `vigiles audit` pipeline as Claude                 |

Codex has no hook or plugin system. The compile-time verification and CI enforcement still work — the difference is there's no auto-recompilation on edit. You run `vigiles compile` before committing, and CI catches drift.

## What's Deterministic vs What's Not

| Check                            | Deterministic? | How                                                                                  |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Linter rule exists in catalog    | Yes            | Node API (`builtinRules`) or CLI (`ruff rule`, `rubocop --show-cops`)                |
| Linter rule is enabled in config | Yes            | `calculateConfigForFile` (ESLint), `--show-settings` (Ruff), `--show-cops` (RuboCop) |
| File path exists                 | Yes            | `fs.existsSync`                                                                      |
| npm script exists                | Yes            | Parsed from `package.json`                                                           |
| SHA-256 hash matches             | Yes            | Recompute and compare                                                                |
| Duplicate rule detection         | Yes            | Normalized Compression Distance (NCD) with fixed threshold                           |
| guidance → enforce suggestion    | **No**         | Agent reads linter docs, reasons about intent — `/strengthen` skill                  |
| PR comment → lint rule           | **No**         | Agent generates custom rule code — `/pr-to-lint-rule` skill                          |
| Spec content authoring           | **No**         | Agent or human writes the spec — vigiles verifies it                                 |

Everything vigiles compiles and audits is deterministic — same input, same output, no LLM in the loop. The non-deterministic parts (authoring specs, suggesting upgrades, writing custom rules) are agent skills that run outside the compilation pipeline.

## Flow

```
                        DETERMINISTIC                          AGENT-ASSISTED
                  ┌─────────────────────────┐          ┌──────────────────────────┐
                  │                         │          │                          │
  .spec.ts ──────┤  vigiles compile         │          │  /strengthen             │
       │         │    ✓ linter rules exist   │          │    guidance → enforce    │
       │         │    ✓ rules enabled        │          │                          │
       │         │    ✓ file paths valid     │          │  /pr-to-lint-rule        │
       │         │    ✓ commands valid       │          │    PR comment → rule     │
       │         │    → CLAUDE.md + hash     │          │                          │
       │         └─────────────────────────┘          │  /edit-spec              │
       │                                               │    agent edits .spec.ts  │
       │         ┌─────────────────────────┐          └──────────────────────────┘
       └────────▶│  vigiles audit           │                     │
                 │    ✓ hash integrity      │                     │
                 │    ✓ inline rule checks  │                     ▼
                 │    ✓ duplicate detection  │          ┌──────────────────────────┐
                 │    ✓ coverage gaps       │          │  hooks (Claude Code)     │
                 └─────────────────────────┘          │    auto-compile on edit  │
                                                       │    auto-regen types      │
                                                       │    block direct md edits │
                                                       └──────────────────────────┘
```
