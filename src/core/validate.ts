import { readFileSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { globSync } from "glob";
import { resolve, basename as pathBasename } from "node:path";
import { cosmiconfigSync } from "cosmiconfig";
// 🔴 A TOP-LEVEL IMPORT, and the lazy `require` it replaced is recorded because
// the instinct to reintroduce it is correct-sounding: Zod is a ~45 ms cold
// import and this module is on the CLI's barrel. Two measured facts settle it.
//
// (1) It does not reach the HOT rail at all. A compiled hook's decision
//     (`vigiles hook-runtime run-program`) never loads the verb barrel — the
//     dispatcher shim in `src/cli.ts` branches before it, and
//     `src/hook-runtime-graph.test.ts` fails the day that stops being true — so
//     it never loads this file, lazily or otherwise.
// (2) On the rails that DO load the barrel (the PostToolUse `refs` and
//     `eval-lock-nudge` nudges) the floor is ~316 ms of Node startup plus ~85
//     existing requires, against which 45 ms is ~13%, not a breach.
//
// And the attempt is on record as well: an in-body `require("./config-schema")`
// resolves in `dist` (CommonJS) and NOT under vitest, which imports the `.ts`
// sources — it failed every suite that touches `loadConfig`. A deferral that
// only works in one of the two worlds the code runs in is not one line of
// hygiene, it is a second module system.
import {
  vigilesConfigSchema,
  formatConfigIssues,
  REPLACED_KEYS,
  replacedKeyMessage,
  VigilesConfigError,
} from "./config-schema.js";

import type {
  ParsedRule,
  ValidationError,
  ValidationResult,
  ReadResult,
  FileResult,
  ValidatePathsResult,
  RulesConfig,
  VigilesConfig,
  HarnessDeclaration,
  MarkerType,
  ParseOptions,
  ValidateOptions,
  ValidatePathsOptions,
  ReadOptions,
} from "./types.js";

// Re-export all types for consumers
export type {
  ParsedRule,
  ValidationError,
  ValidationResult,
  ReadResult,
  FileResult,
  ValidatePathsResult,
  RulesConfig,
  VigilesConfig,
  HarnessDeclaration,
  MarkerType,
  ParseOptions,
  ValidateOptions,
  ValidatePathsOptions,
  ReadOptions,
};

// ---------------------------------------------------------------------------
// Constants & regex
// ---------------------------------------------------------------------------

const GUIDANCE_RE = /\*\*Guidance only\*\*/;
const DISABLE_RE = /<!--\s*vigiles-disable\s*-->/;
const RULE_HEADER_RE = /^###\s+(.+)$/;
const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+)$/;

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

// The instruction filenames vigiles recognizes when no dialect is injected — a
// validator-level default, not a harness dialect (the concrete dialects live in
// the adapters; an injected ValidateOptions.dialect overrides this).
const INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md"];

// The default instruction file to validate when no config names one.
const DEFAULT_FILES: string[] = [INSTRUCTION_FILES[0]];

/**
 * The shipped default severity of every rule — DERIVED from the schema, never
 * listed twice.
 *
 * It used to be the literal beside the type, which is exactly the pair that
 * drifts: `rule-meta.test.ts` already cross-checks each rule's documented
 * `defaultSeverity` against this object, and it could only ever catch a doc that
 * disagreed with the literal, never a literal that disagreed with what parsing
 * actually produced. Reading it out of the parser closes that gap: this IS what
 * a `{}` config loads as.
 */
export const DEFAULT_RULES: Required<RulesConfig> = defaultConfig()
  .rules as Required<RulesConfig>;

/** The default rule markers — read from the schema, like every other default. */
const DEFAULT_MARKERS: readonly MarkerType[] = defaultConfig().ruleMarkers;

