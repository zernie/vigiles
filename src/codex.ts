// 🔴 PUBLIC ENTRY POINT `vigiles/codex` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-codex.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/codex` — the OpenAI Codex harness adapter. Sits beside
 * `vigiles/claude-code`: same harness-agnostic `vigiles` testing core, a
 * different transport (the `codex` binary + the OpenAI **Responses** SSE mock).
 *
 * Pillar 2 (harness testing) is proven here — `startCodexMock` serves the
 * Responses SSE that real `codex exec` completes a turn against, keylessly (see
 * `codexMockArgs`/`codexMockEnv` for the wiring). Pillar 1 instruction/skill
 * *renderers* still emit the Claude-Code shape until the format-axis renderers
 * land (see `research/code-adapter-architecture.md`).
 */
export * from "./adapters/codex/dialect.js";
export * from "./adapters/codex/layout.js";
export * from "./adapters/codex/runtime.js";
export * from "./adapters/codex/hook-protocol.js";
export * from "./adapters/codex/model-mock.js";
export * from "./adapters/codex/mock-model.js";
export * from "./adapters/codex/driver.js";
export * from "./adapters/codex/adapter.js";
// Eval-tier transport (increment 2 — scaffold, pending live-binary validation):
// parseCodexEvalRun (the ModelOutputParser for `codex exec --json`) + codexEvalRunner.
export * from "./adapters/codex/eval.js";
