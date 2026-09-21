/**
 * HookProtocol — the hook-wire PORT (transport axis). How a harness signals that
 * a hook blocked/denied a tool call: the block exit code, the decision values
 * that mean "deny", and the env vars a synthesized event carries. The research
 * (research/harness-landscape.md) found Claude Code and Codex hooks are nearly
 * identical at the wire level (both: JSON on stdin, `permissionDecision: "deny"`
 * / `decision: "block"` / exit 2) — so this descriptor is deliberately thin, and
 * the fact that a second harness needs almost the same values IS the finding.
 * What varies more (config format JSON-vs-TOML, the plugin-root token, the event
 * names) lives in PluginLayout / HarnessDialect, not here.
 *
 * The Claude Code implementation is `claudeCodeHookProtocol` in
 * `src/adapters/claude-code/hook-protocol.ts`.
 */
import type { HookConditionSupport } from "./hook-condition.js";

export interface HookProtocol {
  /** Stable identifier, e.g. "claude-code". */
  readonly name: string;
  /** Exit code a hook process uses to block/deny a tool call (Claude Code: 2). */
  readonly blockExitCode: number;
  /** decision / permissionDecision values that mean "deny" the tool call. */
  readonly denyDecisionValues: readonly string[];
  /**
   * Env vars a synthesized hook event carries beyond the JSON on stdin (Claude
   * Code passes the event on stdin only; Codex adds session_id/cwd/PLUGIN_ROOT/…).
   */
  readonly eventEnvVars: readonly string[];
  /**
   * How a tool matcher is written in the emitted hooks block — `"exact"` (Claude
   * Code: the tool name / `A|B` alternation) or `"regex"` (Codex: an anchored
   * regex `^(A|B)$`). Optional (additive, non-breaking) — absent ⇒ `"exact"`.
   * Used by `compileHookProgram` when rendering the settings block.
   */
  readonly matcherStyle?: "exact" | "regex";
  /**
   * The config fragment that registers ONE command on ONE event, in this
   * harness's native settings SHAPE. Claude Code nests
   * `{matcher, hooks: [{type: "command", command}]}`; Codex is flat
   * `{matcher, command}`.
   *
   * 🔴 THE SHAPE HALF OF WHAT `settingsFormat` WAS STANDING IN FOR, and it does
   * not belong with the encoding. `PluginLayout.settingsFormat` was a
   * `"json" | "toml"` enum that three call sites read as "which entry shape",
   * which is neither what its name says nor what its values mean — a TOML
   * harness with CC-shaped entries, or a JSON harness with flat ones, were both
   * expressible and both would have been read wrong. A constructor cannot be
   * wrong about its own shape.
   *
   * Reading already tolerates both shapes (`core/hook-normalize.ts`); this
   * makes WRITING symmetric.
   */
  registration(
    on: string,
    matcher: string | undefined,
    command: string,
  ): { readonly hooks: Readonly<Record<string, readonly unknown[]>> };
  /**
   * Merge a compiled hook's registrations into an already-parsed settings
   * object, idempotently: entries this hook file manages are REPLACED, every
   * other command — including the user's own hand-written hooks sharing a
   * matcher block — is preserved.
   *
   * On `HookProtocol` because it is the same SHAPE question `registration`
   * answers, from the other direction: the CC shape nests several commands
   * under one matcher (so the granularity has to be the command), the Codex
   * shape carries one command per entry (so entry- and command-granularity
   * coincide). Typed structurally here, because the concrete entry types are
   * the application layer's.
   *
   * ⚠️ There is no `registrations(config)` INVERSE yet — reading a third shape
   * would need one, and that is deferred until a third shape exists. What
   * exists now is: write one (`registration`), and merge into a parsed object
   * (this).
   */
  mergeRegistrations(
    existing: Record<string, unknown>,
    compiled: Readonly<Record<string, readonly unknown[]>>,
    managedBy: string,
  ): Record<string, unknown>;
  /**
   * The events whose hook can inject **developer context** into the agent by
   * printing `{ hookSpecificOutput: { hookEventName, additionalContext } }` on
   * stdout. The inject *shape* is shared across Claude Code and Codex (so the
   * runtime emits it once, not per-harness); the genuinely per-harness fact is
   * **which events honor it** — and encoding it here is what makes "this harness
   * can deliver an inject hook" a TESTED contract instead of an assumption. Both
   * Claude Code and Codex support the main lifecycle events (SessionStart,
   * UserPromptSubmit, PreToolUse, PostToolUse); beyond that they DIVERGE, which
   * is why this is a port and not a core constant: Claude Code also honors
   * `Stop` (measured 2026-09-15 on 2.1.273, headless), Codex instead honors
   * `SubagentStart`. An empty list means the harness cannot inject context from
   * a hook at all. Verified for Codex against the official hooks docs
   * (developers.openai.com/codex/hooks). The conformance kit asserts a
   * shell-hook harness declares a non-empty set.
   *
   * ⚠️ This comment previously asserted that "a few (Stop, SubagentStop,
   * PreCompact) carry no context on EITHER" harness. For Claude Code's `Stop`
   * that was wrong, and the cost was structural rather than cosmetic: an
   * unmeasured claim in a doc-comment became the runtime's emit gate, so three
   * react hooks were reported undeliverable-by-vocabulary when the harness
   * would have delivered them. A per-harness fact belongs in the adapter WITH
   * its measurement; the residue (`SubagentStop`, `PreCompact`) stays unclaimed
   * here rather than re-asserted.   *
   * @deprecated Superseded by `HarnessDialect.eventCapabilities`
   * (`honours: "inject"`), which is asserted to reproduce this list exactly. It
   * lives on the DIALECT rather than here because three sibling event facts
   * already did, and because the browser-side engine is handed a dialect and
   * never a protocol. Kept for third-party adapters; goes in the next major.
   */
  readonly injectableEvents: readonly string[];
  /**
   * The boolean stdout field whose `false` value HALTS THE WHOLE TURN, if the
   * harness has one (Claude Code: `"continue"`). Distinct from a deny: a deny
   * refuses one tool call, this stops the iteration and hands `stopReason` back
   * to the agent as text — so authors reach for it exactly when they want to
   * explain themselves, and a guard written that way still prevents the action.
   *
   * Optional (additive, non-breaking) and per-harness on purpose. It is
   * DOCUMENTED for Claude Code and UNVERIFIED for Codex, whose protocol notes
   * only record the shared exit-2 / `decision` / `permissionDecision` model — so
   * Codex leaves it unset rather than inheriting a claim nobody measured. Read
   * by `decideHook`; absent ⇒ no field halts the turn on this harness.
   */
  readonly haltsTurnField?: string;
  /**
   * How this harness decides whether a hook that declares a CONDITION runs at all
   * — Claude Code's per-action `if` field. Optional (additive, non-breaking);
   * absent ⇒ the harness has no such feature and every hook is unconditional,
   * which is what every consumer got before this existed.
   *
   * 🔴 IT IS A PORT FIELD BECAUSE THE SYNTAX IS THE HARNESS'S, NOT BECAUSE THE
   * IDEA IS. "A hook may only run on matching calls" is neutral and modelled in
   * `core/hook-condition.ts`; `"Bash(git push *--force*)"` is Claude Code's
   * permission-rule grammar, so the matcher lives in its adapter. Reading it here
   * is what stops `verifyGuardrail` reporting a conditional guard as blocking
   * things its condition means it never sees — see `core/hook-condition.ts` for
   * the measured false green that put this field on the port.
   */
  readonly condition?: HookConditionSupport;
}
