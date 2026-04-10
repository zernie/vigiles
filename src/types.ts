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

export interface RulesConfig {
  /** Require .spec.ts for CLAUDE.md / AGENTS.md. Default: "warn". */
  "require-spec"?: RuleSeverity;
  /** Require .spec.ts for SKILL.md files. Default: false. */
  "require-skill-spec"?: RuleSeverity;
}

/** Full vigiles configuration. */
export interface VigilesConfig {
  ruleMarkers: MarkerType[];
  rules: Required<RulesConfig>;
  files: string[];
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
