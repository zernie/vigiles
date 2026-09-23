// 🔴 PUBLIC ENTRY POINT `vigiles/spec` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-spec.api.md`, which
// `npm run api:check` fails on.
/**
 * vigiles v2 — Executable specification system.
 *
 * Specs are TypeScript files that compile to instruction files (CLAUDE.md, SKILL.md).
 * The spec is the source of truth. The markdown is a build artifact.
 *
 * Two rule types:
 *   enforce() — delegated to an external linter (ESLint, Ruff, Clippy, etc.)
 *   guidance() — prose only, no mechanical enforcement
 */

// ---------------------------------------------------------------------------
// Template literal types for type-safe linter references
// ---------------------------------------------------------------------------

import { foldLegacyPostcondition } from "./skill-normalize.js";

/** Linters and policy catalogs vigiles can cross-reference. */
/**
 * The built-in linter / policy catalogs vigiles cross-references — the SINGLE
 * source for the set. `BuiltinLinter` derives from it, the `LINTERS` registry
 * is keyed by it, the conformance test cross-checks it, and browser-safe
 * consumers (the website) import this array to list the linters without going
 * stale. Zero node imports here, so it is importable everywhere.
 */
export const BUILTIN_LINTERS = [
  "eslint",
  "stylelint",
  "ruff",
  "clippy",
  "pylint",
  "rubocop",
  "detekt",
  "ktlint",
  "checkstyle",
  "golangci-lint",
  "cedar",
] as const;

export type BuiltinLinter = (typeof BUILTIN_LINTERS)[number];

/** Scoped ESLint plugin prefix (e.g., @typescript-eslint). */
type ScopedPlugin = `@${string}/${string}`;

/** A linter/rule reference: "eslint/no-console", "ruff/T201", "@typescript-eslint/no-explicit-any". */
export type LinterRule = `${BuiltinLinter}/${string}` | ScopedPlugin;

/** Vigiles-proven rule reference: "vigiles/<assertion-id>". */
export type VigilesRef = `vigiles/${string}`;

/** Any enforcement reference. */
export type EnforcementRef = LinterRule | VigilesRef;

// ---------------------------------------------------------------------------
// Type augmentation points for generate-types (#1 + #6)
//
// When `vigiles generate types` runs, it emits a .d.ts that populates these
// interfaces via declaration merging. This narrows enforce(), file(), and
// cmd() signatures from "any string" to "only known valid references."
//
// Without generated types: interfaces are empty, strict types fall back to
// broad LinterRule / string. No change in behavior.
//
// With generated types: enforce("eslint/no-consolee") → type error in editor.
// ---------------------------------------------------------------------------

/**
 * Populated by generate-types with per-linter rule unions.
 * Keys are linter prefixes ("eslint", "@typescript-eslint", "ruff", etc.),
 * values are unions of enabled rule names.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KnownLinterRules {}

/**
 * Populated by generate-types with project file paths.
 * Single key "files" maps to a union of relative paths.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KnownProjectFiles {}

/**
 * Populated by generate-types with npm script names.
 * Single key "scripts" maps to a union of script names.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KnownNpmScripts {}

/**
 * When KnownLinterRules is populated, narrows to exact rule unions.
 * Falls back to broad LinterRule when no generated types exist.
 */
export type StrictLinterRule = [keyof KnownLinterRules] extends [never]
  ? LinterRule
  : {
      [K in keyof KnownLinterRules]: `${K & string}/${KnownLinterRules[K] & string}`;
    }[keyof KnownLinterRules];

/**
 * When KnownProjectFiles is populated, narrows file() to known paths.
 * Falls back to string when no generated types exist.
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-duplicate-type-constituents */
export type StrictFile = [keyof KnownProjectFiles] extends [never]
  ? string
  : KnownProjectFiles[keyof KnownProjectFiles] & string;

export type StrictCmd = [keyof KnownNpmScripts] extends [never]
  ? string
  :
      | `npm run ${KnownNpmScripts[keyof KnownNpmScripts] & string}`
      | `npm ${KnownNpmScripts[keyof KnownNpmScripts] & string}`
      | (string & {}); // escape hatch for non-npm commands
/* eslint-enable @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-duplicate-type-constituents */

// ---------------------------------------------------------------------------
// Typed purity — a harness-neutral, compile-time constraint on a tool contract
//
// `purity` is a runtime/compile floor (see `purityViolations` in
// `core/effects.ts` + the PreToolUse gate); these types let a TYPED authoring
// surface reject an invalid `purity`×`tools` combination at the spec's own
// `tsc`, BEFORE any vigiles command runs. The runtime checks stay the universal
// backstop — typed purity is a strict addition that only helps a typed import.
//
// Core stays harness-agnostic: it defines only the MECHANISM (the `AllowedAt`
// conditional) parameterized by a `ToolVocabulary`. The concrete tool names are
// a HARNESS fact, so the CC vocabulary is wired in at the `vigiles/claude-code`
// composition layer (derived from `claudeCodeDialect`), never hard-coded here.
// The DEFAULT vocabulary is fully open (`string` at every level), so core
// `experimental_agent()`/`skill()` with no vocabulary param accept any tools, exactly as
// before — backwards compatibility is preserved.
// ---------------------------------------------------------------------------

/**
 * A harness's tool vocabulary, split by the purity floor that admits it. The
 * read-only/side-effecting split is harness-specific (it comes from the
 * dialect's `builtinAgentTools` − `sideEffectingTools`), so the concrete unions
 * are supplied by the adapter; core only describes the SHAPE.
 *
 * - `readOnly`: tools a `pure` unit may declare (observation only).
 * - `bounded`: tools a `bounded` unit may declare — the read-only set PLUS the
 *   decidable side-effecting tools (Write/Edit/NotebookEdit) AND `Bash` (its
 *   command is decided at RUNTIME by the gate; the floor admits the tool). Bars
 *   MCP / unknown / wildcard.
 *
 * The default (`string` at both) imposes no constraint — any tool is accepted at
 * every level, the historical behaviour of an untyped `experimental_agent()`/`skill()`.
 */
export interface ToolVocabulary {
  /** Union of tool names allowed under `purity: "pure"`. */
  readonly readOnly: string;
  /** Union of tool names allowed under `purity: "bounded"`. */
  readonly bounded: string;
}

/** The fully-open default vocabulary — no constraint at any purity level. */
export interface OpenToolVocabulary extends ToolVocabulary {
  readonly readOnly: string;
  readonly bounded: string;
}

/**
 * The tool names ALLOWED at a declared `purity`, given a vocabulary `V`:
 * - `"pure"`  → only `V["readOnly"]`.
 * - `"bounded"` → `V["bounded"]` (read-only ∪ decidable side-effecting ∪ `Bash`).
 * - `"dangerously-unrestricted"` (or no purity) → `string` (anything).
 *
 * With the open default vocabulary every branch widens to `string`, so an
 * untyped surface accepts any tools.
 */
export type AllowedAt<
  P extends AuthoredPurity | undefined,
  V extends ToolVocabulary,
> = P extends "pure"
  ? V["readOnly"]
  : P extends "bounded"
    ? V["bounded"]
    : string;

// ---------------------------------------------------------------------------
// REMOVED 2026-08-21: `ClaudeTool` and `HookEvent`.
//
// They described themselves as "the typed mirror of the Claude Code dialect",
// and both had drifted off it — while staying exported, so a consumer could
// import either and be misled with full type-checker blessing:
//
//   ClaudeTool  listed 11 tools, missing Task/Skill/SlashCommand, and carried
//               `Agent` — a name the live CLI uses and the docs do not.
//   HookEvent   listed 5 events, TWO OF WHICH DO NOT EXIST (`PreSession`,
//               `PostSession`). The vendor documents 31; the real list is
//               `claudeCodeHookEventNames` in the adapter's `vocabulary.ts`,
//               which itself held only 9 until 2026-08-17.
//
// Measured before deletion: zero references anywhere in src/, test/, examples/
// or docs/. Nothing consumed them, which is exactly why they were free to rot —
// a duplicate with no readers gets no correction pressure. The dialect is the
// single catalog (`claudeCodeDialect`), and a second harness swaps the dialect
// rather than editing a mirror of it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rule types
// ---------------------------------------------------------------------------

/** A rule delegated to an external tool (linter, ast-grep, dependency-cruiser, etc.) or to a vigiles-internal check. */
export interface EnforceRule {
  readonly _kind: "enforce";
  readonly linterRule: LinterRule | VigilesRef;
  readonly why: string;
  /** Skip verification for this rule. Default: true (verify). */
  readonly verify: boolean;
}

/** A guidance-only rule (prose, no enforcement). */
export interface GuidanceRule {
  readonly _kind: "guidance";
  readonly text: string;
}

