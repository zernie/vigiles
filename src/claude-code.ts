// 🔴 PUBLIC ENTRY POINT `vigiles/claude-code` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-claude-code.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/claude-code` — the Claude Code-specific harness pieces a *different*
 * harness would swap out: the plugin/repo loader (reads real Claude Code plugin
 * layouts) and the scriptable Anthropic Messages mock. Split from
 * the `vigiles` root on purpose — the test API above is the stable surface; this
 * is the adapter, so a future `vigiles/<other-harness>` can sit beside it.
 */
// The adapter object is the door: its ports (`claudeCodeAdapter.layout`,
// `.dialect`, `.runtime`, `.hookProtocol`, `.modelMock`,
// `.harnessTestDriver()`) and Claude Code's tool catalog
// (`.builtinAgentTools`, `.sideEffectingTools`) are reached through it.
export { claudeCodeAdapter } from "./adapters/claude-code/adapter.js";
export {
  loadPlugin,
  type LoadedPlugin,
} from "./adapters/claude-code/plugin-loader.js";
export {
  scriptModel,
  startMock,
  type TurnInfo,
  type MockHandle,
} from "./mock-model.js";
// Claude Code's stream-json, parsed: the tool calls of a `transcript: true`
// run, and a real-model run's whole result.
export { parseToolCalls, claudeAvailable } from "./harness-test.js";
export { parseClaudeRun } from "./eval.js";
// Both spellings (relative and absolute `file_path`) of a Claude Code file-tool
// hook event, to feed `runHook` — the absolute one is what Claude Code sends.
export { fileToolEvents, type FileToolEventOptions } from "./run-hook.js";
// The tool catalog as TYPES (the values are adapter fields).
export type {
  ClaudeCodeBuiltinTool,
  ClaudeCodeSideEffectingTool,
  ClaudeCodeReadOnlyTool,
  ClaudeCodeBoundedTool,
} from "./adapters/claude-code/dialect.js";
// The typed builders: the same `experimental_agent` / `experimental_skill` as
// `vigiles/spec`, plus a `purity` check against Claude Code's tool catalog.
export {
  experimental_agent,
  experimental_skill,
  type ClaudeCodeToolVocabulary,
} from "./adapters/claude-code/typed-spec.js";
// The skill-selection matrix: which of your skills a real model picks.
export {
  measureSelectionMatrix,
  assertNoCollision,
} from "./scan-behavioral.js";
export type {
  SelectionReport,
  SkillSelectionStat,
  SelectionOptions,
  SelectionMatrixOptions,
} from "./scan-behavioral.js";
