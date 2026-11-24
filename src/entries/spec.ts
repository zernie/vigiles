// 🔴 PUBLIC ENTRY POINT `vigiles/spec` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-spec.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/spec` — what a spec AUTHOR imports to describe a CLAUDE.md /
 * AGENTS.md, a SKILL.md or a subagent: the builders, the verified-reference
 * constructors, their types, and the assertions over a subagent's outcome.
 * Compiling is the CLI's job (`vigiles compile` / `vigiles lint`), not this
 * door's.
 *
 * A package entry, and so a COMPOSITION ROOT: the builders are core
 * (`src/core/spec.ts`), and `experimental_assertAgentOk` & co. read a subagent's result block
 * through the Claude Code adapter — core cannot import that, an entry can.
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

// --- a subagent's OUTCOME, asserted: the testing half of `experimental_agent`'s
// result contract. A subagent with a `result()` contract ends its turn with a
// vigiles:ok/err block; these wrap `parseAgentResult` (the Claude Code adapter's
// reader of that block, which is why they live in this composition root and not
// in core) so a test asserts the worker's outcome the way it asserts a hook
// decision: `experimental_assertAgentOk(r.output)` instead of substring-matching
// prose. They THROW, so after one TypeScript has narrowed the result. Prefixed
// because they read `experimental_agent`'s contract: a stable name resting on an
// experimental one is the transitive hole the prefix rule exists to close.
import type { OutputContract } from "../core/spec.js";
import {
  parseAgentResult,
  type ParsedAgentResult,
} from "../adapters/claude-code/agent-result.js";

export type { ParsedAgentResult } from "../adapters/claude-code/agent-result.js";

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

/**
 * Assert the worker's output is an error result, and return its `error`. The
 * railway's error track — proves the worker reported failure with rich detail
 * (not that it crashed or returned prose). A malformed or success result throws.
 *
 * @experimental Reads `experimental_agent`'s result contract.
 */
export function experimental_assertAgentErr(
  output: string,
  contract?: OutputContract,
): Record<string, unknown> {
  const r = parseAgentResult(output, contract);
  if (r.kind === "err") return r.error;
  const why = r.kind === "ok" ? "returned a success result" : r.reason;
  return fail(`expected an error result from the subagent, but ${why}`);
}

/**
 * Assert the parsed result satisfies `predicate` — the general form, for
 * checking rich detail (e.g. `(r) => r.kind === "ok" && r.value.files.length > 0`).
 *
 * @experimental Reads `experimental_agent`'s result contract.
 */
export function experimental_assertAgentResult(
  output: string,
  predicate: (r: ParsedAgentResult) => boolean,
  contract?: OutputContract,
): void {
  const r = parseAgentResult(output, contract);
  if (!predicate(r)) {
    const detail = r.kind === "malformed" ? ` (${r.reason})` : "";
    fail(`subagent result did not satisfy the predicate: ${r.kind}${detail}`);
  }
}