/** A reactive rule: runs a command when watched files change. */
export interface GuardRule {
  readonly _kind: "guard";
  readonly watch: string | readonly string[];
  readonly run: string;
  readonly description: string;
}

export type Rule = EnforceRule | GuidanceRule | GuardRule;

// ---------------------------------------------------------------------------
// Builder functions
// ---------------------------------------------------------------------------

/**
 * Declare a rule enforced by an external tool or vigiles itself.
 *
 * When generated types are present, the `linterRule` argument is narrowed
 * to only accept rules that exist in your linter configs. Vigiles-internal
 * checks use the `vigiles/<assertion-id>` namespace and are dispatched to
 * built-in mechanical validators (e.g. `vigiles/orphan-docs`).
 *
 *   enforce("eslint/no-console", "Use structured logger.")
 *   enforce("@typescript-eslint/no-floating-promises", "Always await.")
 *   enforce("ruff/T201", "Use logging module.")
 *   enforce("vigiles/orphan-docs", "No docs without spec references.")
 */
export function enforce(
  ref: NoInfer<StrictLinterRule> | VigilesRef,
  why: string,
  options?: { verify?: boolean },
): EnforceRule {
  return {
    _kind: "enforce",
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    linterRule: ref as LinterRule | VigilesRef,
    why,
    verify: options?.verify ?? true,
  };
}

/**
 * Declare a guidance-only rule.
 *
 *   guidance("Google unfamiliar APIs before implementing.")
 */
export function guidance(text: string): GuidanceRule {
  return { _kind: "guidance", text };
}

/**
 * Declare a reactive guard: runs a command when watched files change.
 *
 *   guard({ watch: "*.spec.ts", run: "npx vigiles compile" }, "Recompile on spec change")
 *   guard({ watch: ["eslint.config.*", "package.json"], run: "npx vigiles generate types" }, "Regen types")
 */
export function guard(
  options: { watch: string | readonly string[]; run: string },
  description: string,
): GuardRule {
  return {
    _kind: "guard",
    watch: options.watch,
    run: options.run,
    description,
  };
}

// ---------------------------------------------------------------------------
// Reference helpers for skill instructions
// ---------------------------------------------------------------------------

/**
 * Branded string types — these prove a reference has gone through
 * vigiles's verification. The compiler only accepts branded refs,
 * not raw strings, for path-sensitive positions.
 */
declare const __brand: unique symbol;
export type VerifiedPath = string & { readonly [__brand]: "VerifiedPath" };
export type VerifiedCmd = string & { readonly [__brand]: "VerifiedCmd" };
export type VerifiedRef = string & { readonly [__brand]: "VerifiedRef" };
export type VerifiedDir = string & { readonly [__brand]: "VerifiedDir" };
export type VerifiedGlob = string & { readonly [__brand]: "VerifiedGlob" };

/** A typed file reference — verified at compile time. */
export interface FileRef {
  readonly _ref: "file";
  readonly path: VerifiedPath;
}

/** A typed command reference — verified at compile time. */
export interface CmdRef {
  readonly _ref: "cmd";
  readonly command: VerifiedCmd;
}

/** A typed cross-reference to another instruction file/skill. */
export interface SkillRef {
  readonly _ref: "skill";
  readonly path: VerifiedRef;
}

/** A typed symbol reference — the named file must define the named symbol. */
export interface SymbolRef {
  readonly _ref: "symbol";
  readonly file: VerifiedPath;
  readonly symbol: string;
}

/** A typed directory reference — verified to exist AND be a directory. */
export interface DirRef {
  readonly _ref: "dir";
  readonly path: VerifiedDir;
}

/** A typed glob reference — verified to match at least one path. */
export interface GlobRef {
  readonly _ref: "glob";
  readonly pattern: VerifiedGlob;
}

export type Ref = FileRef | CmdRef | SkillRef | SymbolRef | DirRef | GlobRef;

/**
 * Reference a file path — verified to exist at compile time.
 * When generated types are present, narrowed to known project files.
 */
export function file(path: NoInfer<StrictFile>): FileRef {
  return { _ref: "file", path: path as VerifiedPath };
}

/**
 * Reference a command — verified against package.json at compile time.
 * When generated types are present, narrowed to known npm scripts.
 */
export function cmd(command: NoInfer<StrictCmd>): CmdRef {
  return { _ref: "cmd", command: command as VerifiedCmd };
}

/**
 * Reference a symbol defined in a file — verified at compile time that the
 * named file exists AND defines the named symbol (via ast-grep, cross-language).
 * Compiles to the file-qualified inline form `` `file#symbol` `` so the markdown
 * `lint` / `refs-hook` re-verify the same reference.
 */
export function symbol(file: NoInfer<StrictFile>, name: string): SymbolRef {
  return { _ref: "symbol", file: file as VerifiedPath, symbol: name };
}

/**
 * Reference another skill or instruction file — verified to exist.
 * Compiles to a markdown link: [skill name](path)
 */
export function ref(path: string): SkillRef {
  return { _ref: "skill", path: path as VerifiedRef };
}

/**
 * Reference a directory — verified at compile time to exist AND be a directory
 * (not a file). The "architecture floats free" fix: a spec that names `src/core/`
 * proves the directory is really there, where a plain string in prose rots
 * silently. Compiles to the inline form `` `path` ``.
 */
export function dir(path: string): DirRef {
  return { _ref: "dir", path: path as VerifiedDir };
}

/**
 * Reference a glob pattern — verified at compile time to match at least one path,
 * so `glob("src/*.test.ts")` proves tests actually exist where the instructions
 * claim (the pattern supports the usual `*` / `**` syntax). Compiles to the
 * inline form `` `pattern` ``.
 */
export function glob(pattern: string): GlobRef {
  return { _ref: "glob", pattern: pattern as VerifiedGlob };
}

// ---------------------------------------------------------------------------
// Instruction template — process refs inside skill instructions
// ---------------------------------------------------------------------------

/**
 * A marked side-effect BOUNDARY inside a skill/agent body — "side effects are
 * allowed ONLY inside this block." Compiles to `<!-- vigiles:effect -->` …
 * `<!-- /vigiles:effect -->` markers the runtime PreToolUse gate keys on: outside
 * the region the unit is treated as read-only (the `"pure"` effective floor),
 * inside it the declared purity floor applies. The position-aware companion to
 * the per-call `purity` floor. See `research/effect-boundary-design.md`.
 *
 * @internal Experimental (parked P3) — NOT part of the frozen public surface;
 * may change or be removed without a major bump pre-1.0.
 */
export interface EffectRegion {
  readonly _ref: "effect";
  readonly body: InstructionFragment[];
}

export type InstructionFragment = string | Ref | EffectRegion;

/**
 * Tagged template literal for skill instructions with typed references.
 *
 *   prose`
 *     Check ${file("eslint.config.ts")} for rules.
 *     Run ${cmd("npm test")} to verify.
 *     See ${ref("skills/other/SKILL.md")} for format.
 *   `
 */
export function prose(
  strings: TemplateStringsArray,
  ...values: InstructionFragment[]
): InstructionFragment[] {
  const result: InstructionFragment[] = [];
  for (let i = 0; i < strings.length; i++) {
    if (strings[i]) result.push(strings[i]);
    if (i < values.length) result.push(values[i]);
  }
  return result;
}

/**
 * Tagged template literal marking a side-effect boundary — usable as an
 * interpolated fragment inside a body / `instructions\`\``:
 *
 *   prose`
 *     ## Apply
 *     ${effect`
 *       Side effects are allowed ONLY here:
 *       - write ${file("CHANGELOG.md")}
 *       - ${cmd("npm publish")}
 *     `}
 *   `
 *
 * Returns an `EffectRegion` fragment; `compile` wraps its rendered body in
 * `<!-- vigiles:effect -->` markers. Independent of the `doc()` authoring
 * surface — it does not block on it.
 *
 * @experimental Experimental (parked P3) — NOT part of the frozen public surface;
 * may change or be removed without a major bump pre-1.0.
 */
export function experimental_effect(
  strings: TemplateStringsArray,
  ...values: InstructionFragment[]
): EffectRegion {
  const body: InstructionFragment[] = [];
  for (let i = 0; i < strings.length; i++) {
    if (strings[i]) body.push(strings[i]);
    if (i < values.length) body.push(values[i]);
  }
  return { _ref: "effect", body };
}

// ---------------------------------------------------------------------------
// CLAUDE.md spec (#5 — conditional maxSectionLines)
// ---------------------------------------------------------------------------

