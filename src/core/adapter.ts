/**
 * HarnessAdapter — the bundle that makes a harness a single, addable unit.
 *
 * Each port (HarnessDialect, PluginLayout, HarnessRuntime, HookProtocol,
 * ModelMock) decouples one axis of Claude-Code coupling. A `HarnessAdapter`
 * groups a harness's five port implementations plus a `detect` predicate, so
 * **adding a harness is writing one object** — `codexAdapter`, `geminiAdapter`,
 * `myHarnessAdapter` — not editing the core. The library stays import-named
 * (`import { claudeCodeAdapter } from "vigiles/claude-code"`); the bundle is the
 * thing the CLI auto-detects and the conformance kit checks.
 *
 * See `docs/authoring-an-adapter.md` (third-party guide) and
 * `research/code-adapter-architecture.md` (the design).
 */
import type { HarnessDialect } from "./dialect.js";
import type { PluginLayout } from "./layout.js";
import type { HarnessRuntime } from "./runtime.js";
import type { HookProtocol } from "./hook-protocol.js";
import type { ModelMock } from "./model-mock.js";
import type { HarnessTestDriver } from "./harness-driver.js";

/**
 * Which vigiles pillars/tiers a harness can drive — the capability matrix made
 * executable (see `docs/harnesses.md`). Not every harness reaches every tier:
 * a closed, un-mockable one (Cursor, Devin, Amp, Amazon Q) can only ever do
 * pillar 1, and a harness whose hooks are in-process code modules (OpenCode)
 * has no shell-hook tier. Declaring this lets the conformance kit relax the
 * port requirements for what an adapter says it can't do (instead of forcing a
 * fake `runtime`/`modelMock`/`hookProtocol`), and lets the pillar-2 runners
 * refuse — rather than mysteriously hang on — an adapter that can't be mocked.
 */
export interface AdapterCapabilities {
  /**
   * Pillar 1 — reference verification (dialect + layout). Always `true`: every
   * harness with an instruction-file format can have its references verified.
   */
  readonly referenceVerification: true;
  /**
   * Pillar 2 — deterministic harness tests + evals: the binary can be spawned
   * and pointed at a mock model. Requires `runtime` + `modelMock`. `false` for
   * closed harnesses that route through a fixed backend (no BYOM): Cursor,
   * Devin, Amp, Amazon Q — they are pillar-1-only adapters.
   */
  readonly harnessTesting: boolean;
  /**
   * Hooks are shell processes speaking the exit-code/env block protocol —
   * Claude Code, Codex, Crush. Requires `hookProtocol`. `false` when hooks are
   * in-process code modules (OpenCode's TS plugins), so the `run-hook` unit
   * tier and the `HookProtocol` port do not apply.
   */
  readonly shellHooks: boolean;
  /**
   * The harness has **subagents** — a named, model-dispatched delegate with its
   * own tool contract and frontmatter (Claude Code's `agents/*.md`, OpenCode's
   * agent surface). Gates the subagent-surface lint rules (`subagent-tool-contract`,
   * `subagent-frontmatter`, `untested-subagent`, `mcp-tool-resolves`): where this
   * is `false` those rules report **n/a** rather than running. `false` for Codex,
   * whose `[agents]` TOML is a concurrency table, not a tool-contract file — a
   * wholly different concept that deliberately shares the word.
   */
  readonly subagents: boolean;
}

export interface HarnessAdapter {
  /** Stable identifier, e.g. "claude-code". The CLI/registry key. */
  readonly name: string;
  /** What this harness can drive — gates which ports below are required. */
  readonly capabilities: AdapterCapabilities;
  /** Format axis: tool catalog, hook events, instruction targets, plugin-root token. */
  readonly dialect: HarnessDialect;
  /** Layout axis: where the instruction file / skills / agents / hooks live on disk. */
  readonly layout: PluginLayout;
  /** Transport axis: the agent binary to spawn + the mock-model env. Present iff
   *  `capabilities.harnessTesting`. */
  readonly runtime?: HarnessRuntime;
  /** Transport axis: how a hook signals a block/deny. Present iff
   *  `capabilities.shellHooks`. */
  readonly hookProtocol?: HookProtocol;
  /** Transport axis: the mock model's wire format + endpoints. Present iff
   *  `capabilities.harnessTesting`. */
  readonly modelMock?: ModelMock;
  /**
   * Pillar-2 deterministic-runner driver: how `runHarnessTest` builds this
   * harness's argv, starts its scripted mock, and parses its stdout. Present iff
   * `capabilities.harnessTesting` (it composes the runtime + modelMock into the
   * one seam the runner dispatches through). Carried on the bundle so the runner
   * never imports a sibling adapter to find it.
   */
  /**
   * 🔴 A THUNK, NOT THE DRIVER, and the indirection is the whole point. A driver
   * lives in `harness-test.ts`, which imports the conformance suite, which
   * imports the compiler, which imports the cross-language symbol index, which
   * loads a NATIVE binary. Holding the driver eagerly meant every consumer of an
   * adapter paid for all of it — including the hook runtime, which reads only
   * `dialect` and `hookProtocol` and never runs a harness test at all.
   *
   * Measured 2026-09-19, `require("./adapter-registry.js")`:
   *
   *     eager:  107 modules, 7 ast-grep, 1 native .node
   *
   * ...on a path whose actual work takes about a millisecond. Calling the thunk
   * is what loads the driver, so the test tier pays and the runtime does not.
   *
   * ASYNC because a dynamic `import()` is the only form that defers in BOTH
   * environments this code runs in: the CJS `dist/` build (where TypeScript
   * lowers it to a deferred `require`) and vitest loading the TS sources
   * directly, where a synchronous `require` of a sibling `.ts` does not resolve
   * at all — measured, not assumed.
   */
  readonly harnessTestDriver?: () => Promise<HarnessTestDriver>;
  /**
   * How strongly a repo at `root` looks like it targets this harness — the CLI
   * uses it to auto-detect which adapter to use (the library selects by import).
   * Returns a **specificity score**: 0 = not this harness; higher = a more
   * specific match. The registry picks the highest scorer, so a strong signal
   * (a `.claude-plugin/` manifest) beats a weak one (a bare `CLAUDE.md`, or an
   * `AGENTS.md` that many harnesses share) regardless of registration order.
   */
  detect(root: string): number;
}
