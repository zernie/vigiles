# API by entry

vigiles ships one npm package with several **entries** (the `exports` of `package.json`). Each entry serves one audience, and each public name lives in exactly one entry, so you can pick the page by what you are doing and every name on it is imported from the path in the first column.

Entries named `vigiles/...` that are not stable are marked in [STABILITY.md](../../STABILITY.md). Names that start with `experimental_` can change in any release.

For signatures and option types, see the generated [API reference](https://zernie.github.io/vigiles/api/). These pages say what each name is for and show the typical calls.

| Entry                            | Who it is for                                                                | Page                                             |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `vigiles`                        | anyone testing a harness: run a hook, script or agent, assert with `check`   | [vigiles.md](vigiles.md)                         |
| `vigiles/eval`                   | measuring on a real model: A/B runs, skill trigger rates, reading the report | [eval.md](eval.md)                               |
| `vigiles/spec`                   | authors of a `.spec.ts` instruction-file spec                                | [spec.md](spec.md)                               |
| `vigiles/hook`                   | authors of a compiled hook                                                   | [hook.md](hook.md)                               |
| `vigiles/hook/testing`           | proving a guard blocks, and testing a compiled hook in process               | [hook-testing.md](hook-testing.md)               |
| `vigiles/fixtures`               | what a test runs against: tool stubs on PATH, disposable services            | [fixtures.md](fixtures.md)                       |
| `vigiles/harness/claude-code`    | tests that drive or read Claude Code specifically                            | [harness-claude-code.md](harness-claude-code.md) |
| `vigiles/harness/codex`          | tests that drive or read Codex specifically                                  | [harness-codex.md](harness-codex.md)             |
| `vigiles/harness/kit`            | authors of a new harness adapter                                             | [harness-kit.md](harness-kit.md)                 |
| `vigiles/rule-proof`             | proving a linter rule actually fires on a planted pair                       | [rule-proof.md](rule-proof.md)                   |
| `vigiles/vitest`, `vigiles/jest` | registering the vigiles matchers in vitest or jest (no names exported)       | [matchers.md](matchers.md)                       |

## Which entry do I import from?

- **"Does my hook block?"** `vigiles` (`runHook`, `check`, `assertChecks`).
- **"Does my skill fire, does my change help?"** declare it with `defineEval` from `vigiles`, run it with `npx vigiles eval`, or call the runners from `vigiles/eval`.
- **"I write the spec for my CLAUDE.md."** `vigiles/spec`.
- **"I write a hook that must not be wrong."** `vigiles/hook`, and test it with `vigiles/hook/testing`.
- **"I am teaching vigiles a new harness."** `vigiles/harness/kit`.
