// 🔴 PUBLIC ENTRY POINT `vigiles/spec` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-spec.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/spec` — what a spec AUTHOR imports to describe a CLAUDE.md /
 * AGENTS.md, a SKILL.md or a subagent: the builders, the verified-reference
 * constructors, their types, and the assertion that returns a subagent's
 * success value.
 * Compiling is the CLI's job (`vigiles compile` / `vigiles lint`), not this
 * door's.
 *
 * A package entry, and so a COMPOSITION ROOT: the builders are core
 * (`src/core/spec.ts`), and `experimental_assertAgentOk` reads a subagent's result
 * block with core's parser.
 *
 * Curated (named, not `export *`) so the compiler's phase types, the internal
 * config shape and the linter catalog stay out of the public surface. One door
 * since v50: `vigiles/linting`, a strict subset of this one, is gone.
 */

// --- the authoring builders: instruction files, rules, references, and the two
// other spec kinds (a skill, a subagent) ---
export {
  instructionFile,
  prose,
  experimental_effect,
  enforce,
  guidance,
  guard,
  file,
  cmd,
  symbol,
  ref,
  dir,
  glob,
  project,
  experimental_skill,
  experimental_agent,
} from "../core/spec.js";

export type {
  AgentSpec,
  AgentSpecInput,
  AllowedAt,
  AuthoredPurity,
  BuiltinLinter,
  ClaudeSpec,
  CmdRef,
  DirRef,
  EffectRegion,
  EnforceRule,
  EnforcementRef,
  FileRef,
  Gate,
  GlobRef,
  GuardRule,
  GuidanceRule,
  Handoff,
  InstructionFragment,
  InstructionTarget,
  KnownAgentName,
  KnownLinterRules,
  KnownNpmScripts,
  KnownProjectFiles,
  LinterRule,
  NeedsContract,
  OkOf,
  OpenToolVocabulary,
  OutputContract,
  OutputFieldType,
  PipeStep,
  Pipeline,
  ProjectRole,
  Railway,
  RailwayStep,
  Ref,
  RoleGate,
  Rule,
  RuleDetails,
  RuleDetailsOptions,
  RuleRender,
  Shape,
  SkillInput,
  SkillRef,
  SkillSpec,
  SkillSpecInput,
  SkillStep,
  StrictCmd,
  StrictFile,
  StrictLinterRule,
  Supplies,
  SymbolRef,
  ToolVocabulary,
  TypedAgentSpec,
  TypedOutcome,
  VerifiedCmd,
  VerifiedDir,
  VerifiedGlob,
  VerifiedPath,
  VerifiedRef,
  VigilesRef,
} from "../core/spec.js";

// --- a subagent's OUTCOME, as a value: the testing half of `experimental_agent`'s
// result contract. A subagent with a `result()` contract ends its turn with a
// vigiles:ok/err block; `experimental_assertAgentOk` wraps `parseAgentResult`
// (src/core/agent-result.ts) so a test gets the worker's success value instead
// of substring-matching prose. It THROWS, so after it TypeScript has narrowed
// the result — the one reason it is an assertion and not a check. The other
// two (the error track, a predicate) are `check.experimental_agentResult` on
// the root (v52). Prefixed because it reads `experimental_agent`'s contract: a
// stable name resting on an experimental one is the transitive hole the prefix
// rule exists to close.
import type { OutputContract } from "../core/spec.js";
import { parseAgentResult } from "../core/agent-result.js";

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Assert the worker's output is a success result, and return its `value`. With a
 * `contract`, the value is validated against the success shape (a wrong/missing
 * field fails the assertion). A malformed or error result throws.
 *
 * @experimental It reads `experimental_agent`'s result contract, so it is no
 * more settled than that contract.
 *
 * @beta
 */
export function experimental_assertAgentOk(
  output: string,
  contract?: OutputContract,
): Record<string, unknown> {
  const r = parseAgentResult(output, contract);
  if (r.kind === "ok") return r.value;
  const why = r.kind === "err" ? "returned an error result" : r.reason;
  return fail(`expected a success result from the subagent, but ${why}`);
}
