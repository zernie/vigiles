/**
 * HarnessDialect — the format/dialect PORT (see
 * `research/code-adapter-architecture.md`, the format axis).
 *
 * The compiler needs a handful of harness-specific facts to verify and render an
 * instruction file: the built-in tool catalog a subagent may declare, the tools
 * the platform never exposes, the shape of an MCP tool reference, the hook
 * events the harness fires, the instruction-file targets it reads, and the env
 * token expanded to the plugin root. Those used to be hard-coded literals inside
 * `compile.ts`; here they are a single named value behind an interface.
 *
 * Claude Code is the reference dialect today (`claudeCodeDialect`, defined in its
 * adapter at `src/adapters/claude-code/dialect.ts`). A second harness (Codex
 * likely next) is added by defining a sibling `HarnessDialect` — e.g.
 * `src/adapters/codex/dialect.ts` exporting `codexDialect` — and injecting it
 * (`compileAgent(spec, { dialect })`). The compiler reads these from the injected
 * dialect, so the core never hard-codes — nor even defines — one harness's
 * vocabulary: the concrete dialects live in the adapters, only this interface
 * lives in the core. That is the format axis of the hexagonal boundary.
 */
/**
 * Which SKILL.md frontmatter keys a harness understands — see
 * `HarnessDialect.skillFrontmatter`.
 */
import type { HarnessVocabulary } from "./vocabulary.js";
import type { EventCapabilityTable } from "./event-capability.js";
import type { InstructionBudget } from "./instruction-weight.js";

export type SkillFrontmatterProfile = "claude-code" | "minimal";

