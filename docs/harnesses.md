# Harnesses — which one vigiles targets, and how to pick

An agent is **Model + Harness**. The _harness_ is the machine around the model: the CLI, the hook protocol, the plugin layout, the instruction-file dialect. vigiles keeps its **core harness-agnostic** — harness-specific pieces live behind a swappable **adapter**.

> ✅ **Supported today: Claude Code and Codex.** `vigiles/codex` is auto-detected by the CLI. It verifies references, compiles Codex-shaped instructions (`AGENTS.md`) and skills (minimal `SKILL.md`), and runs Test-layer harness tests against the real `codex` binary (keyless, OpenAI-Responses mock) via `runHarnessTest({ adapter: codexAdapter })`. Subagents are a deliberate boundary — see the matrix below. Adding a harness never touches the core.

## You pick the harness by which subpath you import

**Select the adapter at author time, by your import** — not by a config setting. Two surfaces:

```ts
// Core — harness-agnostic. The stable API you write tests/evals against.
import { paid_runEval } from "vigiles/eval";
import { runHarnessTest, assertHookBlocked } from "vigiles";

// Adapter — the Claude Code-specific pieces, named explicitly.
import { loadPlugin, scriptModel } from "vigiles/claude-code";
```

The `vigiles` root (plus `vigiles/eval` for the model-calling half) is the part that never changes when the harness changes. It includes `runHarnessTest`, `paid_runEval`, `runHook`, the `Trace` predicates, and all assertions.

`vigiles/claude-code` is the adapter. It reads real Claude Code layouts (`.claude-plugin/plugin.json`, `.claude/settings.json`, `${CLAUDE_PLUGIN_ROOT}`, `skills/`, `agents/`) and provides the scriptable Anthropic Messages mock you point `claude` at.

A second harness sits **beside** the first — same core, a different import. Codex already ships this way:

```ts
import { startCodexMock, codexAdapter } from "vigiles/codex";
```

Nothing in `vigiles` or `vigiles/eval` changes, and unused adapters tree-shake out. Importing the adapter (rather than a `harness:` config key) means the bundle carries only what you use, and the choice is type-checked where you write it.

## The CLI auto-detects (or reads project config)

The CLI detects the harness from the repo automatically — a `.claude-plugin/`, an `AGENTS.md`, etc. — and `vigiles compile`, `vigiles audit`, and `vigiles lint` all work with zero config.

When detection is ambiguous, or you want a committed, deterministic choice, override it two ways:

- **`harnesses` key in `.vigilesrc.json`** — `{ "codex": {} }`, or `{ "claude-code": {}, "codex": {} }` for a multi-harness repo. Each value may declare that harness's own extra surface `roots` (see `docs/cli.md`). Written by `vigiles init`.
- **`--harness=<name>` flag** — wins over the config file.

**Precedence:** `--harness=` → config `harnesses` → auto-detect. A multi-harness or ambiguous match prints a loud notice instead of silently guessing. A repo declaring several harnesses also gets a byte-identical `CLAUDE.md`⇄`AGENTS.md` mirror on compile when no sync tool already fans it out.

## What's actually harness-specific (the two axes)

Not everything labelled "Claude Code" is coupled the same way. There are two independent axes, and a new harness might share one but not the other:

| Axis                    | What it covers                                                                                                                               | Example difference for Codex                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Format / dialect**    | the instruction-file format and plugin layout: `CLAUDE.md` vs `AGENTS.md`, `SKILL.md` frontmatter, the `tools:` contract, `${…_PLUGIN_ROOT}` | emits/verifies `AGENTS.md` instead of `CLAUDE.md` |
| **Runtime / transport** | the binary that runs the model, the hook event protocol, the model mock                                                                      | spawns `codex` with a different hook JSON shape   |

The reference-verification engine — does this linter rule exist and is it enabled, does this path/script/symbol resolve — is **the same across harnesses**. Only the format it reads/writes and the runtime it drives differ.

## Adapter capability matrix

Not every harness can reach every tier. Pretending otherwise produces adapters that hang or no-op. Each adapter declares an `AdapterCapabilities` descriptor (`src/core/adapter.ts`). The conformance kit **requires a transport port only for the capability the adapter claims** — so a reference-only harness is a first-class adapter, not a broken one.

| Capability                                  | Descriptor flag                         | Needs ports             | What it unlocks                                                          |
| ------------------------------------------- | --------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| **Lint** (layer 1) — reference verification | `referenceVerification` (always `true`) | `dialect`, `layout`     | `compile` / `scan` / `lint` — verify refs, tools, paths                  |
| **Test** (layer 2) — harness testing        | `harnessTesting`                        | `runtime` + `modelMock` | `runHarnessTest` / `runEval` (spawn binary, mock model)                  |
| **Shell-hook tier**                         | `shellHooks`                            | `hookProtocol`          | the `runHook` unit tier (hooks as shell processes)                       |
| **Subagents**                               | `subagents`                             | —                       | the subagent lint rules (`subagent-tool-contract`, …); n/a where `false` |

