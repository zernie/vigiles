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
import type { HarnessVocabulary } from "./vocabulary.js";
import type { EventCapabilityTable } from "./event-capability.js";
import type { InstructionBudget } from "./instruction-weight.js";

/**
 * Every SKILL.md frontmatter key the COMPILER knows how to render, in the order
 * it renders them. A property of `renderSkillFrontmatter`, not of any harness:
 * a dialect's {@link HarnessDialect.skillFrontmatterKeys} is a subset of this,
 * and a key outside it can be declared but will never be emitted.
 *
 * 🔴 THIS REPLACES A TYPE ALIAS THAT SPELLED A HARNESS. It used to be
 * `type SkillFrontmatterProfile = "claude-code" | "minimal"`, and it was the
 * root of five of the eleven per-site lint disables on this branch: `compile.ts`
 * defaulted to it, branched on it and defaulted it again, and
 * `lethal-trifecta.ts` compared against it. Each of those is now a set
 * membership test over key names, which are facts about a FILE FORMAT and carry
 * no harness in them.
 */
export const RENDERABLE_SKILL_FRONTMATTER_KEYS = [
  "name",
  "description",
  "disable-model-invocation",
  "context",
  "argument-hint",
  "allowed-tools",
  "disallowed-tools",
] as const satisfies readonly string[];

/**
 * The instruction filenames vigiles recognizes when NO dialect is injected, in
 * precedence order — `[0]` is what a spec compiles into when it names no target.
 *
 * 🔴 IT IS THE CORE'S OWN DEFAULT, AND DERIVING IT FROM THE REGISTRY IS NOT
 * ALLOWED HERE — worth saying, because that is the obvious fix and it is the
 * wrong one. `src/core/CLAUDE.md` states the invariant ("the core must not
 * import an adapter, `core ⊄ adapter`") and the registry IS the adapters.
 * Measured on a probe that added `import { ADAPTERS } from
 * "../adapter-registry.js"` to `validate.ts`: the module graph of
 * `dist/core/validate.js` went from 108 to 136 modules and pulled BOTH
 * `adapters/claude-code/adapter.js` and `adapters/codex/adapter.js` into the
 * domain's own graph.
 *
 * ⚠️ AND THE LINT DOES NOT STOP IT — same probe: `npx eslint
 * src/core/validate.ts` reported 0 errors, because `boundaries/dependencies`
 * treats `src/adapter-registry.ts` as the unclassified composition root and
 * judges DIRECT edges only. That silence is an artifact of where the rule
 * looks, not permission. So the agreement between this list and the registry is
 * held by a TEST that lives outside the core (`adapter-contract.test.ts`),
 * where importing the registry is legal — a ratchet instead of an inversion.
 *
 * ONE PLACE, because it was two: `validate.ts` held `["CLAUDE.md", "AGENTS.md"]`
 * and `compile.ts` held `DEFAULT_TARGET = "CLAUDE.md"`, which is this list's
 * head under another name — {@link HarnessDialect.instructionTargets} already
 * contracts that `[0]` is the default target, so the second was the first,
 * restated.
 */
export const DEFAULT_INSTRUCTION_TARGETS: readonly string[] = [
  "CLAUDE.md",
  "AGENTS.md",
];

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
   * The SKILL.md frontmatter keys this harness READS. The compiler emits a key
   * iff it is listed here, so a harness that reads only the cross-tool shape
   * declares `["name", "description"]` and the CC-only keys are omitted from its
   * output rather than written as inert noise.
   *
   * Conformance requires `name` and `description` (a SKILL.md without them has
   * no identity) and refuses a key outside
   * {@link RENDERABLE_SKILL_FRONTMATTER_KEYS} — a key the compiler cannot render
   * is a declaration nothing acts on.
   */
  readonly skillFrontmatterKeys: readonly string[];
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
