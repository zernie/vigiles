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
export * from "./adapters/claude-code/plugin-loader.js";
export * from "./mock-model.js";
// The Claude-Code harness-test transport — the default driver + its argv/parse
// helpers + the `claude` capability probe. Agnostic users never need these
// (`runHarnessTest` defaults to the CC driver), but they're exposed here — beside
// the Codex driver in `vigiles/codex` — for CC-specific tests/tooling. They are
// deliberately NOT on the agnostic `vigiles` surface.
export {
  claudeCodeDriver,
  buildClaudeArgs,
  parseClaudeRun,
  claudeAvailable,
} from "./harness-test.js";
export * from "./adapters/claude-code/dialect.js";
// The typed Claude Code authoring surface: `experimental_agent` / `experimental_skill` with
// the `purity` floor enforced AT COMPILE TIME against the CC tool catalog (a
// `tsc` error for e.g. `purity: "pure"` + `"Bash"`). A strict addition to the
// runtime/compile purity checks; the bare core `experimental_agent()`/`experimental_skill()`
// (`vigiles/spec`) stay open.
//
// NOTE the collision this rename also resolves: `vigiles/testing` exports a
// `skill()` too, and it is a DIFFERENT function — a `Check<Trace>` asking "did
// this skill fire?", taking an id string. One word, two concepts, told apart
// only by which door you imported from. Only the authoring builder is prefixed.
export {
  experimental_agent,
  experimental_skill,
  type ClaudeCodeToolVocabulary,
} from "./adapters/claude-code/typed-spec.js";
// ─── ОКНО АЛИАСА (один мажор) ──────────────────────────────────────────────────
// Та же политика, что в `core/spec.ts`: старое имя живёт ровно один мажор. Эта
// дверь обязана иметь окно ОТДЕЛЬНО — потребитель, импортировавший `agent` из
// `vigiles/claude-code`, никогда не видел `vigiles/spec`, и окно на той стороне
// его не спасает.
export {
  /**
   * @deprecated Renamed to `experimental_agent` — the shape is not settled.
   * Removed one major AFTER the one that introduces it.
   */
  experimental_agent as agent,
} from "./adapters/claude-code/typed-spec.js";
// Selection-collision — a Claude-Code-ONLY behavioral measurement (Codex has no
// skill-selection event to read), so it lives on this surface, not the agnostic
// `vigiles`. `measureSelectionMatrix` builds the N×N "which skill fired?"
// matrix (diagonal = recall, off-diagonal = collision); `assertNoCollision` gates it.
export {
  measureSelectionMatrix,
  assertNoCollision,
  formatSelectionReport,
} from "./scan-behavioral.js";
export type {
  SelectionReport,
  SkillSelectionStat,
  SelectionOptions,
  SelectionMatrixOptions,
} from "./scan-behavioral.js";
export * from "./adapters/claude-code/layout.js";
export * from "./adapters/claude-code/runtime.js";
export * from "./adapters/claude-code/hook-protocol.js";
export * from "./adapters/claude-code/model-mock.js";
export * from "./adapters/claude-code/adapter.js";