Where the harnesses land (✅ shipped · 🧪 internal prototype · ⛔ **blocked**, with why):

| Harness                    | Lint | Test (mockable)        | Shell hooks              | Status                                                                       |
| -------------------------- | ---- | ---------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| **Claude Code**            | ✅   | ✅ Anthropic SSE       | ✅ exit 2 / decision     | ✅ **shipped** — the reference adapter                                       |
| **Codex**                  | ✅¹  | ✅ Responses SSE       | ✅ veto (exit 2)         | ✅ **shipped** (`vigiles/codex`) — Lint & Test² (subagents differ by design) |
| **OpenCode**               | ✅   | 🚧 openai-compat³      | ⛔ **code-module hooks** | 🧪 prototype (`src/adapters/opencode/`) — `shellHooks:false`                 |
| **Cursor**                 | ✅   | ⛔ **closed, no BYOM** | ⛔                       | not built — Lint-only at best                                                |
| **Devin / Amp / Amazon Q** | ✅   | ⛔ **un-mockable**     | varies                   | not built — Lint-only (closed backend)                                       |

¹ **Codex Lint is format-correct for the surfaces that map.** References are verified against the Codex dialect, and `compile` emits Codex-shaped output — `AGENTS.md` (plain markdown) and minimal `SKILL.md` (`name`/`description` only, driven by `dialect.skillFrontmatterKeys`), with Claude Code output byte-identical (the dogfood integrity hash is the guardrail).

**Subagents are a deliberate boundary, not a gap.** A Codex subagent is an `[agents.<name>]` TOML concurrency table (`max_threads`/`max_depth`), not a tool-contract file. vigiles's `agent()` doesn't map onto it, so it isn't compiled to Codex (it is still _verified_). The loader reads Codex's TOML manifest format-aware, so its `[mcp_servers]` table is detected like CC's JSON `mcpServers`.

² **Codex is shipped**: registered in `ADAPTERS` (the CLI auto-detects a `.codex/config.toml` or `AGENTS.md` repo) and exported as `vigiles/codex`. **Test is full and usable through the public API** — `runHarnessTest(spec, { adapter: codexAdapter })` drives real `codex exec` against the OpenAI Responses mock (`src/adapters/codex/mock-model.ts`), keylessly. A gated `harness-test.test.ts` runs the real-codex turn (request shape + SSE captured from live traffic, not guessed). **Trigger-rate IS usable** through the public API — `paid_measureTriggerRate(spec, { evalDriver: codexEvalDriver })`, with `codexEvalDriver` exported from `vigiles/codex` — but the number is **experimental** (`CODEX_TRIGGER_RATE_EXPERIMENTAL`, printed as a loud caveat on every run): Codex has no skill-selection event, so firing is inferred from a `SKILL.md` read, which is wrong in both directions (a cached skill is not re-read → false negative; an exploratory read is not a fire → false positive). Treat it as directional, not a measurement. **`paid_runEval` still has no public dispatch**: `paid_runEval(spec)` always drives Claude Code, and while the Codex runner (`codexEvalAgentRunner`) is exported, the `runEvalWith(spec, runner)` seam that would take it is not.

³ OpenCode's mockable tier is **declared but not yet built**: it needs the openai-compat (Chat Completions) SSE renderer, and the `opencode` binary isn't wired here yet. The Codex path proves the same work generalizes.

**The key discriminator is Test, not Lint.** Everyone converges on Lint (AGENTS.md is becoming universal). The gate is _mockability_. OpenCode is the case that splits the matrix mid-row: mockable (Test is reachable) but with in-process plugin hooks instead of shell processes (`shellHooks:false`, no `hookProtocol`).

**Full capability inventory.** This matrix is the brief version. The exhaustive record of every harness-specific capability (CC vs Codex) — and, per capability, whether vigiles _verifies_ it, _tests_ it, or **records-only** (acknowledged but deliberately not supported). Testing every special capability is an explicit non-goal.

## How this is kept honest

The core staying harness-agnostic isn't a convention you have to remember — it's enforced. `eslint-plugin-boundaries` classifies modules into `verify-core` (the domain) and `cc-harness` (the Claude Code adapter) and **forbids the core from importing the adapter** (`eslint.config.mjs`, rule `boundaries/dependencies`). The dependency only points one way: adapter → core, never core → adapter.

vigiles also **dogfoods** that rule: `CLAUDE.md.spec.ts` carries `enforce("boundaries/dependencies")`, so `vigiles compile` checks the boundary rule is present and enabled. The architecture invariant is a verified reference, not a comment.

## See also

- [`docs/harness-testing.md`](harness-testing.md) — the harness-agnostic test tiers that ride on `vigiles` / `vigiles/eval`. Per-harness specifics: [`harness-testing-claude-code.md`](harness-testing-claude-code.md) · [`harness-testing-codex.md`](harness-testing-codex.md).
- [`docs/non-js-harnesses.md`](non-js-harnesses.md) — using vigiles on a Kotlin/Go/Java repo with no `package.json` or Node toolchain (which checks work with zero setup, JVM/Go linter cross-referencing).
