# Contributing to vigiles

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- For full test coverage, you'll also need these linter CLIs on your PATH:
  - `ruff` and `pylint` (Python)
  - `rubocop` (Ruby)
  - `cargo` with `clippy` (Rust)

## Setup

```bash
git clone https://github.com/zernie/vigiles.git
cd vigiles
npm install
npm run build
```

## Project structure

```
src/
  types.ts          Type definitions (interfaces, type aliases)
  validate.ts       Core validation engine (parsing, config, linter checks)
  action.ts         GitHub Action wrapper (reads env vars, calls validatePaths)
  cli.ts            CLI entry point (arg parsing, output formatting)
  validate.test.ts  Test suite (node:test)
src/schemas/        DEPRECATED mdschema YAML presets (parked; require-structure rule never built — see src/schemas/DEPRECATED.md)
skills/             Shipped consumer skills (test-harness, adopt-spec, strengthen, edit-spec, debug-my-harness, linter-docs)
.claude/skills/     This repo's OWN harness — contributor-only, NOT shipped (auto-loads in-repo): generate-logo, pr-to-lint-rule, enforce-rules-format, audit-feedback-loop, audience-check, code-quality + vendored deep-research, review-docs
dist/               Compiled JavaScript output (git-ignored)
```

## Development workflow

### Build

```bash
npm run build        # Compile TypeScript → dist/
```

### Test

This repo has **twelve** test tiers, not one. `npm test` (build + `vitest run`)
is the vitest suite — the first three rows below — and the rest need a binary, a
container, or money. Which tier a NEW check belongs in is decided by the
`pick-the-test-tier` rule in `CLAUDE.md`; this table is where each one LIVES and
who runs it.

| Tier                   | Lives in                                        | Run it with                                     | Needs                                                                                                                           | In CI                                          |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **unit**               | `src/**/*.test.ts`, `scripts/`, `eslint-rules/` | `npm run test:unit`                             | nothing to start — individual suites gate on a binary (`ruff`, `pylint`, `rubocop`, `claude`, `codex`, `bwrap`) and skip loudly | yes, job `test` runs it via `npm run coverage` |
| **integration**        | `src/**/*.integration.test.ts`                  | `npm run test:integration`                      | a reachable Docker daemon (the R3 disposable-service tier); skips loudly without one                                            | yes, inside `npm run coverage`                 |
| **e2e (vitest)**       | `src/**/*.e2e.test.ts`                          | `npm run test:e2e`                              | real network; the egress half also wants bwrap + slirp4netns + nftables and a privileged container                              | yes, job `e2e` — where it actually routes      |
| **cross-runner**       | `test/runners/*.vitest.mjs`, `*.jest.cjs`       | `npm run test:vitest` / `npm run test:jest`     | a built `dist/` (they load the published matcher entries)                                                                       | yes, but reached as `vitest run` + `npx jest`  |
| **type-level**         | `test/types/`                                   | `npm run test:types`                            | `tsc` only                                                                                                                      | yes, inside `npm run check`                    |
| **harness**            | `examples/harness/**/*.harness.mjs` (14)        | `npm run test:harness`                          | the real `claude` binary — **no API key, no model, no cost**                                                                    | yes, job `harness`, with `--min=14` as a floor |
| **eval**               | `**/*.eval.mjs` (20)                            | `npm run test:eval`                             | a real model — real money                                                                                                       | **no, deliberately**                           |
| **live CLI e2e**       | `test/e2e/run.sh`                               | `npm run test:cli-e2e`                          | the real `claude` binary + the bundled mock Anthropic endpoint                                                                  | 🔴 **nowhere** — see below                     |
| **rule-enforcer gate** | `rule-enforcer/gate.js`                         | `npm run check`                                 | its own `node_modules` (`npm ci --prefix rule-enforcer`, which `check` does)                                                    | yes, inside `npm run check`                    |
| **bench self-checks**  | `bench/corpus/verify*.mjs`                      | `npm run check`                                 | nothing                                                                                                                         | yes, inside `npm run check`                    |
| **bench (paid)**       | `bench/**`                                      | by hand (`bench/run.sh` and friends)            | a real model — real money                                                                                                       | no                                             |
| **dogfood corpus**     | `test/dogfood/<plugin>@<sha>/`                  | consumed by the unit tier, never run on its own | nothing, offline                                                                                                                | yes, through the unit tier                     |