/**
 * The purity an author DECLARES for a skill/agent — the floor `compile`
 * enforces against the tool contract (see `purityViolations` in
 * `core/effects.ts`). Mirrors the analysis `PurityLevel` for the two meaningful
 * rungs, so what you DECLARE and what `scan` REPORTS share one vocabulary:
 * - `"pure"`:    only read-only tools — no side effects at all.
 * - `"bounded"`: decidable side-effecting tools (Write, Edit, …) are allowed,
 *   but not `Bash` / unknown-effect / inherits-all (the unbounded cells).
 * - `"dangerously-unrestricted"`: the explicit escape hatch — no enforcement.
 *   Deliberately loud (cf. React's `dangerouslySetInnerHTML`) so opting OUT of
 *   the guardrail stands out in review. Omitting `purity` is the same
 *   (unenforced) default WITHOUT typing the loud word — you write it only when
 *   you mean to override a stricter level.
 */
export type AuthoredPurity = "pure" | "bounded" | "dangerously-unrestricted";

/** Known markdown instruction file targets. */
export type InstructionTarget = "CLAUDE.md" | "AGENTS.md" | (string & {}); // escape hatch for custom targets

export interface ClaudeSpec {
  readonly _specType: "claude";
  /**
   * Output filename(s). Defaults to "CLAUDE.md". Also used as the h1 heading.
   * Pass an array to compile one spec to multiple targets (e.g., CLAUDE.md + AGENTS.md).
   */
  readonly target?: InstructionTarget | InstructionTarget[];
  /** npm scripts / shell commands → descriptions. Verified against package.json. */
  readonly commands?: Record<string, string>;
  /** File paths → descriptions. Verified via existsSync. */
  readonly keyFiles?: Record<string, string>;
  /** Named prose sections — plain strings or tagged templates with file()/cmd()/ref(). */
  readonly sections?: Record<string, string | InstructionFragment[]>;
  /**
   * Maximum lines for a single named prose section. Overrides the generous
   * compile-time default (200 lines) that guards every section + agent section
   * against an egregious content dump — set a tighter number to enforce your own
   * house limit, or a larger one for an intentionally long section.
   */
  readonly maxSectionLines?: number;
  /**
   * Maximum estimated tokens for the compiled output (~4 chars per token).
   * Compile fails if exceeded. Matches ETH Zurich 2511.12884 finding that
   * files over ~300 lines / ~2000 tokens degrade agent task success.
   */
  readonly maxTokens?: number;
  /** Rules: enforce(), check(), or guidance(). */
  readonly rules: Record<string, Rule>;
}

/**
 * Input type for instructionFile() — maxSectionLines is only valid when sections are provided.
 * TypeScript errors if you set maxSectionLines without defining sections.
 */
type ClaudeSpecBase = {
  readonly target?: InstructionTarget | InstructionTarget[];
  readonly commands?: Record<string, string>;
  readonly keyFiles?: Record<string, string>;
  readonly maxTokens?: number;
  readonly rules: Record<string, Rule>;
};

type ClaudeSpecSections =
  | {
      readonly sections: Record<string, string | InstructionFragment[]>;
      readonly maxSectionLines?: number;
    }
  | { readonly sections?: undefined; readonly maxSectionLines?: never };

type ClaudeSpecInput = ClaudeSpecBase & ClaudeSpecSections;

/**
 * Define a CLAUDE.md specification.
 *
 *   // CLAUDE.md.spec.ts
 *   export default instructionFile({ commands: {...}, rules: {...} });
 */
export function instructionFile(spec: ClaudeSpecInput): ClaudeSpec {
  return { _specType: "claude", ...spec } as ClaudeSpec;
}

// ---------------------------------------------------------------------------
// SKILL.md spec
// ---------------------------------------------------------------------------

/**
 * A deterministic gate on a skill step or its final result. A gate is one of:
 * a command (exit 0), a file (must exist), or a *project role* that resolves to
 * the host project's real command at run time. cmd/file gates are verified
 * against the repo at author time; role gates are portable — a skill that runs
 * in other repos should prefer `project("test")` over a hard-coded `npm test`.
 */
export type Gate = CmdRef | FileRef | RoleGate;

/** Project command roles, resolved per host project at run time. */
export type ProjectRole = "test" | "build" | "lint";

/** A portable gate that resolves to the host project's command for a role. */
export interface RoleGate {
  readonly _ref: "role";
  readonly role: ProjectRole;
}

/**
 * A portable gate that resolves to the host project's command for a role
 * (e.g. `project("test")` → `npm test` / `pytest` / `cargo test`). Use this
 * in skills meant to run across projects, instead of hard-coding a command.
 */
export function project(role: ProjectRole): RoleGate {
  return { _ref: "role", role };
}

/**
 * A declared skill input. Compiles to the `argument-hint` frontmatter and a
 * `## Arguments` section; referenced as `$1`/`$2`/`$ARGUMENTS` in the body.
 */
export interface SkillInput {
  /** Argument name, e.g. "pattern". */
  readonly name: string;
  /** Human-readable hint shown in argument-hint and the Arguments section. */
  readonly hint: string;
  /** Required by default; set false to render as optional (`[<name>]`). */
  readonly required?: boolean;
}

/** One step of a gated skill pipeline. */
export interface SkillStep {
  /** What the model should do — prose, optionally with typed refs. */
  readonly do: string | InstructionFragment[];
  /** Deterministic check that must pass before advancing to the next step. */
  readonly gate?: Gate;
  /** Max attempts to satisfy the gate before the step fails (default 1). */
  readonly retry?: number;
}

/**
 * Declare a skill input (compiles to argument-hint + an Arguments entry).
 *
 * Deliberately NOT a standalone export — reached as `experimental_skill.input`.
 * The reason is on `experimental_skill` below.
 */
function input(
  name: string,
  hint: string,
  opts: { required?: boolean } = {},
): SkillInput {
  // 🔴 The types say `string`, and for a USER's spec nothing enforces that: `vigiles compile`
  // loads `.spec.ts` through tsx, which transpiles and erases types without checking them.
  // (vigiles's OWN specs are cross-checked by a separate `tsc --noEmit` over a generated
  // registry — that safety net does not travel to the people compiling their own specs.)
  //
  // Measured 2026-08-17: calling `input({ name, description })` — the object form a reader
  // reasonably guesses — compiled with NO error and wrote this into the shipped SKILL.md:
  //
  //     argument-hint: <[object Object]>
  //     - `$1` **[object Object]** — undefined
  //
  // A wrong call became a wrong file, silently. Refusing here makes the mistake loud at the
  // moment it is made, and the message carries the real signature because "expected string"
  // alone does not tell the caller what to write instead.
  const bad = (v: unknown) => typeof v !== "string" || v.trim() === "";
  if (bad(name) || bad(hint)) {
    throw new TypeError(
      `input() takes two strings: input(name, hint, opts?) — e.g. input("pattern", "regex to search for").\n` +
        `  got name=${JSON.stringify(name)}, hint=${JSON.stringify(hint)}`,
    );
  }
  return { name, hint, required: opts.required };
}

/**
 * Declare a gated pipeline step.
 *
 * Deliberately NOT a standalone export — reached as `experimental_skill.step`.
 */
function step(
  instr: string | InstructionFragment[],
  opts: { gate?: Gate; retry?: number } = {},
): SkillStep {
  return { do: instr, gate: opts.gate, retry: opts.retry };
}