/** A freshly parsed empty config — the defaults, straight from the schema. */
function defaultConfig(): VigilesConfig {
  return vigilesConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// Instruction file discovery
// ---------------------------------------------------------------------------

export function findInstructionFiles(
  cwd: string = process.cwd(),
  configFiles?: string[],
): string[] {
  const candidates = configFiles ?? DEFAULT_FILES;
  return candidates.filter((f) => existsSync(resolve(cwd, f)));
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Read and VALIDATE `.vigilesrc.json`.
 *
 * 🔴 `searchFrom` IS NOT A CONVENIENCE. cosmiconfig defaults to the process's
 * working directory and walks up — right for a CLI verb, where the user is
 * standing in the project they mean, and wrong for a hook, whose process has no
 * stable cwd. A hook rail that omits it reads a DIFFERENT project's config, or
 * none, and the failure runs the wrong way: a missing file means defaults, so a
 * rule the author switched OFF comes back on, silently, because the file saying
 * "off" was never found. Nothing in the output distinguishes that from a project
 * that never configured the rule.
 *
 * 🔴 `onInvalid` IS THE ONE PLACE THE CALL SITES DIFFER, AND IT IS NOT A SPLIT
 * IN WHAT IS CHECKED. Every reader validates; they disagree only about what a
 * bad config is allowed to do to them. A VERB is a human standing at a prompt
 * having just edited the file — `"throw"`, so the line they typed is refused out
 * loud. A HOOK RAIL is a fresh process inside somebody's editing session, and a
 * hook that dies on a malformed config turns a typo in a JSON file into a failed
 * edit, which is a worse outcome than the nudge not firing — `"warn"`, print the
 * same lines to stderr and carry on with the defaults.
 *
 * The two hook rails are `refsHookCommand` and `evalLockNudgeHookCommand`
 * (`vigiles hook-runtime refs` / `eval-lock-nudge`, both registered as
 * PostToolUse `Edit|Write` in `.claude-plugin/plugin.json`). Every other reader
 * is a verb.
 *
 * ⚠️ THE SCHEMA MODULE IS REQUIRED IN-BODY, and that is hygiene rather than an
 * optimization worth a paragraph: Zod is a ~45 ms cold import, `tsc` emits
 * CommonJS across 230 separate files, so a `require` in a function body genuinely
 * does not execute until the function is called. A rail that never reads a
 * config never pays for the validator.
 */
export function loadConfig(
  searchFrom?: string,
  { onInvalid = "throw" }: { onInvalid?: "throw" | "warn" } = {},
): VigilesConfig {
  let raw: unknown;
  try {
    const explorer = cosmiconfigSync("vigiles", {
      searchPlaces: [".vigilesrc.json"],
      mergeSearchPlaces: false,
    });
    raw = explorer.search(searchFrom)?.config;
  } catch {
    // No file, unreadable file, malformed JSON — the defaults, as always. A
    // config we CAN read and refuse is a different thing and is handled below.
    return defaultConfig();
  }
  if (raw === undefined || raw === null) return defaultConfig();

  // The replaced keys get their own message BEFORE the schema's, because the
  // reader is someone whose config used to work: `.strict()` would tell them
  // "unknown key harness", which is true and useless. See REPLACED_KEYS.
  const problems: string[] = [];
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const present = REPLACED_KEYS.filter((k) => k.key in raw);
    if (present.length > 0) problems.push(replacedKeyMessage(present));
  }
  if (problems.length === 0) {
    const parsed = vigilesConfigSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    problems.push(...formatConfigIssues(parsed.error.issues));
  }
  if (onInvalid === "throw") throw new VigilesConfigError(problems.join("\n"));
  for (const line of problems) console.warn(`⚠ ${line}`);
  console.warn("⚠ Using default configuration.");
  return defaultConfig();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseRules(
  content: string,
  { ruleMarkers }: ParseOptions = {},
): ParsedRule[] {
  const markers = ruleMarkers ?? DEFAULT_MARKERS;
  const lines = content.split("\n");
  const rules: ParsedRule[] = [];

  let currentRule: ParsedRule | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = markers.includes("headings")
      ? line.match(RULE_HEADER_RE)
      : null;
    const checkboxMatch = markers.includes("checkboxes")
      ? line.match(CHECKBOX_RE)
      : null;

    if (headerMatch ?? checkboxMatch) {
      if (currentRule) {
        rules.push(currentRule);
      }
      const title = headerMatch
        ? headerMatch[1].trim()
        : (checkboxMatch as RegExpMatchArray)[2].trim();
      currentRule = {
        title,
        line: i + 1,
        enforcement: "missing",
        enforcedBy: null,
      };
      continue;
    }

    if (!currentRule || currentRule.enforcement !== "missing") continue;

    const enforcedMatch = line.match(/\*\*Enforced by:\*\*\s*`([^`]+)`/);
    if (enforcedMatch) {
      currentRule.enforcement = "enforced";
      currentRule.enforcedBy = enforcedMatch[1] ?? null;
      continue;
    }

    if (GUIDANCE_RE.test(line)) {
      currentRule.enforcement = "guidance";
      continue;
    }

    if (DISABLE_RE.test(line)) {
      currentRule.enforcement = "disabled";
      continue;
    }
  }

  if (currentRule) {
    rules.push(currentRule);
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

export function validate(
  content: string,
  { ruleMarkers, rules: rulesConfig, filePath, dialect }: ValidateOptions = {},
): ValidationResult {
  const activeRules = rulesConfig ?? DEFAULT_RULES;
  const parsedRules = parseRules(content, { ruleMarkers });
  const enforced = parsedRules.filter(
    (r) => r.enforcement === "enforced",
  ).length;
  const guidanceOnly = parsedRules.filter(
    (r) => r.enforcement === "guidance",
  ).length;
  const disabled = parsedRules.filter(
    (r) => r.enforcement === "disabled",
  ).length;
  const missingCount = parsedRules.filter(
    (r) => r.enforcement === "missing",
  ).length;

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const disableComment =
    /<!--\s*vigiles-disable\s+require-instructions-spec\s*-->/;

  if (filePath) {
    const basename = pathBasename(filePath);
    const recognized = dialect?.instructionTargets ?? INSTRUCTION_FILES;
    const isInstruction = recognized.includes(basename);
    const isSkill = basename === "SKILL.md";

    // --- require-instructions-spec (CLAUDE.md / AGENTS.md) ---
    // NARROW: only a `.spec.ts` sibling satisfies it. The rule name says "spec",
    // so inline `<!-- vigiles:enforce -->` / `vigiles:` frontmatter do NOT count
    // (a user on inline mode keeps this rule off — it's a workflow-tier opt-in).
    // `vigiles init` auto-adopts every instruction file into a spec, so this is
    // green by construction after setup.
    const specSeverity = activeRules["require-instructions-spec"];
    if (specSeverity && isInstruction && !disableComment.test(content)) {
      const specPath = filePath + ".spec.ts";
      if (!existsSync(specPath)) {
        const msg: ValidationError = {
          rule: "require-instructions-spec",
          message: `No spec file found for "${filePath}". Expected "${specPath}". Run \`npx vigiles init --target=${filePath}\` to adopt it into a spec, or disable with <!-- vigiles-disable require-instructions-spec -->.`,
          line: 1,
        };
        if (specSeverity === "error") {
          errors.push(msg);
        } else {
          warnings.push(msg);
        }
      }
    }

    // --- require-skill-spec (SKILL.md) — the consistent require-<surface>-spec
    // parallel, off by default; honored when a user sets it explicitly.
    const skillSeverity = activeRules["require-skill-spec"];
    if (skillSeverity && isSkill && !disableComment.test(content)) {
      const specPath = filePath + ".spec.ts";
      if (!existsSync(specPath)) {
        const msg: ValidationError = {
          rule: "require-skill-spec",
          message: `No spec file found for "${filePath}". Expected "${specPath}".`,
          line: 1,
        };
        if (skillSeverity === "error") {
          errors.push(msg);
        } else {
          warnings.push(msg);
        }
      }
    }
  }

  return {
    rules: parsedRules,
    enforced,
    guidanceOnly,
    disabled,
    missing: missingCount,
    total: parsedRules.length,
    errors,
    warnings,
    valid: errors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

export function readInstructionFile(
  filePath: string,
  options: ReadOptions = {},
): ReadResult {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() && !options.followSymlinks) {
      return {
        content: null,
        skipped: true,
        reason: `${filePath} is a symlink (use --follow-symlinks to include)`,
      };
    }
  } catch {
    return {
      content: null,
      skipped: false,
      reason: `File not found: ${filePath}`,
    };
  }

  try {
    return {
      content: readFileSync(filePath, "utf-8"),
      skipped: false,
      reason: null,
    };
  } catch {
    return {
      content: null,
      skipped: false,
      reason: `Could not read: ${filePath}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Glob expansion
// ---------------------------------------------------------------------------

export function expandGlobs(patterns: string[]): string[] {
  const GLOB_CHARS = /[*?{[]/;
  const paths: string[] = [];

  for (const pattern of patterns) {
    if (GLOB_CHARS.test(pattern)) {
      const matches = globSync(pattern, { cwd: process.cwd() });
      for (const match of matches.sort()) {
        paths.push(resolve(match));
      }
    } else {
      paths.push(pattern);
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Multi-file validation
// ---------------------------------------------------------------------------

export function validatePaths(
  paths: string[],
  {
    followSymlinks = false,
    ruleMarkers,
    rules: rulesConfig,
  }: ValidatePathsOptions = {},
): ValidatePathsResult {
  const fileResults: FileResult[] = [];
  let allValid = true;
  // Maps a real (symlink-resolved) path → the first path validated for it, so a
  // symlinked/synced CLAUDE.md⇄AGENTS.md mirror is validated ONCE on the real
  // file instead of double-firing require-instructions-spec on the mirror's name (sync-tool-
  // compatibility.md req 7). Recorded only on a successful validation, so a
  // symlink seen first (and skipped) never shadows its real target.
  const seenReal = new Map<string, string>();

  for (const filePath of paths) {
    let real: string;
    try {
      real = realpathSync(filePath);
    } catch {
      real = resolve(filePath);
    }

    const prior = seenReal.get(real);
    if (prior !== undefined) {
      fileResults.push({
        path: filePath,
        skipped: true,
        reason: `mirror of ${prior} (same file via symlink/sync) — validated once`,
        result: null,
      });
      continue;
    }

    const { content, skipped, reason } = readInstructionFile(filePath, {
      followSymlinks,
    });

    if (skipped || content === null) {
      fileResults.push({
        path: filePath,
        skipped,
        reason,
        result: null,
      });
      if (!skipped) allValid = false;
      continue;
    }

    // Attribute require-instructions-spec/integrity to the REAL file when this path is a
    // symlink, so a symlinked AGENTS.md resolves to CLAUDE.md's spec rather than
    // a nonexistent AGENTS.md.spec.ts. Non-symlinks keep the original path
    // verbatim (behaviour-preserving).
    const attributePath = real !== resolve(filePath) ? real : filePath;
    seenReal.set(real, filePath);
    const result = validate(content, {
      ruleMarkers,
      rules: rulesConfig,
      filePath: attributePath,
    });
    fileResults.push({ path: filePath, skipped: false, reason: null, result });
    if (!result.valid) allValid = false;
  }

  return { fileResults, valid: allValid };
}
