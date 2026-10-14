import type { HarnessDialect } from "./dialect.js";
// TYPE-ONLY, and that matters: `types.ts` is imported by node-free core modules,
// and a value import of the schema would pull Zod (and its ~45 ms cold cost) into
// every one of them. A `import type` is erased, so there is no runtime edge and
// no cycle, even though config-schema.ts imports nothing from here.
import type {
  HarnessDeclarationShape,
  RulesConfig,
  VigilesConfigOf,
} from "./config-schema.js";

export type { RuleEntry, RulesConfig } from "./config-schema.js";

/** A parsed rule from a markdown instruction file. */
export interface ParsedRule {
  title: string;
  line: number;
  /**
   * `enforced` = "**Enforced by:**" (compile verified it); `claimed` =
   * "**Claimed (unverified):**" (a reference compile did not verify, #351).
   */
  enforcement: "enforced" | "claimed" | "guidance" | "disabled" | "missing";
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
  /** Rules stated as "**Claimed (unverified):**" — never counted as enforced. */
  claimed: number;
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

/** Rule with options: severity alone or [severity, options] tuple. */
export type RuleWithOptions<T> =
  | RuleSeverity
  | [Exclude<RuleSeverity, false>, T];

/** Options for the coverage rule. */
export interface CoverageThresholds {
  /** Min % of enabled linter rules with enforce() declarations. */
  linterRules?: number;
  /** Min % of npm scripts documented in spec commands. */
  scripts?: number;
}

/**
 * Options for the `instruction-weight` rule: `["error", { max: 40000 }]`.
 */
export interface InstructionWeightConfig {
  /**
   * An opt-in ABSOLUTE ceiling on the always-loaded instruction weight, in the
   * harness's own unit (characters for Claude Code, bytes for Codex). A total
   * above it is a finding at the rule's severity regardless of the baseline, and
   * `vigiles lint --update-baseline` refuses to record a baseline above it.
   * Omitted → only the ratchet applies. A positive integer.
   */
  max?: number;
}

/**
 * Options for the orphan-docs check. The PRESENCE of this block in
 * `.vigilesrc.json` OPTS THE REPO IN — the scan is off unless declared,
 * because "unreferenced" only means "rot" for a hand-cross-linked corpus,
 * not for a nav-managed doc site (Docusaurus/MkDocs) where the page graph
 * lives in config. `include` is the optional dir override.
 */
export interface OrphansConfig {
  /**
   * Glob patterns of `.md` files to scan for orphans. A doc is "orphaned"
   * when no other markdown file references it. Omitted → `["docs/**\/*.md"]`
   * (the common convention); add your own dirs (e.g. a `research/` notes
   * tree) explicitly. Set to `[]` to opt in but scan nothing.
   */
  include?: readonly string[];
}

/**
 * Shared options for the per-kind untested-* rules (`untested-skill` /
 * `untested-subagent` / `untested-hook`). Which kinds are scanned is controlled by
 * each rule's severity (set a rule to `false` to skip that kind), so only the
 * test-discovery knobs live here.
 */
export interface TestCoverageConfig {
  /** Globs of test files that count as coverage. */
  include?: readonly string[];
  /**
   * Which extension the SUGGESTED test path in an untested-* finding uses
   * (`<surface>.harness.<ext>`). Detection decides by default — a `tsconfig.json`
   * or a `typescript` dependency means `.ts`, otherwise `.mjs` — and this exists
   * only to disagree with it: a monorepo of mixed packages, a JS project carrying
   * a stray `tsconfig.json`, or a deliberate choice to keep tests in JS. An
   * unrecognised value is ignored rather than honoured, since suggesting
   * `foo.harness.rb` would point the author at a path no runner can execute.
   * Never written by `vigiles init` — see `core/test-file-ext.ts` for why.
   */
  testExtension?: string;
}

/**
 * Thresholds for the `compile-budget` rule, in characters. A key left out
 * keeps its default; `0` turns that budget off.
 */
export interface CompileBudgetConfig {
  /** One `commands` description. Default 200. */
  maxEntryChars?: number;
  /** One named prose section. Default 15,000. */
  maxSectionChars?: number;
  /** The whole rendered Rules section. Default 20,000 (at "error"). */
  maxRulesChars?: number;
}

// ---------------------------------------------------------------------------
// Rule parsing helpers
// ---------------------------------------------------------------------------

/** Extract severity from a rule value (handles both simple and tuple forms). */
export function ruleSeverity<T>(
  rule: RuleWithOptions<T> | undefined,
): RuleSeverity {
  if (rule === undefined) return false;
  if (Array.isArray(rule)) return rule[0];
  return rule;
}

/** Extract options from a rule value (returns undefined for simple severity). */
export function ruleOptions<T>(
  rule: RuleWithOptions<T> | undefined,
): T | undefined {
  if (Array.isArray(rule)) return rule[1];
  return undefined;
}

/**
 * ONE harness's entry in {@link VigilesConfig.harnesses} — what this repo tells
 * that harness about itself. Today that is only `roots`; the OBJECT (rather than
 * a bare array of roots) is what leaves room for a second per-harness fact
 * without another top-level key, which is how `surfaceRoots` came to exist
 * beside `harness` in the first place.
 *
 * `{}` is meaningful and is the common case: "this repo targets this harness,
 * and it reads it where it normally reads it."
 *
 * `roots` are extra repo-relative dirs THIS harness's surfaces live under, read
 * with THIS harness's own `surfaceDirs` — `[".ai"]` under `"claude-code"` means
 * `.ai/skills`, `.ai/agents`, `.ai/commands`. Every entry must resolve to at
 * least one surface dir that exists on disk under this harness's layout; one
 * that does not is a hard error, because a root declared under a harness that
 * reads nothing there changes nothing and used to say nothing.
 */
export type HarnessDeclaration = HarnessDeclarationShape;

/**
 * Full vigiles configuration, loaded from `.vigilesrc.json`, with `rules` keyed
 * by a string id — the form generic code takes.
 *
 * 🔴 DERIVED FROM THE SCHEMA, NOT WRITTEN BESIDE IT. The shape, the defaults and
 * the per-key prose all live in `./config-schema.ts`, and the `rules` are built
 * from the rule set the composition root hands in; the root's PRECISE type
 * (each id with its own options) is `VigilesConfig` in `src/rules/index.ts`. A
 * hand-written twin is the copy that drifts: `harness` and `surfaceRoots` lived
 * in that twin, in `docs/cli.md` and in the loader's coercions, and the three
 * disagreed about what was read (#240). The per-rule prose that lived in a
 * hand-written `RulesConfig` here is each rule's `summary` and its doc.
 *
 * The re-export is TYPE-ONLY on purpose — `types.ts` is imported by node-free
 * core modules, and a value import of the schema module would pull Zod into
 * every one of them.
 */
export type VigilesConfig = VigilesConfigOf<RulesConfig>;

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
  /** Injected harness dialect; its instructionTargets define recognized
   *  instruction filenames. Omitted → the validator's built-in default set. */
  dialect?: HarnessDialect;
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