export interface SkillSpec {
  readonly _specType: "skill";
  /** Skill name (used in frontmatter). */
  readonly name: string;
  /** Short description (used in frontmatter). */
  readonly description: string;
  /**
   * Hint for the argument (frontmatter). Ignored when `inputs` is set —
   * `inputs` derive the argument-hint instead.
   */
  readonly argumentHint?: string;
  /** Typed inputs — compile to argument-hint + a `## Arguments` section. */
  readonly inputs?: readonly SkillInput[];
  /** Whether to disable model invocation (frontmatter flag). */
  readonly disableModelInvocation?: boolean;
  /**
   * Execution context. `"fork"` runs the skill's body as the task inside a
   * forked SUBAGENT (its own context window) instead of inline in the main
   * conversation (Anthropic's `context: fork` frontmatter). This is the ONLY
   * setting under which a skill gains a real call→return boundary — so it's the
   * prerequisite for declaring an `output` Result contract (see `output`). Omit
   * for the default inline execution.
   */
  readonly context?: "fork";
  /**
   * The allowed-tools contract for this skill. Each entry must be a known
   * built-in tool or an MCP tool (`mcp__server__tool`). Omit to inherit all
   * tools. When `purity` is `"pure"`/`"bounded"`, the declared tools are checked
   * against that floor — compile rejects a tool looser than the declared level.
   */
  readonly tools?: readonly string[];
  /**
   * Tools this skill may NEVER use — rendered to the `disallowed-tools:`
   * frontmatter key (hyphenated for skills; a subagent's key is `disallowedTools:`,
   * and they are read by different parsers, so the spelling is not interchangeable).
   *
   * 🔴 This is NOT the symmetric twin of `tools` and the asymmetry is the whole
   * reason it exists. `allowed-tools:` on a skill is a PRE-APPROVAL — it waives the
   * permission prompt for what it lists and removes nothing from the pool, so a
   * skill that declares only `Read` can still call `Bash`. `disallowed-tools:` is
   * the only key measured to actually take a tool away. A skill without it inherits
   * every tool the session grants, which is why `audit` reports each such skill as
   * holding all three lethal-trifecta legs — including skills whose `tools` list
   * looks tightly scoped.
   *
   * Entries are checked like a subagent's: a close typo of a real tool name blocks
   * nothing and is reported, because a fence with a misspelled name reads as
   * protection while granting everything.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * Declare this skill's purity floor — compile rejects a tool contract looser
   * than it. `"pure"` allows only read-only tools; `"bounded"` also allows
   * decidable side-effecting tools (Write, Edit, …) but bars `Bash` /
   * unknown-effect / inherits-all; `"dangerously-unrestricted"` (or omitting it)
   * enforces nothing. NOTE: `"pure"`/`"bounded"` require an explicit read-only
   * `tools` list — an absent list inherits ALL tools and is a violation.
   */
  readonly purity?: AuthoredPurity;
  /**
   * Gated pipeline steps. When set, the skill compiles to a `## Steps`
   * checklist with a deterministic gate per step. Use this OR `body`.
   */
  readonly steps?: readonly SkillStep[];
  /**
   * Terminal postcondition — the skill is "done" only when this gate passes.
   * Compiles to a `## Result` section + a `vigiles:result` marker.
   *
   * 🔴 NAMED `postcondition`, NOT `result`, because `result` already means
   * something else one screen down: {@link result} builds a subagent's typed
   * ok/err CONTRACT (and reaches a skill through `output:`). Two concepts under
   * one word, told apart only by whether you wrote `result:` or `output:
   * result(...)` — the doc comment on {@link result} had to spend a line saying
   * "distinct from a skill's `result:` postcondition gate", which is the tell.
   * A name that needs a disambiguating sentence is the wrong name.
   *
   * The compiled MARKER stays `vigiles:result` deliberately: it is the wire
   * format between the compiler and {@link parseSkillGates}, and every already
   * compiled SKILL.md on disk carries it. Renaming the authoring field is a
   * source-level change; renaming the marker would invalidate stamps.
   */
  readonly postcondition?: Gate;
  /**
   * @deprecated Renamed to {@link SkillSpec.postcondition}. Removed next
   * major. Measured 2026-08-21: 0 of 46 specs in the consuming knowledge base
   * set this field, so the window costs nothing and closes the collision above.
   */
  readonly result?: Gate;
  /**
   * The skill's typed railway outcome — the SAME `Result<ok, err>` contract a
   * subagent declares with `result(okShape, errShape)`. Valid ONLY with
   * `context: "fork"`: a forked skill runs as a subagent, so it has the
   * call→return boundary a typed outcome needs (compile errors if `output` is set
   * without `context: "fork"`). When valid, compiles to a `## Output contract`
   * with a `vigiles:ok` / `vigiles:err` block — parseable (`parseAgentResult`) and
   * testable (`assertAgentOk`) via the existing subagent rail. An INLINE skill has
   * no return, so a typed outcome there is a category error — hence the gate. See
   * `research/spec-syntax-and-railway-scope.md`.
   */
  readonly output?: OutputContract;
  /** Freeform instruction body (linear/unstructured skills). Use this OR `steps`. */
  readonly body?: string | InstructionFragment[];
  /**
   * Max lines for an inline fenced code block before compilation errors,
   * forcing the script into a file referenced via `file()` (default 20).
   * Keeps big scripts out of the skill body (token budget + progressive
   * disclosure). Set 0 to disable.
   */
  readonly maxInlineCodeLines?: number;
}

/**
 * The input to `skill()` — `SkillSpec` minus `_specType`, with `tools`
 * constrained by the declared `purity` and vocabulary `V` (same mechanism as
 * `AgentSpecInput`). The open default vocabulary leaves it unconstrained.
 */
export type SkillSpecInput<
  P extends AuthoredPurity | undefined,
  V extends ToolVocabulary,
> = Omit<SkillSpec, "_specType" | "tools" | "purity"> & {
  readonly purity?: P;
  readonly tools?: readonly AllowedAt<P, V>[];
};

/**
 * Define a SKILL.md specification.
 *
 *   // skills/my-skill/SKILL.md.spec.ts
 *   export default experimental_skill({ name: "my-skill", description: "…" });
 *
 * Generic over a tool `Vocabulary` (default `OpenToolVocabulary` — no
 * constraint), exactly like `experimental_agent()`: a vocabulary-bound `experimental_skill`
 * (e.g. `vigiles/claude-code`) makes `purity: "pure"` + a side-effecting tool a
 * `tsc` error; the bare core one accepts any tools, as before.
 *
 * The name also disambiguates: `vigiles/testing` exports a `skill()` that is a
 * DIFFERENT function — a `Check<Trace>` taking an id string, asking whether a
 * skill fired. This one authors a skill; that one observes one.
 *
 * Its helper vocabulary hangs off it — `experimental_skill.input(…)` and
 * `experimental_skill.step(…)` — rather than being exported beside it. Both are
 * used ONLY by skill specs (measured: zero uses in agent/claude specs, against
 * `cmd`/`file`/`ref`/`result`, which are shared and therefore stay top-level).
 * Hanging them here makes the experimental marking STRUCTURAL for the whole
 * family: you cannot reach `input()` without naming `experimental_skill` first.
 * The prefix convention alone could not do that — it is a habit, and it had
 * already leaked once when `skill()` shipped stable-named against its own docs.
 *
 * Honest limit: `const { input } = experimental_skill` strips the marker again
 * inside one file. What the shape actually guarantees is narrower and still
 * worth having — an unmarked name never crosses the package boundary.
 *
 * `Object.assign` rather than `export namespace`: the latter is banned by this
 * repo's own lint (`no-namespace: error`, inherited from strict-type-checked).
 *
 * @experimental
 */
function skillSpec<
  const P extends AuthoredPurity | undefined = undefined,
  V extends ToolVocabulary = OpenToolVocabulary,
>(spec: SkillSpecInput<P, V>): SkillSpec {
  // The deprecated `result:` is folded into `postcondition:` by the shared
  // helper — see `skill-normalize.ts` for why it is shared rather than inlined
  // here (short version: this builder is not the only public entrance, and the
  // other one silently dropped the gate until a reviewer noticed).
  return foldLegacyPostcondition({ _specType: "skill", ...spec } as SkillSpec);
}

/**
 * @experimental
 */
export const experimental_skill = Object.assign(skillSpec, { input, step });

// ---------------------------------------------------------------------------
// Subagent specs
// ---------------------------------------------------------------------------

/**
 * A subagent definition (compiles to `agents/<name>.md`). Unlike a skill —
 * reference material the model reads on activation — a subagent is a *delegated
 * worker with a contract*: a dispatch `description`, an allowed-`tools` rail, an
 * optional `model`, a system-prompt `body`, and the `rules` it must follow. That
 * tool contract + those rules are the "railway" a subagent runs on, and they're
 * exactly the compile-time-verifiable surface vigiles owns: the body's
 * `file()`/`cmd()`/`symbol()` marks are checked like any instruction file, and
 * the tools list is verified against the real tool set.
 */
