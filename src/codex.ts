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
 * Responses SSE that real `codex exec` completes a turn against, keylessly. Pillar 1 instruction/skill
 * *renderers* still emit the Claude-Code shape until the format-axis renderers
 * land (see `research/code-adapter-architecture.md`).
 */
// The adapter object is the door: its ports (`codexAdapter.layout`,
// `.dialect`, `.runtime`, `.hookProtocol`, `.modelMock`,
// `.harnessTestDriver()`) are reached through it, not exported one by one.
export { codexAdapter } from "./adapters/codex/adapter.js";
export { parseCodexRun } from "./adapters/codex/driver.js";
export {
  startCodexMock,
  type CodexTurn,
  type CodexRequest,
  type CodexMockHandle,
} from "./adapters/codex/mock-model.js";
// The Codex eval driver, passed as `{ evalDriver: codexEvalDriver }` to the
// `paid_*` runners until drivers move onto the adapter object.
export { codexEvalDriver, codexLiveDriver } from "./adapters/codex/eval.js";
