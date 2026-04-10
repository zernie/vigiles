/**
 * vigiles v2 — Executable specification system.
 *
 * Specs are TypeScript files that compile to instruction files (CLAUDE.md, SKILL.md).
 * The spec is the source of truth. The markdown is a build artifact.
 *
 * Three rule types:
 *   enforce() — delegated to an external linter (ESLint, Ruff, Clippy, etc.)
 *   check()   — checked by vigiles itself (filesystem, AST patterns)
 *   guidance() — prose only, no mechanical enforcement
 */

// ---------------------------------------------------------------------------
// Template literal types for type-safe linter references
// ---------------------------------------------------------------------------

/** Linters vigiles can cross-reference. */
type BuiltinLinter =
  | "eslint"
  | "stylelint"
  | "ruff"
  | "clippy"
  | "pylint"
  | "rubocop";

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
// When `vigiles generate-types` runs, it emits a .d.ts that populates these
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
// Claude Code tool types (for hook validation)
// ---------------------------------------------------------------------------

export type ClaudeTool =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Grep"
  | "Glob"
  | "Agent"
  | "TodoWrite"
  | "WebSearch"
  | "WebFetch"
  | "NotebookEdit";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSession"
  | "PostSession"
  | "Notification";

// ---------------------------------------------------------------------------
// Filesystem assertions (the ONE thing vigiles owns)
// ---------------------------------------------------------------------------

/** A file-pairing assertion: for every file matching `glob`, expect a sibling. */
export interface FilePairingAssertion {
  readonly _type: "file-pairing";
  readonly glob: string;
  readonly pattern: string;
}

// ---------------------------------------------------------------------------
// Rule types
// ---------------------------------------------------------------------------

/** A rule delegated to an external tool (linter, ast-grep, dependency-cruiser, etc.). */
export interface EnforceRule {
  readonly _kind: "enforce";
  readonly linterRule: LinterRule;
  readonly why: string;
  /** Skip linter verification for this rule. Default: true (verify). */
  readonly verify: boolean;
}

/** A filesystem check owned by vigiles (e.g., test file pairing). */
export interface CheckRule {
  readonly _kind: "check";
  readonly assertion: FilePairingAssertion;
  readonly why: string;
}

/** A guidance-only rule (prose, no enforcement). */
export interface GuidanceRule {
  readonly _kind: "guidance";
  readonly text: string;
}

export type Rule = EnforceRule | CheckRule | GuidanceRule;

// ---------------------------------------------------------------------------
// Builder functions
// ---------------------------------------------------------------------------

/**
 * Declare a rule enforced by an external tool.
 *
 * When generated types are present, the `linterRule` argument is narrowed
 * to only accept rules that exist in your linter configs.
 *
 *   enforce("eslint/no-console", "Use structured logger.")
 *   enforce("@typescript-eslint/no-floating-promises", "Always await.")
 *   enforce("ruff/T201", "Use logging module.")
 */
export function enforce(
  linterRule: NoInfer<StrictLinterRule>,
  why: string,
  options?: { verify?: boolean },
): EnforceRule {
  return {
    _kind: "enforce",
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    linterRule: linterRule as LinterRule,
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
 * Declare a filesystem check owned by vigiles.
 *
 *   check(every("src/*.controller.ts").has("{name}.test.ts"), "Controllers need tests.")
 */
export function check(assertion: FilePairingAssertion, why: string): CheckRule {
  return { _kind: "check", assertion, why };
}

// ---------------------------------------------------------------------------
// Filesystem assertion builder
// ---------------------------------------------------------------------------

/** Start a file-pairing assertion: every(glob).has(pattern). */
export function every(glob: string): {
  has(pattern: string): FilePairingAssertion;
} {
  return {
    has(pattern: string): FilePairingAssertion {
      return { _type: "file-pairing", glob, pattern };
    },
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

export type Ref = FileRef | CmdRef | SkillRef;

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
 * Reference another skill or instruction file — verified to exist.
 * Compiles to a markdown link: [skill name](path)
 */
export function ref(path: string): SkillRef {
  return { _ref: "skill", path: path as VerifiedRef };
}

// ---------------------------------------------------------------------------
// Instruction template — process refs inside skill instructions
// ---------------------------------------------------------------------------

export type InstructionFragment = string | Ref;

/**
 * Tagged template literal for skill instructions with typed references.
 *
 *   instructions`
 *     Check ${file("eslint.config.ts")} for rules.
 *     Run ${cmd("npm test")} to verify.
 *     See ${ref("skills/other/SKILL.md")} for format.
 *   `
 */
export function instructions(
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

// ---------------------------------------------------------------------------
// CLAUDE.md spec (#5 — conditional maxSectionLines)
// ---------------------------------------------------------------------------

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
  /** Maximum lines per prose section (per-spec override). */
  readonly maxSectionLines?: number;
  /** Rules: enforce(), check(), or guidance(). */
  readonly rules: Record<string, Rule>;
}

/**
 * Input type for claude() — maxSectionLines is only valid when sections are provided.
 * TypeScript errors if you set maxSectionLines without defining sections.
 */
type ClaudeSpecBase = {
  readonly target?: InstructionTarget | InstructionTarget[];
  readonly commands?: Record<string, string>;
  readonly keyFiles?: Record<string, string>;
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
 *   export default claude({ commands: {...}, rules: {...} });
 */
export function claude(spec: ClaudeSpecInput): ClaudeSpec {
  return { _specType: "claude", ...spec } as ClaudeSpec;
}

// ---------------------------------------------------------------------------
// SKILL.md spec
// ---------------------------------------------------------------------------

export interface SkillSpec {
  readonly _specType: "skill";
  /** Skill name (used in frontmatter). */
  readonly name: string;
  /** Short description (used in frontmatter). */
  readonly description: string;
  /** Hint for the argument (used in frontmatter). */
  readonly argumentHint?: string;
  /** Whether to disable model invocation (frontmatter flag). */
  readonly disableModelInvocation?: boolean;
  /** Instruction body — string or tagged template with typed refs. */
  readonly body: string | InstructionFragment[];
}

/**
 * Define a SKILL.md specification.
 *
 *   // skills/my-skill/SKILL.md.spec.ts
 *   export default skill({ name: "my-skill", description: "...", body: "..." });
 */
export function skill(spec: Omit<SkillSpec, "_specType">): SkillSpec {
  return { _specType: "skill", ...spec };
}

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