Unit tests live beside their source. Assertions come from `node:assert/strict`
or vitest's `expect`; the optional `vitest` / `jest` matcher adapters
(`vigiles/vitest`, `vigiles/jest`) ship for CONSUMERS and are exercised by the
cross-runner row, not by this repo's own suites.

Every `test:*` script above is checked into the map by
`src/doc-test-script-coverage.test.ts` — add a script without a row here and
that test fails, the same way a CLI verb without a doc home fails
`src/doc-command-coverage.test.ts`.

#### A hook reminds you which tier you landed in

Edit a test-shaped file in a Claude Code session and you will see a one-screen
note naming its tier and pointing back at this table. That is
`.vigiles/hooks/test-tier-nudge.hook.mjs` — this repo's own compiled hook, and
the first one it ships for itself. It never blocks (it is a `react`, whose return
type has no `deny`), and it throttles itself with vigiles' named state: at most
once an hour, and again immediately when the tier changes.

**To silence it**, delete its entry from `.claude/settings.json` — the one whose
command is `vigiles hook-runtime run-program .vigiles/hooks/test-tier-nudge.hook.mjs`
— and don't commit that. `npx vigiles compile .vigiles/hooks/test-tier-nudge.hook.mjs`
puts it back, in place, without touching any other hook. It only speaks in a
session where Claude Code loads this repo's settings; it is not part of CI, and it
is not shipped to users of the plugin.

#### `npm run test:cli-e2e` is run by nothing

It appears in `package.json` and in `docs/skills.md`, and nowhere else: not in
`.github/workflows/ci.yml`, not in `scripts/check.mjs`, and not in that file's
`CI_JOBS_NOT_COVERED` list — so nothing tells you it exists and nothing notices
when it rots. `docs/skills.md` says the skill Stop-hook is "proven end-to-end
against real Claude Code in `test/e2e`"; that proof is currently a claim no gate
re-checks. Run it by hand when you touch the skill runtime or the Stop-hook
path, and read the claim as manual until the script has a home.

### Format

```bash
npm run fmt          # Auto-format with Prettier
npm run fmt:check    # Check formatting (CI uses this)
```

### Type check

```bash
npx tsc --noEmit     # Type-check without emitting
```

### Run locally

```bash
node dist/cli.js audit .     # The zero-config report (build first)
node dist/cli.js lint .      # The deterministic gate CI runs
node dist/cli.js --help      # Every verb and its flags
```

There is no bare `npx vigiles <file>` form — the CLI dispatches on a VERB, and an
unknown one exits 2.

## TypeScript conventions

This project uses **TypeScript strict mode** with these compiler options enabled:

- `strict: true` (includes `strictNullChecks`, `noImplicitAny`, etc.)
- `noUncheckedIndexedAccess: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

### Guidelines

- **Explicit types** on all exported function signatures (parameters and return types).
- **No `any`** — use `unknown` and narrow with type guards when the type is truly unknown.
- Import types with `import type { ... }` when only used in type positions.
- Use `.js` extensions in import paths (required by Node16 module resolution).
- Respect the hexagonal boundary: `src/core/` is the harness-agnostic domain,
  `src/adapters/<harness>/` holds per-harness facts, and core must never import an
  adapter (enforced by `eslint-plugin-boundaries`, not by convention).

## Adding a new validation rule

Every step below names a file that exists; the previous version of this section
pointed at `src/types.ts`, `src/validate.ts` and a `validate()` function, none of
which have existed for a long time (reported in #176).

A rule is a PURE DETECTOR plus registrations. The detector has ONE home and is
reused by both `lint` (the gate) and `audit` (the report), so the two can never
disagree — see the `one-detector-no-drift` rule in `CLAUDE.md`.

1. Write the detector in `src/core/<name>.ts` — pure, IO injected, no `node:fs`
   import, no Claude Code literals (the core is harness-agnostic; read tool and
   event catalogs from the injected dialect). Unit-test it beside itself.
2. Add the rule name to `RulesConfig` in `src/core/types.ts`.
3. Add its default severity to the rule GROUPS in `src/setup-plan.ts`
   (`STRUCTURAL_RULES` / `WORKFLOW_RULES` / `NUDGE_RULES`) — severity tracks
   CONFIDENCE, not importance.
4. Declare it in `src/core/rule-meta.ts` with its decidability bucket, surface and
   detector. `Record<RuleName, RuleMeta>` makes a missing entry a `tsc` error, and
   `src/core/rule-meta.test.ts` binds the registry to `docs/rules/*.md` as an exact
   set match.
5. Call the same detector from `src/scan.ts` and wire the severity in `src/cli.ts`.
6. Write `docs/rules/<name>.md` and add its row to the matrix in
   `docs/verifying-instruction-files.md`.

For a rule that can be wired at `error`, a FALSE POSITIVE is worse than a miss: a
miss costs a detection, a false positive costs the build — and a rule that fails
correct code gets switched off rather than fixed. Err toward silence.

## Adding a new linter

A linter is ONE `LinterAdapter` in the `LINTERS` registry (`src/core/linters.ts`) —
a `Record<BuiltinLinter, LinterAdapter>`, so a missing linter is a `tsc` error and
`src/core/linter-contract.test.ts` catches any docs/site drift. The full
step-by-step lives in the `add-a-linter` contributor skill
(`.claude/skills/add-a-linter/SKILL.md`); in short:

1. Add the lowercase name to `BUILTIN_LINTERS` in `src/core/spec.ts`.
2. Register it in `LINTERS` via `nodeApiAdapter` (Node-API linter) or `cliAdapter`
   (CLI linter), writing its `checkExists` / `configEnabled` / rule-enumerator
   functions inline; `cedar` is a filesystem literal.
3. Add a `docs/linter-support.md` row + section, and (for a CLI linter) install it
   in the CI `test` job so its gated tests run.
4. Add tests covering both existing and nonexistent rules.

## Before you open a pull request

- **A bug fix, or a small docs or test change:** just open the PR.
- **A change to what a rule, a file kind, a command or a config key _means_:**
  comment on the issue (or open one) first, with a line on your approach. It
  saves a rewrite if the maintainer wants it shaped differently.
- **Fix the class, not only the instance.** When a defect could recur elsewhere,
  say what allowed it to be written. A fix that adds one more case to a list will
  usually be asked to be reshaped so the same mistake cannot be written again.
- **Breaking changes are allowed.** They ship as a major version, so say who is
  affected and what the upgrade path is, and mark the commit `feat!:` or with a
  `BREAKING CHANGE:` footer.
- **Credit.** Your commit keeps your authorship. Maintainers build on top of it
  rather than rewrite it, and the PR description names you.

## Pull requests

- Keep PRs focused — one feature or fix per PR.
- Run `npm run check` — ONE command for the whole gate list (build, both
  type-checks, lint, format, the API surface, and the rest), so nobody retypes a
  list that goes stale. It ends by PRINTING the CI jobs it does NOT cover; run
  the ones your change touches (the tier map above says what each needs).
- Update `CLAUDE.md` if you change exported APIs or add new rules.
- Write descriptive commit messages explaining _why_, not just _what_.

## Architecture decisions

- **Hexagonal core**: the domain (`src/core/`) knows nothing about how an agent runs;
  every harness-specific fact sits behind one of five injectable ports. Adding a
  harness is writing one adapter object, not editing the core.
- **Zero config by default**: vigiles works out of the box. Config exists only for overrides.
- **Two rule packs**: `"recommended"` (permissive defaults) and `"strict"` (tighter constraints).
- **Linter auto-detection**: No need to declare which linters you use — vigiles discovers them.
- **Agent auto-discovery**: Detects AI coding tools by their config directories and validates their instruction files exist.
