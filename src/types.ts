/** A parsed rule from a markdown instruction file. */
export interface ParsedRule {
  title: string;
  line: number;
  enforcement: "enforced" | "guidance" | "disabled" | "missing";
  enforcedBy: string | null;
}

/** A validation error produced by a rule check. */
export interface ValidationError {
  rule: string;
  message: string;
  line: number;
}

/** Result of validating a single file's content. */
export interface ValidationResult {
  rules: ParsedRule[];
  enforced: number;
  guidanceOnly: number;
  disabled: number;
  missing: number;
  total: number;
  errors: ValidationError[];
  warnings: ValidationError[];
  valid: boolean;
}

/** Result of reading a file (may be skipped due to symlinks). */
export interface ReadResult {
  content: string | null;
  skipped: boolean;
  reason: string | null;
}

/** Result of validating a single file path. */
export interface FileResult {
  path: string;
  skipped: boolean;
  reason: string | null;
  result: ValidationResult | null;
}

/** Combined result of validating multiple file paths. */
export interface ValidatePathsResult {
  fileResults: FileResult[];
  valid: boolean;
}

/** Toggleable rule settings. */
/** Rule severity: "warn" prints but exits 0, "error" fails, false disables. */
export type RuleSeverity = "warn" | "error" | false;

/** Freshness detection mode for the `freshness` rule. */
export type FreshnessMode = "strict" | "input-hash" | "output-hash";

export interface RulesConfig {
  /** Require .spec.ts for CLAUDE.md / AGENTS.md. Default: "warn". */
  "require-spec"?: RuleSeverity;
  /** Require .spec.ts for SKILL.md files. Default: false. */
  "require-skill-spec"?: RuleSeverity;
  /** Detect stale compiled output. Default: "warn". */
  freshness?: RuleSeverity;
  /** Enforce minimum spec coverage thresholds. Default: false. */
  coverage?: RuleSeverity;
}

/** Full vigiles configuration. Loaded from .vigilesrc.json. */
export interface VigilesConfig {
  // --- Validation ---
  ruleMarkers: MarkerType[];
  rules: Required<RulesConfig>;
  files: string[];

  // --- Compilation ---
  /** Maximum number of rules allowed per spec. */
  maxRules?: number;
  /** Maximum estimated tokens for compiled output. */
  maxTokens?: number;
  /** Maximum lines per prose section. */
  maxSectionLines?: number;
  /** Skip config-enabled checks, only verify rule exists in catalog. */
  catalogOnly?: boolean;
  /** Custom linter configs (rulesDir). */
  linters?: Record<string, { rulesDir?: string | string[] }>;

  // --- Freshness ---
  /** How to detect staleness. Default: "strict" (recompile and diff). */
  freshnessMode?: FreshnessMode;
  /** Extra files to track in input-hash mode (e.g., monorepo root lock file). */
  freshnessInputs?: string[];

  // --- Coverage ---
  /** Minimum coverage thresholds. Audit warns/errors when below. */
  coverageThresholds?: {
    /** Min % of enabled linter rules with enforce() declarations. */
    linterRules?: number;
    /** Min % of npm scripts documented in spec commands. */
    scripts?: number;
  };
}

/** Valid marker types for rule detection. */
export type MarkerType = "headings" | "checkboxes";

/** Options for parseRules. */
export interface ParseOptions {
  ruleMarkers?: MarkerType[];
}

/** Options for validate(). */
export interface ValidateOptions {
  ruleMarkers?: MarkerType[];
  rules?: RulesConfig;
  filePath?: string;
}

/** Options for validatePaths(). */
export interface ValidatePathsOptions {
  followSymlinks?: boolean;
  ruleMarkers?: MarkerType[];
  rules?: RulesConfig;
}

/** Options for readInstructionFile(). */
export interface ReadOptions {
  followSymlinks?: boolean;
}