export interface AgentSpec {
  readonly _specType: "agent";
  /** Subagent name (frontmatter + dispatch handle). */
  readonly name: string;
  /** When to dispatch this subagent — the trigger (frontmatter). */
  readonly description: string;
  /** Model alias (e.g. "sonnet", "opus", "haiku", "inherit"). Optional. */
  readonly model?: string;
  /** Subagent UI colour (Claude Code frontmatter, e.g. "pink", "blue"). Optional. */
  readonly color?: string;
  /**
   * The allowed-tools contract — the rails the worker runs on. Each entry must be
   * a known built-in tool (Read/Write/Edit/Bash/Grep/Glob/WebSearch/WebFetch/
   * NotebookEdit/TodoWrite/Task/Skill) or an MCP tool (`mcp__server__tool`).
   * Omit to inherit all tools. Verified at compile time.
   */
  readonly tools?: readonly string[];
  /**
   * The DENY-side contract — tools the worker may NOT use. Use this INSTEAD OF
   * `tools`, not with it: `tools` is an allowlist (only these), so a tool not
   * listed is already unavailable and a `disallowedTools` entry would be
   * redundant. `disallowedTools` earns its place only when there's NO allowlist
   * (the agent inherits ALL tools) and you want to subtract a few — e.g.
   * `disallowedTools: ["Bash"]` on an otherwise-unrestricted worker. Rendered to
   * the `disallowedTools:` frontmatter; close-typos are flagged (a typo'd entry
   * blocks nothing). For a read-only floor prefer a tight `tools` list + `purity`.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * The lead/intro prose of the system prompt (the "You are…" opener), before any
   * sections. Carries verified `file()`/`cmd()`/`symbol()`/`ref()` marks. No
   * markdown headers — use `sections` for those.
   */
  readonly body?: string | InstructionFragment[];
  /**
   * Named `##` sections of the system prompt (e.g. Purpose, Core Principles,
   * Capabilities) — the shape real subagents actually take. Same verified-ref +
   * no-nested-`##` rules as a CLAUDE.md spec's sections. Use `body` for the intro
   * and `sections` for the structured rest.
   */
  readonly sections?: Record<string, string | InstructionFragment[]>;
  /** Rules the worker must follow — rendered as a `## Rules` section. */
  readonly rules?: Record<string, Rule>;
  /**
   * The typed result contract — what this worker returns on success/error. When
   * set, compiles to an `## Output contract` section instructing the worker to
   * end with a `vigiles:ok` / `vigiles:err` block, so its outcome is parseable
   * and testable (see `result()`, `parseAgentResult`, `assertAgentOk`).
   */
  readonly output?: OutputContract;
  /**
   * Declare this agent's purity floor — compile rejects a tool contract looser
   * than it. `"pure"` allows only read-only tools; `"bounded"` also allows
   * decidable side-effecting tools (Write, Edit, …) but bars `Bash` /
   * unknown-effect / inherits-all; `"dangerously-unrestricted"` (or omitting it)
   * enforces nothing. `"pure"`/`"bounded"` require an explicit `tools` list — a
   * wildcard or absent-tools (inherits-all) is always a violation.
   */
  readonly purity?: AuthoredPurity;
}

/**
 * The input to `experimental_agent()` — `AgentSpec` minus the internal `_specType`, with the
 * `tools` list constrained by the declared `purity` and the tool vocabulary `V`.
 * `P` is inferred from the literal `purity` field (`const` inference), and
 * `tools` is then typed `AllowedAt<P, V>[]`:
 * - `purity: "pure"`   → `tools` may list only `V["readOnly"]` tools.
 * - `purity: "bounded"`→ `tools` may list `V["bounded"]` tools (admits `Bash`).
 * - no `purity` / `"dangerously-unrestricted"` → `tools` is `string[]` (open).
 *
 * With the open default vocabulary (core `experimental_agent()`) every level widens to
 * `string`, so any tools compile — backwards-compatible.
 */
export type AgentSpecInput<
  P extends AuthoredPurity | undefined,
  V extends ToolVocabulary,
  Ok extends Shape = Shape,
  Err extends Shape = Shape,
> = Omit<AgentSpec, "_specType" | "tools" | "purity" | "output"> & {
  readonly purity?: P;
  readonly tools?: readonly AllowedAt<P, V>[];
  /** The typed result contract — `result(ok, err)`. Its literal field shapes are
   *  captured into the returned `TypedAgentSpec` so a typed `pipe` can check them. */
  readonly output?: OutputContract<Ok, Err>;
};

// ---------------------------------------------------------------------------
// Typed composition carrier (additive — the typed half of railway composition)
//
// `experimental_agent()` returns `AgentSpec` (every existing consumer reads that). To ALSO
// remember the agent's result SHAPE at the type level — so a typed `pipe` can
// cross-reference one step's `ok` against the next step's needs — the return is
// the SAME `AgentSpec` intersected with a PHANTOM carrier of the ok/err shapes.
// The phantom field is `declare`-only (a unique symbol), so it never exists at
// runtime and never changes the value; an `AgentSpec & TypedOutcome<Ok, Err>` is
// still assignable to `AgentSpec`, so nothing downstream breaks. This is the
// shallow encoding TS2589 demands: the shapes ride on one phantom property, not
// a recursive type, so inference stays flat.
// ---------------------------------------------------------------------------

declare const __outcome: unique symbol;

/** Phantom carrier of an agent's success/error result shapes (type-level only). */
export interface TypedOutcome<Ok extends Shape, Err extends Shape> {
  readonly [__outcome]: { readonly ok: Ok; readonly err: Err };
}

/** An `AgentSpec` that REMEMBERS its `result()` ok/err shapes at the type level
 *  (via a phantom field). Still an `AgentSpec`, so it flows everywhere one does.
 *  The input to a typed `pipe` / `then`. */
export type TypedAgentSpec<Ok extends Shape, Err extends Shape> = AgentSpec &
  TypedOutcome<Ok, Err>;

/**
 * Extract a typed agent's success (`result().ok`) SHAPE at the type level. The
 * phantom `__outcome` symbol is module-private, so this is the exported reader
 * the whole-harness registry uses: `OkOf<typeof registry["planner"]>` is the
 * literal `ok` shape `planner` produces, the producer side of a cross-file
 * `Handoff<>` check. A plain `AgentSpec` (no `result()` contract) carries no
 * phantom, so `OkOf` widens to the erased `Shape` — a no-op handoff, additive.
 */
export type OkOf<T> = T extends TypedOutcome<infer Ok, Shape> ? Ok : Shape;

/**
 * Define a subagent specification (compiles to `agents/<name>.md`).
 *
 *   // agents/reviewer.md.spec.ts
 *   export default experimental_agent({
 *     name: "reviewer",
 *     description: "Review a diff for correctness. Dispatch PROACTIVELY after edits.",
 *     model: "sonnet",
 *     tools: ["Read", "Grep", "Bash"],
 *     body: prose`Review the diff. Run ${cmd("npm test")} first.`,
 *     rules: {
 *       "no-floating": enforce("@typescript-eslint/no-floating-promises", "Await promises."),
 *     },
 *   });
 *
 * Generic over a tool `Vocabulary` (default `OpenToolVocabulary` — no
 * constraint). A harness adapter re-exports a vocabulary-bound `agent` (e.g.
 * `vigiles/claude-code`) so `purity: "pure"` + a side-effecting tool is a `tsc`
 * error at edit time; the bare core `experimental_agent()` accepts any tools, as before.
 *
 * Also generic over the result's `Ok`/`Err` shapes, inferred from `output:
 * result(...)`. The returned value is a `TypedAgentSpec<Ok, Err>` — an
 * `AgentSpec` that carries those shapes at the type level, so a typed `pipe`
 * can cross-reference the handoff. With no `output` the shapes default to the
 * erased `Shape`, and the value is still a plain `AgentSpec` — backwards-compatible.
 *
 * @experimental The SHAPE is not settled — the author is unsure of the design,
 * which is exactly what this marker promises: the form may change. It is NOT a
 * claim that the surface is unproven. Measured 2026-06-20: real Claude Code
 * loaded a compiled `agents/code-reviewer.md`, dispatched to it and read it,
 * 100% of trials — stronger end-to-end evidence than `experimental_skill` has.
 */
function agentSpec<
  const P extends AuthoredPurity | undefined = undefined,
  V extends ToolVocabulary = OpenToolVocabulary,
  Ok extends Shape = Shape,
  Err extends Shape = Shape,
>(spec: AgentSpecInput<P, V, Ok, Err>): TypedAgentSpec<Ok, Err> {
  return { _specType: "agent", ...spec } as AgentSpec as TypedAgentSpec<
    Ok,
    Err
  >;
}

// ---------------------------------------------------------------------------
// Subagent result contract + railway composition (railway-oriented subagents)
//
// A subagent is a flat worker, but instead of returning prose it returns a
// typed Result — either success or error, with rich detail on BOTH tracks. A
// `railway()` then composes flat workers: the success track flows worker→worker,
// and the first error short-circuits to an error handler. This is Wlaschin's
// railway-oriented programming with a subagent as the step. It is deliberately
// sub-Turing — a finite list of steps + a bounded recovery, no loop/iterator
// combinator — so termination is readable off the value and every reference is
// statically checkable (the thing ultraplan's generated script can't be). See
// research/railway-subagents.md and research/subagent-compilation.md.
// ---------------------------------------------------------------------------

/**
 * The field types a result contract can declare (kept tiny + dependency-free).
 *
 * The literal-array member is an ENUM: `["CUT", "MERGE", "KEEP"] as const` declares a
 * field whose value must be one of those strings. It is the ONLY extension to this union,
 * and it was added because a measured failure had no other cure: across 14 real payloads
 * a `verdict: "string"` field held 3 mutually incomparable invented categories over 3
 * runs, and vocabulary compliance was 3/19 — 16%. `string` cannot express "one of these",
 * so nothing downstream could notice.
 *
 * Nothing RELATIONAL follows it — no `object[]`, no tuples, no per-element enums.
 * Declaring one throws rather than rendering an unsatisfiable schema, because the body of
 * a result is prose by decision: on those same 14 payloads, 23 scalar values carried
 * every assertion anyone made while 80,981 characters of prose carried none.
 */