export interface HarnessDialect {
  /** Stable identifier, e.g. "claude-code". */
  readonly name: string;
  /** Built-in tools a subagent may list in its `tools:` contract. */
  readonly builtinAgentTools: readonly string[];
  /** Tools the platform never exposes to a subagent (a listed one is dead). */
  readonly neverAvailableTools: readonly string[];
  /** Matches an MCP tool reference, e.g. `mcp__server__tool`. */
  readonly mcpToolPattern: RegExp;
  /**
   * MCP servers the harness provides itself, available to a contract WITHOUT the
   * plugin declaring them — e.g. Claude Code's built-in `ide` integration
   * (`mcp__ide__getDiagnostics`). The `mcp-tool-resolves` check allowlists these
   * so a reference to a built-in server is never flagged as an undeclared one.
   * Optional (additive, non-breaking for existing adapters) — defaults to none.
   */
  readonly knownMcpServers?: readonly string[];
  /** Hook event names the harness fires. */
  readonly hookEvents: readonly string[];
  /**
   * The subset of `hookEvents` where a block decision (`exit 2` / a deny field)
   * is SILENTLY IGNORED ENTIRELY — no veto AND no model feedback (Claude Code's
   * SessionStart / SessionEnd / Notification / PreCompact: exit 2 there writes
   * stderr only to the user). The basis for the `hook-block-ineffective`
   * "wrong-event" check, which fires ONLY on these (so it stays FP-safe and never
   * cries wolf on a PostToolUse feedback/nudge hook). Optional (additive,
   * non-breaking) — absent ⇒ the harness's block semantics are undeclared and the
   * check does not run for it.
   *
   *   @deprecated Superseded by {@link eventCapabilities}, from which this list is
   * now DERIVED (`blockIneffectiveEvents`) and against which it is asserted. Kept
   * because removing a public port field breaks third-party adapters; it will go
   * in the next major.
   *
   * 🔴 THE NAME IS WRONG AND THAT MATTERED. "No effect" reads as "a hook here does
   * nothing", but it MEANS "no effect OF A BLOCK" — Claude Code's `SessionStart`
   * is in this list and injects context perfectly well; exit 2 is the only thing
   * it ignores. Deriving the list caught this: the obvious predicate
   * (`honours === []`) silently dropped SessionStart and would have changed what
   * `hook-block-ineffective` flags.
   */
  readonly noEffectHookEvents?: readonly string[];
  /**
   * The subset of blocking events whose deny REQUIRES the structured
   * `permissionDecision` field (e.g. Claude Code's `PreToolUse`), where the
   * legacy top-level `decision` field is silently ignored. The basis for the
   * `hook-block-ineffective` "wrong-field" check. Optional (additive).   *
   * @deprecated Superseded by {@link eventCapabilities} (`denyShape:
   * "permission-decision"`), from which this list is derived and against which it
   * is asserted. Kept for third-party adapters; goes in the next major.
   */
  readonly permissionDecisionHookEvents?: readonly string[];
  /** Instruction-file targets the harness reads (also the h1 heading). */
  readonly instructionTargets: readonly string[];
  /** The env token expanded to the plugin root in hook commands. */
  readonly pluginRootToken: string;
  /**
   * Which SKILL.md frontmatter keys this harness understands — the profile the
   * compiler renders under:
   * - `"claude-code"` — the full Claude Code set (name, description, plus the
   *   CC-only keys: disable-model-invocation, argument-hint, …).
   * - `"minimal"` — name + description ONLY (the cross-tool SKILL.md shape Codex
   *   and OpenCode read; CC-only keys are omitted because they'd be inert noise).
   */
  readonly skillFrontmatter: SkillFrontmatterProfile;
  /**
   * Tools that PRODUCE side effects (write, exec, network, spawn) — the
   * complement of read-only within `builtinAgentTools`. The basis for
   * effect-surface analysis and the `pure:` contract: a tool here is denied to a
   * pure skill and counts toward a harness's side-effect surface. `Bash` is
   * listed (undecidable at the tool-name level → conservatively side-effecting);
   * an MCP tool not classifiable from the name is treated as unknown-effect.
   * Optional (additive, non-breaking) — absent ⇒ no tool is known-side-effecting.
   */
  readonly sideEffectingTools?: readonly string[];
  /**
   * The hook-event catalog as a {@link HarnessVocabulary} — a status and a
   * recorded vendor capture per term, rather than bare membership in
   * `hookEvents`. When present it is what `verifyHookEvents` classifies against,
   * so a name the catalog doesn't hold produces an `unrecognised` ADVISORY
   * (naming vigiles's capture as the possibly-stale party) instead of the old
   * behaviour, where an unknown name drew an accusation or silence depending on
   * its edit distance to the list.
   *
   * Optional (additive, non-breaking). Absent ⇒ one is synthesised from
   * `hookEvents` via `vocabularyFromLists`, so a legacy adapter keeps working
   * and its unknowns become advisories rather than silence.
   */
  readonly hookEventVocabulary?: HarnessVocabulary;
  /**
   * What this harness loads WITHOUT being asked, how it MEASURES that, and what
   * it does when there is too much — {@link InstructionBudget}.
   *
   * On the dialect because it is a FORMAT fact (which files, counted in which
   * unit), and because the browser engine is handed a dialect. Optional: absent
   * ⇒ the weight report does not run for that adapter, which is the honest
   * answer for a harness whose limits nobody has read.
   */
  readonly instructionBudget?: InstructionBudget;
  /**
   * What each hook event CARRIES and HONOURS — {@link EventCapabilityTable}.
   *
   * The single table three flat lists had been approximating: `hookEvents`
   * (membership), `noEffectHookEvents` (blocks ignored) and
   * `permissionDecisionHookEvents` (deny needs a field) all ask about an event,
   * none relate it to its PAYLOAD, and the fourth — `injectableEvents` — sits on
   * a different port entirely. A list per question cannot answer a question
   * about a PAIR, which is what "is this role legal on this event?" is.
   *
   * Optional (additive, non-breaking): absent ⇒ the flat lists still decide, and
   * the (role, event) compatibility check does not run for that adapter. Present
   * ⇒ it is the source the derived lists are read from, so the two cannot drift.
   */
  readonly eventCapabilities?: EventCapabilityTable;
  /**
   * The subagent-tool catalog as a {@link HarnessVocabulary}. Same contract as
   * `hookEventVocabulary`; absent ⇒ synthesised from `builtinAgentTools`
   * (available) + `neverAvailableTools` (withheld).
   *
   * The third status is why this exists: the vendor removes `Agent` only at the
   * spawn depth limit and `ExitPlanMode` only outside plan mode, and removes
   * most built-ins from a background subagent but not a foreground one — so
   * "available to a subagent" is not a property of the name, and a two-way
   * split had to encode one of those conditions as an unconditional fact.
   */
  readonly subagentToolVocabulary?: HarnessVocabulary;
}
