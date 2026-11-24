/**
 * Typed Claude Code authoring surface — the compile-time half of the purity
 * contract, bound to the Claude Code tool vocabulary.
 *
 * The core `experimental_agent()` / `skill()` builders (`vigiles/spec`) are generic over a
 * tool `ToolVocabulary` that DEFAULTS to fully-open (`string` at every purity
 * level), so they accept any tools — backwards-compatible, harness-agnostic.
 * This module re-binds them to the CONCRETE Claude Code vocabulary derived from
 * `claudeCodeDialect`, so authoring a spec with an invalid `purity`×`tools`
 * combination is a `tsc` error at EDIT TIME, before any vigiles command runs:
 *
 *   import { experimental_agent } from "vigiles/harness/claude-code";
 *
 *   experimental_agent({ purity: "pure", tools: ["Read", "Bash"] });
 *   //                                       ^^^^^^ tsc error — Bash side-effecting
 *
 *   experimental_agent({ purity: "bounded", tools: ["Read", "Bash", "Write"] }); // OK
 *   experimental_agent({ purity: "bounded", tools: ["mcp__x__y"] });
 *   //                                  ^^^^^^^^^^^ tsc error — MCP not decidable
 *
 *   experimental_agent({ tools: ["anything", "mcp__x__y"] }); // no purity → open, OK
 *
 * This is a STRICT ADDITION to the runtime/compile checks: `purityViolations`
 * (`vigiles compile`) and `decidePurityGate` (the PreToolUse gate) are unchanged
 * and remain the universal backstop. In particular the command-level decision a
 * `bounded` unit makes for `Bash` (read-only command allowed, mutating denied)
 * is the RUNTIME gate's job — the type only admits the `Bash` TOOL at `bounded`.
 *
 * The CC literal tool names live ONLY in this adapter (and the dialect it reads
 * from), never in core — the hexagonal boundary that keeps the domain
 * harness-agnostic.
 */
import {
  experimental_agent as coreAgent,
  experimental_skill as coreSkill,
  type AgentSpec,
  type AgentSpecInput,
  type SkillSpec,
  type SkillSpecInput,
  type AuthoredPurity,
  type ToolVocabulary,
} from "../../core/spec.js";
import type {
  ClaudeCodeReadOnlyTool,
  ClaudeCodeBoundedTool,
} from "./dialect.js";

/**
 * The Claude Code tool vocabulary, split by the purity floor that admits each
 * tool (mirrors the runtime ladder in `core/effects.ts`):
 * - `readOnly`: tools a `pure` unit may declare (Read/Grep/Glob/LS).
 * - `bounded`:  read-only ∪ Write/Edit/MultiEdit/NotebookEdit ∪ `Bash`.
 *
 * @public
 */
export interface ClaudeCodeToolVocabulary extends ToolVocabulary {
  readonly readOnly: ClaudeCodeReadOnlyTool;
  readonly bounded: ClaudeCodeBoundedTool;
}

/**
 * Define a Claude Code subagent with the purity floor enforced AT COMPILE TIME
 * against the Claude Code tool catalog. Identical to the core `experimental_agent()` at
 * runtime (it IS the core builder); the only difference is the typed `tools`
 * constraint. `P` is inferred from the literal `purity` field.
 */
function agentSpec<const P extends AuthoredPurity | undefined = undefined>(
  spec: AgentSpecInput<P, ClaudeCodeToolVocabulary>,
): AgentSpec {
  return coreAgent<P, ClaudeCodeToolVocabulary>(spec);
}

/**
 * The Claude Code subagent root. Carries the SAME vocabulary members as the core
 * builder, and it must: they stopped being standalone exports when the vocabulary
 * moved onto the root, so an author who picked this door would otherwise have no
 * way to reach them — the same asymmetry `experimental_skill.input()` closed.
 *
 * @experimental
 *
 * @beta
 */
export const experimental_agent = Object.assign(agentSpec, {
  result: coreAgent.result,
  delegate: coreAgent.delegate,
  railway: coreAgent.railway,
  needs: coreAgent.needs,
  pipeStep: coreAgent.pipeStep,
  start: coreAgent.start,
  andThen: coreAgent.andThen,
  pipe: coreAgent.pipe,
});

/**
 * Define a Claude Code skill with the purity floor enforced AT COMPILE TIME
 * against the Claude Code tool catalog. Identical to the core
 * `experimental_skill()` at runtime; the typed `tools` constraint is the only
 * difference.
 *
 * Carries the same `.input` / `.step` helpers as the core builder, and it must:
 * those two stopped being standalone exports when the helper vocabulary moved
 * onto the skill builder, so an author who picked this door would otherwise have
 * no way to reach them. Before the move they came from `vigiles/spec` — a second
 * import for one skill, which is the asymmetry this closes rather than a cost it
 * introduces.
 *
 * @experimental
 */
function skillSpec<const P extends AuthoredPurity | undefined = undefined>(
  spec: SkillSpecInput<P, ClaudeCodeToolVocabulary>,
): SkillSpec {
  return coreSkill<P, ClaudeCodeToolVocabulary>(spec);
}

/**
 * @experimental
 *
 * @beta
 */
export const experimental_skill = Object.assign(skillSpec, {
  input: coreSkill.input,
  step: coreSkill.step,
});