export type OutputFieldType =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  // An enum: the permitted values, as a non-empty readonly tuple of literals.
  | readonly [string, ...string[]];

/** A field SHAPE — a record of field-name → field-type, kept in the TYPE so a
 *  typed pipeline can cross-reference one agent's `ok` against the next agent's
 *  `needs`. The erased runtime form is `Record<string, OutputFieldType>`. */
export type Shape = Readonly<Record<string, OutputFieldType>>;

/**
 * A subagent's typed result contract: the shape it must return on success
 * (`ok`) and on failure (`err`). Rich on both tracks — an error is structured
 * detail, not a bare pass/fail bit. Compiles into the worker's system prompt
 * (the `vigiles:ok` / `vigiles:err` block it must emit) and is the schema the
 * `parseAgentResult` parser + the `assertAgentOk/Err` test helpers validate.
 *
 * Generic over its `ok`/`err` field shapes so a typed value REMEMBERS them at
 * the type level (the basis of typed composition — see `pipe`). The default
 * type parameters widen to the historical erased `Shape`, so an `OutputContract`
 * named with no arguments behaves exactly as before — backwards-compatible.
 */
export interface OutputContract<
  Ok extends Shape = Shape,
  Err extends Shape = Shape,
> {
  readonly _ref: "output";
  readonly ok: Ok;
  readonly err: Err;
}

/**
 * Declare a subagent's success/error result contract.
 *
 *   result(
 *     { files: "string[]", summary: "string" },          // rich success
 *     { reason: "string", retryable: "boolean" },         // rich error
 *   )
 *
 * (Distinct from a skill's `result:` postcondition gate — this types a
 * subagent's *return value*, the success/error tracks of the railway.)
 *
 * The literal field shapes are PRESERVED in the return type (`const` inference),
 * not erased to `Record<string, OutputFieldType>` — this is what lets `pipe`
 * cross-reference one agent's `ok` against the next agent's needs at `tsc` time.
 * The return is still an `OutputContract`, so every existing consumer (the
 * `output:` field, `renderOutputContract`, `parseAgentResult`) is unchanged.
 
 */
function result<const Ok extends Shape, const Err extends Shape>(
  ok: Ok,
  err: Err,
): OutputContract<Ok, Err> {
  return { _ref: "output", ok, err };
}

/** One step on a railway: dispatch a flat subagent (the "activity"). */
export interface RailwayStep {
  readonly _step: "delegate";
  /** The subagent to dispatch — resolved against compiled agent names. */
  readonly agent: string;
  /** Optional task hint passed to the worker. */
  readonly task?: string;
  /**
   * Optional input contract the step reads from its predecessor's `result().ok`.
   * When present, the whole-harness registry (`generate-harness`) emits a
   * per-edge `Handoff<>` assertion so a CROSS-FILE handoff mismatch (a missing
   * field or wrong type vs the prior step's `ok`) is a `tsc` error naming the
   * field. Absent `needs` = no handoff check (today's behavior, the string-path
   * backstop). Built by `needs(...)`, the same builder a typed `pipeStep` uses.
   */
  readonly needs?: Shape;
}

/**
 * Build a railway step that dispatches `agent`.
 *
 *   delegate("planner")                                  // no task, no handoff
 *   delegate("implementer", "implement the plan")        // task hint only
 *   delegate("reviewer", undefined, needs({ diff: "string" }))  // + handoff check
 *
 * The optional 3rd argument carries the step's input `needs` (built by
 * `needs(...)`). When present, the whole-harness registry asserts that the
 * PREVIOUS success-track step's `result().ok` SUPPLIES it — a cross-file
 * handoff that doesn't line up is a `tsc` error naming the offending field.
 * Omitting it (the historical 1-/2-arg call) keeps the exact string-path
 * behavior — fully backwards-compatible.
 
 */
function delegate(
  agent: string,
  task?: string,
  needsContract?: Shape,
): RailwayStep {
  const base: RailwayStep =
    task === undefined
      ? { _step: "delegate", agent }
      : { _step: "delegate", agent, task };
  return needsContract === undefined ? base : { ...base, needs: needsContract };
}

/**
 * A railway over flat subagents. `steps` run in order on the success track; the
 * first step that returns an error short-circuits to `onError`. `recover`
 * optionally retries the failing step a *bounded* number of times before the
 * error track. There is intentionally no loop combinator — the value is a finite
 * tree, so it always terminates and is fully verifiable at compile time.
 */
export interface Railway {
  readonly _specType: "railway";
  readonly name: string;
  readonly steps: readonly RailwayStep[];
  /** Error track — runs with the failing step's error payload. */
  readonly onError?: RailwayStep;
  /** Bounded recovery: retry the failing step up to `max` times (finite). */
  readonly recover?: { readonly step: RailwayStep; readonly max: number };
}

/**
 * Compose flat subagents into a railway (compiles to an orchestrator command).
 *
 *   railway({
 *     name: "ship",
 *     steps: [delegate("planner"), delegate("coder"), delegate("reviewer")],
 *     onError: delegate("reporter"),
 *     recover: { step: delegate("fixer"), max: 2 },
 *   })
 
 */
function railway(spec: Omit<Railway, "_specType">): Railway {
  return { _specType: "railway", ...spec };
}

// ---------------------------------------------------------------------------
// Typed composition — "your multi-agent pipeline doesn't compile if the
// handoffs don't line up."
//
// The string-based `railway({ steps: [delegate("name"), …] })` above resolves
// delegate targets by NAME at COMPILE time (a value-level cross-reference). It
// cannot check DATA handoffs: a string name carries no type, so the producer's
// `result()` shape is invisible to the consumer. Typed composition is the
// ADDITIVE second path: `pipe(a, b, c)` references the agent OBJECTS (which now
// carry their `ok`/`err` shapes via `TypedAgentSpec`), so the compiler verifies
// that step N's `ok` SUPPLIES step N+1's `needs` — a missing field, a type
// mismatch, or an out-of-order step is a `tsc` error naming the offending field.
//
// The check is expressed as a SHALLOW conditional (`Supplies`) keyed per field —
// no recursive type walk — to stay clear of TS2589 ("excessively deep"). The
// chain is left-folded so each link checks exactly one handoff.
//
// This is a strict addition: it does not touch `delegate`/`railway`/
// `compileRailway`/`validateRailway`, which remain the string-path backstop.
// ---------------------------------------------------------------------------

/**
 * A subagent's INPUT contract — the fields it reads from the prior step's `ok`.
 * Declared via `needs(...)` and threaded into the typed agent so `pipe` can
 * cross-reference it. Independent of `result()` (the output) — an agent both
 * `needs` an input shape and produces an `ok`/`err` output shape.
 *
 * @internal Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 */
export type NeedsContract<N extends Shape> = N;

/**
 * Declare the input fields a step reads from its predecessor's success payload.
 * Pass it as `needs:` on a typed pipeline step. `needs({})` (the default) is a
 * step with no upstream requirement — valid as the FIRST step of a pipeline.
 *
 *   needs({ plan: "string", files: "string[]" })
 *
 * @experimental Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 
 */
function experimental_needs<const N extends Shape>(shape: N): NeedsContract<N> {
  return shape;
}

/**
 * A typed pipeline step: a `TypedAgentSpec` paired with the input `needs` it
 * reads from the prior step's `ok`. `step()` builds one; `pipe` checks that the
 * prior step's `ok` shape supplies this step's `needs`.
 *
 * @internal Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 */
export interface PipeStep<
  Needs extends Shape,
  Ok extends Shape,
  Err extends Shape,
> {
  readonly _step: "typed-delegate";
  readonly agent: TypedAgentSpec<Ok, Err>;
  readonly needs: Needs;
}

/**
 * Pair a typed agent with the input it `needs` from the previous step. The first
 * argument is an `experimental_agent()` VALUE (which carries its `result()` shape); the
 * second is the `needs(...)` input contract.
 *
 *   pipeStep(implementer, needs({ plan: "string", files: "string[]" }))
 *
 * @experimental Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 
 */
function experimental_pipeStep<
  Needs extends Shape,
  Ok extends Shape,
  Err extends Shape,
>(
  a: TypedAgentSpec<Ok, Err>,
  needsContract: Needs = {} as Needs,
): PipeStep<Needs, Ok, Err> {
  return { _step: "typed-delegate", agent: a, needs: needsContract };
}

