import { readFileSync, lstatSync, existsSync } from "node:fs";
import { globSync } from "glob";
import { resolve, basename as pathBasename } from "node:path";
import { cosmiconfigSync } from "cosmiconfig";

import { hasInlineRules } from "./inline.js";

import type {
  ParsedRule,
  ValidationError,
  ValidationResult,
  ReadResult,
  FileResult,
  ValidatePathsResult,
  RulesConfig,
  VigilesConfig,
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

const VALID_MARKERS: readonly MarkerType[] = ["headings", "checkboxes"];

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_FILES: string[] = ["CLAUDE.md"];

const DEFAULT_RULES: Required<RulesConfig> = {
  "require-spec": "warn",
  "require-skill-spec": "warn",
  integrity: "warn",
  coverage: false,
};

const DEFAULT_CONFIG: VigilesConfig = {
  ruleMarkers: ["headings", "checkboxes"],
  rules: DEFAULT_RULES,
  files: DEFAULT_FILES,
};

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

export function loadConfig(): VigilesConfig {
  try {
    const explorer = cosmiconfigSync("vigiles", {
      searchPlaces: [".vigilesrc.json"],
      mergeSearchPlaces: false,
    });
    const result = explorer.search();
    if (!result?.config) return { ...DEFAULT_CONFIG };

    const userConfig = result.config as Partial<VigilesConfig> & {
      rules?: Partial<RulesConfig>;
    };

    const config: VigilesConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      rules: { ...DEFAULT_RULES, ...userConfig.rules },
      files: Array.isArray(userConfig.files) ? userConfig.files : DEFAULT_FILES,
    };

    if (
      !Array.isArray(config.ruleMarkers) ||
      !config.ruleMarkers.every((m): m is MarkerType =>
        (VALID_MARKERS as readonly string[]).includes(m),
      )
    ) {
      console.warn(
        `Invalid ruleMarkers in config: ${JSON.stringify(config.ruleMarkers)}. Using default.`,
      );
      config.ruleMarkers = [...DEFAULT_CONFIG.ruleMarkers];
    }

    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseRules(
  content: string,
  { ruleMarkers }: ParseOptions = {},
): ParsedRule[] {
  const markers = ruleMarkers ?? DEFAULT_CONFIG.ruleMarkers;
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
  { ruleMarkers, rules: rulesConfig, filePath }: ValidateOptions = {},
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
  const disableComment = /<!--\s*vigiles-disable\s+require-spec\s*-->/;

  if (filePath) {
    const basename = pathBasename(filePath);
    const isInstruction = basename === "CLAUDE.md" || basename === "AGENTS.md";
    const isSkill = basename === "SKILL.md";

    // --- require-spec (CLAUDE.md / AGENTS.md) ---
    const specSeverity = activeRules["require-spec"];
    if (specSeverity && isInstruction && !disableComment.test(content)) {
      const specPath = filePath + ".spec.ts";
      // Inline mode counts as a spec — any parseable
      // `<!-- vigiles:enforce ... -->` comment means the file is
      // verified on `vigiles audit` even without a .spec.ts sibling.
      // Delegate to the real parser so a malformed marker can't
      // satisfy require-spec with a rule that audit can't verify.
      const hasInline = hasInlineRules(content);
      if (!existsSync(specPath) && !hasInline) {
        const msg: ValidationError = {
          rule: "require-spec",
          message: `No spec file found for "${filePath}". Expected "${specPath}". Run \`npx vigiles init --target=${filePath}\` to create one, add inline \`<!-- vigiles:enforce ... -->\` comments, or disable with <!-- vigiles-disable require-spec -->.`,
          line: 1,
        };
        if (specSeverity === "error") {
          errors.push(msg);
        } else {
          warnings.push(msg);
        }
      }
    }

    // --- require-skill-spec (SKILL.md) ---
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

  for (const filePath of paths) {
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

    const result = validate(content, {
      ruleMarkers,
      rules: rulesConfig,
      filePath,
    });
    fileResults.push({ path: filePath, skipped: false, reason: null, result });
    if (!result.valid) allValid = false;
  }

  return { fileResults, valid: allValid };
}
