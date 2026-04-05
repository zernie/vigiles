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

/** Information about a detected linter. */
export interface DetectedLinter {
  name: string;
  ruleCount?: number;
  via?: string;
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
  valid: boolean;
  detectedLinters: DetectedLinter[];
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
export interface RulesConfig {
  "require-annotations"?: boolean;
  "max-lines"?: number | boolean;
  "require-rule-file"?: "auto" | "catalog-only" | boolean;
  "require-structure"?: boolean;
  "no-broken-links"?: boolean;
}

/** Linter-specific configuration (e.g., custom rules directories). */
export interface LinterConfig {
  rulesDir?: string | string[];
}

/** A structure validation entry mapping file globs to schemas. */
export interface StructureEntry {
  files: string;
  schema: string;
}

/** Full vigiles configuration. */
export interface VigilesConfig {
  extends: string;
  ruleMarkers: MarkerType[];
  rules: Required<RulesConfig>;
  linters: Record<string, LinterConfig>;
  agents: string[] | null;
  structures: StructureEntry[];
}

/** Valid marker types for rule detection. */
export type MarkerType = "headings" | "checkboxes";

/** Options for parseClaudeMd. */
export interface ParseOptions {
  ruleMarkers?: MarkerType[];
}

/** Options for validate(). */
export interface ValidateOptions {
  ruleMarkers?: MarkerType[];
  rules?: RulesConfig;
  basePath?: string;
  linters?: Record<string, LinterConfig>;
  structures?: StructureEntry[];
  filePath?: string;
}

/** Options for validatePaths(). */
export interface ValidatePathsOptions {
  followSymlinks?: boolean;
  ruleMarkers?: MarkerType[];
  rules?: RulesConfig;
  linters?: Record<string, LinterConfig>;
  structures?: StructureEntry[];
}

/** Options for readClaudeMd(). */
export interface ReadOptions {
  followSymlinks?: boolean;
}

/** An AI coding tool definition. */
export interface AgentTool {
  name: string;
  indicators: string[];
  instructionFiles: string[];
}

/** Discovery result from scanning for AI tool instruction files. */
export interface DiscoveryResult {
  detected: Array<{ name: string; indicator: string }>;
  files: string[];
  missing: Array<{ tool: string; expected: string; indicator: string }>;
}

/** Result of mdschema structure validation. */
export interface StructureValidationResult {
  errors: ValidationError[];
  available: boolean;
}

/** A linter resolver function that returns a Set of rule names. */
export type LinterResolver = (basePath: string) => Set<string>;

/** A CLI rule checker function that throws if a rule doesn't exist. */
export type CliRuleChecker = (ruleName: string) => void;

/** A config-enabled checker: returns rule status in project config. */
export type ConfigEnabledStatus = "enabled" | "disabled" | "unknown";
export type ConfigChecker = (
  ruleName: string,
  basePath: string,
) => ConfigEnabledStatus;

/** Extended Set with eslint metadata. */
export interface EslintRuleSet extends Set<string> {
  _basePath?: string;
  _isEslint?: boolean;
}

/** Rule pack definition. */
export interface RulePack {
  rules: Required<RulesConfig>;
  structures: StructureEntry[];
}