/**
 * True iff `Producer` provides EVERY field `Consumer` needs, with matching
 * field types. When satisfiable it is `true`; otherwise it collapses to a
 * descriptive error object naming the offending field (`__missing` /
 * `__mismatch`), which surfaces at the mismatched call. Shallow (a per-field
 * mapped type, not a recursion) to avoid TS2589.
 *
 * @internal Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 */
export type Supplies<Producer extends Shape, Consumer extends Shape> = {
  [K in keyof Consumer]: K extends keyof Producer
    ? Producer[K] extends Consumer[K]
      ? true
      : {
          readonly __mismatch: K;
          readonly expected: Consumer[K];
          readonly got: Producer[K];
        }
    : { readonly __missing: K; readonly required: Consumer[K] };
}[keyof Consumer];

/**
 * Per-edge CROSS-FILE handoff check — the registry-scale form of `Supplies<>`,
 * mirroring `KnownAgentName` (the dangling-delegate per-edge check). `Producer`
 * is the prior success-track step's `result().ok` shape (read off the registry
 * via `OkOf`); `Consumer` is THIS step's `needs(...)` input contract. Collapses
 * to `true` when the producer supplies every field the consumer needs (matching
 * types), else to a descriptive error object naming the offending field
 * (`__handoff_error` wrapping `Supplies`'s `__missing`/`__mismatch`), so
 * assigning `true` to it is a `tsc` error at edit time. Shallow (one wrap over
 * the per-field `Supplies` mapped type, no recursion); the generator emits one
 * assertion per consecutive step pair (O(N)), keeping clear of TS2589.
 *
 * @internal Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 */
export type Handoff<Producer extends Shape, Consumer extends Shape> =
  Supplies<Producer, Consumer> extends true
    ? true
    : { readonly __handoff_error: Supplies<Producer, Consumer> };

/** A typed pipeline value — carries the LAST step's `ok` and the UNION of every
 *  step's `err` (any step can short-circuit to the error track).
 *  @internal Experimental typed-composition surface — NOT part of the frozen
 *  public API (pre-1.0); may change without a major bump. */
export interface Pipeline<Ok extends Shape, Err extends Shape> {
  readonly _specType: "pipeline";
  /** Ordered agent names — the resolved compose order. */
  readonly agents: readonly string[];
  /** The final step's success shape. */
  readonly ok: Ok;
  /** The union of every step's error shape. */
  readonly err: Err;
  /** The underlying string-path railway, for `compileRailway` reuse. */
  readonly railway: Railway;
}

/**
 * Begin a typed pipeline from its first step. The first step has no upstream, so
 * its `needs` must be empty (`needs({})` or omitted). Returns a `Pipeline`
 * carrying that step's `ok`/`err` forward.
 *
 * @experimental Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 
 */
function experimental_start<Ok extends Shape, Err extends Shape>(
  first: PipeStep<Record<string, never>, Ok, Err> | TypedAgentSpec<Ok, Err>,
): Pipeline<Ok, Err> {
  const step =
    "_step" in first
      ? first
      : experimental_pipeStep(first, {} as Record<string, never>);
  const out = step.agent.output;
  return {
    _specType: "pipeline",
    agents: [step.agent.name],
    ok: (out ? out.ok : {}) as Ok,
    err: (out ? out.err : {}) as Err,
    railway: railway({
      name: step.agent.name,
      steps: [delegate(step.agent.name)],
    }),
  };
}

/**
 * Append a step to a typed pipeline. The handoff is CHECKED: the constraint
 * `Supplies<PriorOk, Needs>` must be `true`, else the `next` parameter's type
 * collapses to a `__HANDOFF_ERROR` object and `tsc` rejects the call, naming the
 * missing/mismatched field. Carries the new step's `ok` forward and accumulates
 * the error track. Shallow per-call check — no recursive chain type.
 *
 * Named `andThen` (Wlaschin's railway `bind`/`andThen`), NOT `then`: a module
 * exporting a function called `then` becomes a thenable, so `await import()` of
 * any barrel re-exporting it would invoke it — a footgun the rename avoids.
 *
 * @experimental Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 
 */
function experimental_andThen<
  PriorOk extends Shape,
  PriorErr extends Shape,
  Needs extends Shape,
  Ok extends Shape,
  Err extends Shape,
>(
  prior: Pipeline<PriorOk, PriorErr>,
  next: Supplies<PriorOk, Needs> extends true
    ? PipeStep<Needs, Ok, Err>
    : { readonly __HANDOFF_ERROR: Supplies<PriorOk, Needs> },
): Pipeline<Ok, PriorErr | Err> {
  const real = next as PipeStep<Needs, Ok, Err>;
  const out = real.agent.output;
  const rw = railway({
    name: prior.railway.name,
    steps: [...prior.railway.steps, delegate(real.agent.name)],
  });
  return {
    _specType: "pipeline",
    agents: [...prior.agents, real.agent.name],
    ok: (out ? out.ok : {}) as Ok,
    err: (out ? out.err : {}) as PriorErr | Err,
    railway: rw,
  };
}

/**
 * Compose a typed pipeline in one call — the ergonomic form of
 * `andThen(andThen(start(a), b), c)`. Each adjacent handoff is checked
 * left-to-right: the FIRST step is the producer, the rest are
 * `pipeStep(agent, needs(...))` consumers, and the compiler rejects the whole
 * expression if ANY handoff's producer `ok` does not supply the consumer's
 * `needs` (variadic chains hit TS2589 quickly, so `pipe` is a fixed set of
 * overloads over the shallow `start`/`andThen` fold rather than a recursive
 * variadic type — keep chains to a handful of steps; for longer ones, fold
 * `andThen` explicitly).
 *
 *   pipe(
 *     planner,                                              // produces ok
 *     pipeStep(implementer, needs({ plan: "string", files: "string[]" })),
 *     pipeStep(reviewer, needs({ diff: "string" })),
 *   ) // ← won't compile if a handoff doesn't line up
 *
 * @experimental Experimental typed-composition surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 */
/* eslint-disable no-redeclare -- TypeScript function overloads (the base
   no-redeclare rule, unlike @typescript-eslint/no-redeclare, flags the overload
   signatures; each `pipe` line is one arity of the SAME function). 
 */
function experimental_pipe<A extends Shape, AE extends Shape>(
  a: TypedAgentSpec<A, AE>,
): Pipeline<A, AE>;
function experimental_pipe<
  A extends Shape,
  AE extends Shape,
  BN extends Shape,
  B extends Shape,
  BE extends Shape,
>(
  a: TypedAgentSpec<A, AE>,
  b: Supplies<A, BN> extends true
    ? PipeStep<BN, B, BE>
    : { readonly __HANDOFF_ERROR: Supplies<A, BN> },
): Pipeline<B, AE | BE>;
function experimental_pipe<
  A extends Shape,
  AE extends Shape,
  BN extends Shape,
  B extends Shape,
  BE extends Shape,
  CN extends Shape,
  C extends Shape,
  CE extends Shape,
>(
  a: TypedAgentSpec<A, AE>,
  b: Supplies<A, BN> extends true
    ? PipeStep<BN, B, BE>
    : { readonly __HANDOFF_ERROR: Supplies<A, BN> },
  c: Supplies<B, CN> extends true
    ? PipeStep<CN, C, CE>
    : { readonly __HANDOFF_ERROR: Supplies<B, CN> },
): Pipeline<C, AE | BE | CE>;
function experimental_pipe<
  A extends Shape,
  AE extends Shape,
  BN extends Shape,
  B extends Shape,
  BE extends Shape,
  CN extends Shape,
  C extends Shape,
  CE extends Shape,
  DN extends Shape,
  D extends Shape,
  DE extends Shape,
>(
  a: TypedAgentSpec<A, AE>,
  b: Supplies<A, BN> extends true
    ? PipeStep<BN, B, BE>
    : { readonly __HANDOFF_ERROR: Supplies<A, BN> },
  c: Supplies<B, CN> extends true
    ? PipeStep<CN, C, CE>
    : { readonly __HANDOFF_ERROR: Supplies<B, CN> },
  d: Supplies<C, DN> extends true
    ? PipeStep<DN, D, DE>
    : { readonly __HANDOFF_ERROR: Supplies<C, DN> },
): Pipeline<D, AE | BE | CE | DE>;
function experimental_pipe(
  first: TypedAgentSpec<Shape, Shape>,
  ...rest: readonly PipeStep<Shape, Shape, Shape>[]
): Pipeline<Shape, Shape> {
  // The overloads above enforce each handoff at the type level; the runtime body
  // is the same left fold of start/andThen, untyped (the checks already happened).
  let pipeline: Pipeline<Shape, Shape> = experimental_start(first);
  for (const s of rest) {
    pipeline = experimental_andThen(pipeline, s);
  }
  return pipeline;
}
/* eslint-enable no-redeclare */

