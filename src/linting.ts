// 🔴 PUBLIC ENTRY POINT `vigiles/linting` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-linting.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/linting` — Pillar 1 entry point: what a spec AUTHOR imports to describe a CLAUDE.md,
 * a SKILL.md or an agent — the builders, the verified-reference constructors and their types.
 * Compiling is the CLI's job (`vigiles compile` / `vigiles lint`), not this subpath's.
 *
 * Curated (named, not `export *`) so the internal compiler, validators, hash helpers and the
 * linter cross-reference ENGINE stay out of the public surface, the api reports and the docs.
 *
 * WHAT THE CURATION DROPS (28 symbols, measured 2026-08-21 — nothing in this repo imported any
 * of them from here; every in-repo user takes them from `vigiles/spec`): the typed-COMPOSITION
 * family — `experimental_pipe`/`_pipeStep`/`_start`/`_andThen`/`_needs`, `Pipeline`, `PipeStep`,
 * `Supplies`, `Handoff`, `NeedsContract`, `OkOf`, `TypedAgentSpec`, `TypedOutcome`, `Shape`,
 * `OutputFieldType` and the `result()` builder. Those verify HANDOFFS between workers; they
 * compile to nothing and lint nothing, so they are not pillar 1.
 */

// --- the spec authoring builders: rules, refs, prose, and the three spec kinds ---
export {
  // instruction files
  instructionFile,
  prose,
  experimental_effect,
  // rules
  enforce,
  guidance,
  guard,
  // verified references
  file,
  cmd,
  symbol,
  ref,
  dir,
  glob,
  project,
  // the other two spec kinds + how a railway wires them
  experimental_skill,
  // the subagent ROOT — `railway`/`delegate`/`result`/`pipe`… are its members
  experimental_agent,
  // ─── ОКНО АЛИАСА (один мажор) — see core/spec.ts for why a window is not
  // politeness here. Kept on THIS door too: a consumer importing `claude` from
  // `vigiles/linting` never saw `vigiles/spec`, so the window over there does
  // not cover them.
  /** @deprecated Renamed to `instructionFile`. Removed one major AFTER the one that introduces it. */
  claude,
  /** @deprecated Renamed to `prose`. Removed one major AFTER the one that introduces it. */
  instructions,
  /** @deprecated Renamed to `experimental_agent`. Removed one major AFTER the one that introduces it. */
  agent,
} from "./core/spec.js";

export {
  BUILTIN_LINTERS,
  type BuiltinLinter,
  type LinterRule,
  type VigilesRef,
  type EnforcementRef,
  type KnownLinterRules,
  type KnownProjectFiles,
  type KnownNpmScripts,
  type KnownAgentName,
  type StrictLinterRule,
  type StrictFile,
  type StrictCmd,
  type ToolVocabulary,
  type OpenToolVocabulary,
  type AllowedAt,
  type AuthoredPurity,
  type EnforceRule,
  type GuidanceRule,
  type GuardRule,
  type Rule,
  type VerifiedPath,
  type VerifiedCmd,
  type VerifiedRef,
  type VerifiedDir,
  type VerifiedGlob,
  type FileRef,
  type CmdRef,
  type SkillRef,
  type SymbolRef,
  type DirRef,
  type GlobRef,
  type Ref,
  type EffectRegion,
  type InstructionFragment,
  type InstructionTarget,
  type ClaudeSpec,
  type Gate,
  type RoleGate,
  type ProjectRole,
  type SkillInput,
  type SkillStep,
  type SkillSpec,
  type SkillSpecInput,
  type AgentSpec,
  type AgentSpecInput,
  type Railway,
  type RailwayStep,
  // Named by `SkillSpec` / `AgentSpec` (their `output` field), so an author can type one.
  type OutputContract,
} from "./core/spec.js";

// NO COMPILE ENTRY POINTS HERE (removed in the major that ships #257). `compileClaude`,
// `compileSkill`, `compileAgent`, `compileRailway` and their option/result types were public
// with no external caller — measured across the repos that depend on vigiles, every import is a
// spec builder — and the promise froze them synchronous while the symbol check they run became
// async. Spec authors run `vigiles compile`; the CLI imports the compiler from source.

// core/linters is the cross-reference ENGINE (checkLinterRule/editDistance/…),
// consumed by compile — not part of the public authoring surface.