// ---------------------------------------------------------------------------
// Whole-harness registry cross-checks (the codegen layer — see
// `generate-harness.ts` and research/whole-harness-codegen.md).
//
// `generate-harness` emits ONE `harness.gen.ts` that imports every `*.spec.ts`
// and folds the agents into a `registry`, then asserts the cross-spec
// invariants at the TYPE level so a single `tsc --noEmit` checks the whole
// harness as one program. The shipped scope is the PER-EDGE dangling-delegate
// check (below); duplicate NAMES are caught in the JS generator (O(N), the
// TS2589-safe encoding — a set-uniqueness MAPPED TYPE is the wall to avoid),
// and the capability lattice is a generator-computed value.
//
// The encoding rule (measured, research/whole-harness-codegen.md): a per-edge
// check is a SHALLOW conditional (`KnownAgentName` is one literal lookup), so it
// is O(N) over the edges and never recurses — the same discipline `Supplies`
// follows for a per-field handoff.
// ---------------------------------------------------------------------------

/**
 * Per-edge dangling-`delegate` check. `Target` is a delegate target NAME (a
 * string literal the generator reads off a `railway()` value); `Names` is the
 * literal union of every agent name in the harness (emitted by the generator).
 * Collapses to `true` when the target resolves, else to a descriptive error
 * object naming the dangling target + the railway it came from — so assigning
 * `true` to it is a `tsc` error at edit time. Shallow (one conditional, no
 * recursion); the generator emits one assertion per edge (O(N)).
 *
 * @internal Experimental whole-harness-codegen surface — NOT part of the frozen
 * public API (pre-1.0); may change without a major bump.
 */
export type KnownAgentName<
  Target extends string,
  Names extends string,
  From extends string = string,
> = [Target] extends [Names]
  ? true
  : { readonly __dangling_delegate: Target; readonly from: From };

// ---------------------------------------------------------------------------
// Spec file naming convention (#11)
//
// Type-level proof that a spec filename maps to its output.
// SpecPath<"CLAUDE.md"> = "CLAUDE.md.spec.ts"
// ---------------------------------------------------------------------------

/** Derive the spec filename from an output filename. */
export type SpecPath<Output extends `${string}.md`> = `${Output}.spec.ts`;

/** Extract the output filename from a spec filename. */
export type OutputPath<Spec extends `${string}.md.spec.ts`> =
  Spec extends `${infer Base}.spec.ts` ? Base : never;

// ---------------------------------------------------------------------------
// Compile pipeline phantom types (#7)
//
// Branded stages track which validations have been applied.
// The compiler can only emit markdown from a fully-validated spec.
// ---------------------------------------------------------------------------

declare const __stage: unique symbol;

/** A spec that hasn't been validated yet. */
export type RawSpec<T extends ClaudeSpec | SkillSpec = ClaudeSpec> = T & {
  readonly [__stage]: "raw";
};

/** A spec whose file/cmd/ref references have been validated. */
export type RefsValidated<T extends ClaudeSpec | SkillSpec = ClaudeSpec> = T & {
  readonly [__stage]: "refs-validated";
};

/** A spec whose linter rules have been cross-referenced. */
export type LintersVerified<T extends ClaudeSpec | SkillSpec = ClaudeSpec> =
  T & {
    readonly [__stage]: "linters-verified";
  };

/** A fully validated spec, ready for markdown emission. */
export type ReadyToEmit<T extends ClaudeSpec | SkillSpec = ClaudeSpec> = T & {
  readonly [__stage]: "ready";
};

// ---------------------------------------------------------------------------
// Project-level config
// ---------------------------------------------------------------------------

/** Per-linter verification mode. */
export type LinterMode = boolean | "catalog-only";

export interface VigilesV2Config {
  /** Glob pattern to discover spec files. Default: "**\/*.spec.ts" */
  readonly specs?: string;
  /** Auto-discover linter rules for coverage reporting. */
  readonly discover?: boolean;
  /** Maximum rules per spec file. */
  readonly maxRules?: number;
  /** Maximum estimated tokens for compiled output. ~4 chars per token. */
  readonly maxTokens?: number;
  /** Maximum lines per prose section. Forces splitting into named sections. */
  readonly maxSectionLines?: number;
  /** Global kill switch: skip ALL linter verification during compile. */
  readonly verifyLinters?: boolean;
  /** Per-linter verification mode: true (full), "catalog-only", or false (skip). */
  readonly linters?: Record<string, LinterMode>;
}

export function defineConfig(config: VigilesV2Config): VigilesV2Config {
  return config;
}

// ─── ОКНО АЛИАСА (один мажор) ──────────────────────────────────────────────────
// Старые имена остаются рабочими ровно один мажорный релиз, помеченные
// `@deprecated`, и убираются в следующем.
//
// 🔴 ПОЧЕМУ ЭТО НЕ ВЕЖЛИВОСТЬ, А НЕОБХОДИМОСТЬ, замерено 2026-08-21: предыдущее
// переименование ушло БЕЗ окна — 18.1.1 экспортировал только старые имена,
// 19.0.0 только новые, пересечения ноль. У потребителя (репа знаний, 12
// скомпилированных хуков) откат контейнера вернул старый `node_modules` под
// новые исходники, `PreToolUse` перестал загружаться, а не загрузившийся
// PreToolUse отбивает ЛЮБУЮ Bash-команду — включая ту, которой это чинится.
// Репа встала колом на час. Одно окно в один мажор делает этот отказ
// невыразимым: любая пара (лок, исходники) в пределах мажора совместима.
//
// 🔴 «ОДИН МАЖОР» СЧИТАЕТСЯ ОТ ТОГО, КОТОРЫЙ АЛИАСЫ ВВОДИТ, а не до него.
// Мажор, выпускающий этот PR, — ПЕРВЫЙ, где старые и новые имена сосуществуют;
// именно он и есть обещанное окно. Убирать алиасы можно в СЛЕДУЮЩЕМ за ним.
// Формулировка «Removed next major» была двусмысленной ровно здесь (её так и
// прочитал ревьюер: как «удалить в том же релизе, который их вводит»), и по
// такому расписанию окна не существовало бы вовсе — то есть отказ выше
// воспроизвёлся бы дословно, при живом абзаце, который его запрещает.

/**
 * @deprecated Renamed to {@link instructionFile}. The builder compiles to
 * `CLAUDE.md` **and** `AGENTS.md` (see `InstructionTarget`), so a name taken from
 * one of the two harnesses was never right. Removed one major AFTER the one that introduces it.
 */
export const claude = instructionFile;

/**
 * @deprecated Renamed to {@link prose}. It builds a prose FRAGMENT with typed
 * refs; the plural read as "the instruction file", which is what
 * {@link instructionFile} builds. Removed one major AFTER the one that introduces it.
 */
export const instructions = prose;

/**
 * Define a subagent — and the ROOT of the subagent vocabulary.
 *
 * Everything that only makes sense for subagents hangs off this one symbol:
 * `experimental_agent.result()` (the outcome contract), `.railway()` / `.delegate()`
 * (the flat orchestrator), and `.pipe()` / `.start()` / `.andThen()` / `.pipeStep()` /
 * `.needs()` (the typed pipeline). Same chokepoint as `experimental_skill.input()`.
 *
 * WHY a root and not a prefix on each name: `railway()` and `delegate()` are
 * meaningless without a subagent, yet they shipped under STABLE names while the
 * builder they depend on is experimental — a stable name resting on an unstable
 * one. Prefixing each would carry the warning but multiply the vocabulary; a
 * namespace OBJECT was rejected for the reason the `vigiles/experimental` subpath
 * was retired in #169 — it marks the import line, out of view by the time anyone
 * reads the call. A member reached through the marked root cannot be destructured
 * free of its warning without renaming it, so the warning rides every call site.
 *
 * The rule this establishes: ONE experimental root per feature, everything else a
 * member of it, TYPES excluded (a type annotation is not a call site).
 *
 * @experimental
 */
export const experimental_agent = Object.assign(agentSpec, {
  result,
  delegate,
  railway,
  needs: experimental_needs,
  pipeStep: experimental_pipeStep,
  start: experimental_start,
  andThen: experimental_andThen,
  pipe: experimental_pipe,
});

/**
 * @deprecated Renamed to {@link experimental_agent} — the shape is not settled.
 * Removed one major AFTER the one that introduces it.
 *
 * @experimental
 * vigiles:experimental-name-ok this IS the old spelling — prefixing a deprecated
 * alias would defeat the alias, which exists precisely so code written against
 * the unprefixed name keeps compiling for one major. It carries the tag because
 * it is the same function, and the tag is what the deprecation notice points at.
 */
export const agent = experimental_agent;
