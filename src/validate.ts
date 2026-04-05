import { readFileSync, lstatSync, existsSync } from "node:fs";
import { globSync } from "glob";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { cosmiconfigSync } from "cosmiconfig";
import { minimatch } from "minimatch";

import type {
  ParsedRule,
  ValidationError,
  DetectedLinter,
  ValidationResult,
  ReadResult,
  FileResult,
  ValidatePathsResult,
  RulesConfig,
  LinterConfig,
  StructureEntry,
  VigilesConfig,
  MarkerType,
  ParseOptions,
  ValidateOptions,
  ValidatePathsOptions,
  ReadOptions,
  StructureValidationResult,
  EslintRuleSet,
  RulePack,
  ConfigEnabledStatus,
} from "./types.js";

// Re-export all types for consumers
export type {
  ParsedRule,
  ValidationError,
  DetectedLinter,
  ValidationResult,
  ReadResult,
  FileResult,
  ValidatePathsResult,
  RulesConfig,
  LinterConfig,
  StructureEntry,
  VigilesConfig,
  MarkerType,
  ParseOptions,
  ValidateOptions,
  ValidatePathsOptions,
  ReadOptions,
  StructureValidationResult,
  RulePack,
};

// ---------------------------------------------------------------------------
// Constants & regex
// ---------------------------------------------------------------------------

const GUIDANCE_RE = /\*\*Guidance only\*\*/;
const DISABLE_RE = /<!--\s*vigiles-disable\s*-->/;
const RULE_HEADER_RE = /^###\s+(.+)$/;
const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+)$/;

const VALID_MARKERS: readonly MarkerType[] = ["headings", "checkboxes"];
const SAFE_RULE_NAME_RE = /^[a-zA-Z0-9_\-/.:#]+$/;

// Near-miss patterns for typo detection (case-insensitive variants)
const NEAR_MISS_ENFORCED_RE = /\*\*enforce[ds]?\s*by:?\*\*/i;
const NEAR_MISS_GUIDANCE_RE = /\*\*guidance\b.*\*\*/i;

// Markdown link: [text](target) — captures the target
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
// Skip any URI-scheme link (http, https, mailto, ftp, tel, vscode, etc.) and anchors
const EXTERNAL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:|#)/;
// Fenced code block delimiter (up to 3 leading spaces per CommonMark)
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// Built-in schema presets (bundled .yml files in schemas/)
const SCHEMAS_DIR = resolve(__dirname, "..", "schemas");

export const STRUCTURE_PRESETS: Record<string, string> = {
  "claude-md": resolve(SCHEMAS_DIR, "claude-md.yml"),
  "claude-md:strict": resolve(SCHEMAS_DIR, "claude-md-strict.yml"),
  skill: resolve(SCHEMAS_DIR, "skill.yml"),
  "skill:strict": resolve(SCHEMAS_DIR, "skill-strict.yml"),
};

// Rule packs — like eslint's "recommended" / "strict" configs
export const RULE_PACKS: Record<string, RulePack> = {
  recommended: {
    rules: {
      "require-annotations": true,
      "max-lines": 500,
      "require-rule-file": "auto",
      "require-structure": false,
      "no-broken-links": true,
    },
    structures: [],
  },
  strict: {
    rules: {
      "require-annotations": true,
      "max-lines": 300,
      "require-rule-file": "auto",
      "require-structure": true,
      "no-broken-links": true,
    },
    structures: [
      { files: "CLAUDE.md", schema: "claude-md:strict" },
      { files: "**/SKILL.md", schema: "skill:strict" },
    ],
  },
};

const DEFAULT_RULES: Required<RulesConfig> = RULE_PACKS["recommended"].rules;

// ---------------------------------------------------------------------------
// mdschema integration
// ---------------------------------------------------------------------------

function findMdschema(): string | null {
  try {
    const req = createRequire(resolve(process.cwd(), "package.json"));
    const { getBinaryPath } = req("@jackchuka/mdschema/lib/platform") as {
      getBinaryPath: () => string;
    };
    const bin = getBinaryPath();
    if (existsSync(bin)) return bin;
  } catch {
    // not installed via npm
  }
  try {
    execSync("which mdschema", { stdio: "ignore" });
    return "mdschema";
  } catch {
    return null;
  }
}

let _mdschemaPath: string | null | undefined;
function getMdschema(): string | null {
  if (_mdschemaPath === undefined) {
    _mdschemaPath = findMdschema();
  }
  return _mdschemaPath;
}

const MDSCHEMA_ERROR_RE = /^\s*✗\s+(\d+):(\d+)\s+\[([^\]]+)\]\s+(.+)$/;

export function validateStructure(
  filePath: string,
  schemaPath: string,
): StructureValidationResult {
  const bin = getMdschema();
  if (!bin) {
    return { errors: [], available: false };
  }
  try {
    execSync(`${bin} check --schema ${schemaPath} ${filePath}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    return { errors: [], available: true };
  } catch (e: unknown) {
    const execErr = e as { stdout?: string; stderr?: string };
    const output = (execErr.stdout ?? "") + (execErr.stderr ?? "");
    const errors: ValidationError[] = [];
    for (const line of output.split("\n")) {
      const m = line.match(MDSCHEMA_ERROR_RE);
      if (m) {
        errors.push({
          rule: "require-structure",
          message: `[${m[3]}] ${m[4]}`,
          line: parseInt(m[1], 10),
        });
      }
    }
    return { errors, available: true };
  }
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_FILES: string[] = ["CLAUDE.md"];

const DEFAULT_CONFIG: VigilesConfig = {
  extends: "recommended",
  ruleMarkers: ["headings", "checkboxes"],
  rules: DEFAULT_RULES,
  linters: {},
  files: DEFAULT_FILES,
  structures: [],
};

// ---------------------------------------------------------------------------
// Linter helpers
// ---------------------------------------------------------------------------

function extractLinterName(enforcedBy: string): string {
  const colonIdx = enforcedBy.indexOf("::");
  const slashIdx = enforcedBy.indexOf("/");
  if (colonIdx === -1 && slashIdx === -1) return enforcedBy;
  if (colonIdx === -1) return enforcedBy.substring(0, slashIdx);
  if (slashIdx === -1) return enforcedBy.substring(0, colonIdx);
  return enforcedBy.substring(0, Math.min(slashIdx, colonIdx));
}

function extractRuleName(enforcedBy: string): string | null {
  const colonIdx = enforcedBy.indexOf("::");
  const slashIdx = enforcedBy.indexOf("/");
  if (colonIdx === -1 && slashIdx === -1) return null;
  if (colonIdx === -1) return enforcedBy.substring(slashIdx + 1);
  if (slashIdx === -1) return enforcedBy.substring(colonIdx + 2);
  const idx = Math.min(slashIdx, colonIdx);
  const sep = idx === colonIdx ? 2 : 1;
  return enforcedBy.substring(idx + sep);
}

function ruleFileExists(
  ruleName: string,
  rulesDir: string,
  basePath: string,
): boolean | null {
  const dir = resolve(basePath, rulesDir);
  if (!existsSync(dir)) return null;
  const matches = globSync(`${ruleName}.*`, { cwd: dir });
  return matches.length > 0;
}

function resolveEslintPluginRules(
  pluginName: string,
  basePath: string,
): Set<string> | null {
  try {
    const req = createRequire(resolve(basePath, "package.json"));
    let pkgNames: string[];
    if (pluginName.startsWith("@")) {
      const parts = pluginName.split("/");
      if (parts.length === 1) {
        pkgNames = [`${parts[0]}/eslint-plugin`];
      } else {
        pkgNames = [
          `${parts[0]}/eslint-plugin-${parts[1]}`,
          `${parts[0]}/eslint-plugin`,
        ];
      }
    } else {
      pkgNames = [`eslint-plugin-${pluginName}`];
    }
    for (const pkg of pkgNames) {
      try {
        const plugin = req(pkg) as {
          rules?: Record<string, unknown>;
          default?: { rules?: Record<string, unknown> };
        };
        const rules = plugin.rules ?? plugin.default?.rules;
        if (rules) return new Set(Object.keys(rules));
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Built-in resolvers
const LINTER_RESOLVERS: Record<
  string,
  (basePath: string) => EslintRuleSet | Set<string>
> = {
  eslint(basePath: string): EslintRuleSet {
    const req = createRequire(resolve(basePath, "package.json"));
    const { builtinRules } = req("eslint/use-at-your-own-risk") as {
      builtinRules: Map<string, unknown>;
    };
    const rules: EslintRuleSet = new Set(builtinRules.keys());
    rules._basePath = basePath;
    rules._isEslint = true;
    return rules;
  },
  stylelint(basePath: string): Set<string> {
    const req = createRequire(resolve(basePath, "package.json"));
    const mod = req("stylelint") as { rules: Record<string, unknown> };
    return new Set(Object.keys(mod.rules));
  },
};

// CLI-based per-rule checks
const CLI_RULE_CHECKS: Record<string, (ruleName: string) => void> = {
  ruff(ruleName: string): void {
    execSync(`ruff rule ${ruleName}`, { stdio: "ignore" });
  },
  clippy(ruleName: string): void {
    execSync(`cargo clippy --explain ${ruleName}`, { stdio: "ignore" });
  },
  pylint(ruleName: string): void {
    const output = execSync(`pylint --help-msg=${ruleName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (output.includes("No such message id")) {
      throw new Error(`Unknown pylint message: ${ruleName}`);
    }
  },
  rubocop(ruleName: string): void {
    const output = execSync(`rubocop --show-cops ${ruleName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!output || output.trim().length === 0) {
      throw new Error(`Unknown cop: ${ruleName}`);
    }
  },
};

// Config-enabled checkers
type ConfigLoader = (ruleName: string) => ConfigEnabledStatus;

function createCachedChecker(
  loadConfigFn: (basePath: string) => ConfigLoader | null,
): (ruleName: string, basePath: string) => ConfigEnabledStatus {
  const cache = new Map<string, ConfigLoader | null>();
  return (ruleName: string, basePath: string): ConfigEnabledStatus => {
    if (!cache.has(basePath)) {
      try {
        cache.set(basePath, loadConfigFn(basePath));
      } catch {
        cache.set(basePath, null);
      }
    }
    const config = cache.get(basePath);
    if (!config) return "unknown";
    return config(ruleName);
  };
}

const LINTER_CONFIG_CHECKERS: Record<
  string,
  (ruleName: string, basePath: string) => ConfigEnabledStatus
> = {
  eslint: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const script = `
        const { loadESLint } = require("eslint");
        (async () => {
          try {
            const ESLint = await loadESLint();
            const eslint = new ESLint({ cwd: ${JSON.stringify(basePath)} });
            const config = await eslint.calculateConfigForFile("dummy.js");
            console.log(JSON.stringify(config.rules || {}));
          } catch(e) {
            console.log("{}");
          }
        })();
      `;
      const output = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      const rules = JSON.parse(output.trim() || "{}") as Record<
        string,
        unknown
      >;
      return (ruleName: string): ConfigEnabledStatus => {
        if (!(ruleName in rules)) return "unknown";
        const setting: unknown = rules[ruleName];
        const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
        if (severity === 0 || severity === "off") return "disabled";
        return "enabled";
      };
    } catch {
      return null;
    }
  }),

  stylelint: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const script = `
        const stylelint = require("stylelint");
        (async () => {
          try {
            const linter = stylelint.createLinter({});
            const result = await linter.getConfigForFile(${JSON.stringify(resolve(basePath, "dummy.css"))});
            console.log(JSON.stringify(result.config.rules || {}));
          } catch(e) {
            console.log("{}");
          }
        })();
      `;
      const output = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      const rules = JSON.parse(output.trim() || "{}") as Record<
        string,
        unknown
      >;
      return (ruleName: string): ConfigEnabledStatus => {
        if (!(ruleName in rules)) return "unknown";
        const setting = rules[ruleName];
        if (setting === null || (Array.isArray(setting) && setting[0] === null))
          return "disabled";
        return "enabled";
      };
    } catch {
      return null;
    }
  }),

  ruff: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const dummyPath = resolve(basePath, "dummy.py");
      const output = execSync(`ruff check --show-settings ${dummyPath}`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      });
      const enabledMatch = output.match(
        /linter\.rules\.enabled\s*=\s*\[([\s\S]*?)\]/,
      );
      const enabledCodes = new Set<string>();
      if (enabledMatch?.[1]) {
        const codeRe = /\(([A-Z]+\d*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = codeRe.exec(enabledMatch[1])) !== null) {
          enabledCodes.add(m[1]);
        }
      }
      return (ruleName: string): ConfigEnabledStatus => {
        if (enabledCodes.has(ruleName)) return "enabled";
        for (const code of enabledCodes) {
          if (code.startsWith(ruleName)) return "enabled";
        }
        return "disabled";
      };
    } catch {
      return null;
    }
  }),

  pylint: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const output = execSync("pylint --list-msgs-enabled", {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      const disabledIdx = output.indexOf("Disabled messages:");
      const enabledSection =
        disabledIdx >= 0 ? output.substring(0, disabledIdx) : output;
      const disabledSection =
        disabledIdx >= 0 ? output.substring(disabledIdx) : "";
      return (ruleName: string): ConfigEnabledStatus => {
        if (disabledSection.includes(ruleName)) return "disabled";
        if (enabledSection.includes(ruleName)) return "enabled";
        return "unknown";
      };
    } catch {
      return null;
    }
  }),

  rubocop(ruleName: string, basePath: string): ConfigEnabledStatus {
    try {
      const output = execSync(`rubocop --show-cops ${ruleName}`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "ignore"],
      });
      if (!output || output.trim().length === 0) return "unknown";
      const enabledMatch = output.match(/Enabled:\s*(true|false|pending)/);
      if (!enabledMatch) return "unknown";
      return enabledMatch[1] === "true" ? "enabled" : "disabled";
    } catch {
      return "unknown";
    }
  },

  clippy: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const cargoPath = resolve(basePath, "Cargo.toml");
      if (!existsSync(cargoPath)) return null;
      const content = readFileSync(cargoPath, "utf-8");
      const sectionMatch = content.match(
        /\[lints\.clippy\]([\s\S]*?)(?=\n\[|$)/,
      );
      if (!sectionMatch?.[1]) return null;
      const section = sectionMatch[1];
      return (ruleName: string): ConfigEnabledStatus => {
        const shortName = ruleName.replace(/^clippy::/, "");
        const ruleMatch = section.match(
          new RegExp(
            `${shortName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*"(\\w+)"`,
          ),
        );
        if (!ruleMatch?.[1]) return "unknown";
        return ruleMatch[1] === "allow" ? "disabled" : "enabled";
      };
    } catch {
      return null;
    }
  }),
};

function cliAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CLI_TOOL_FOR_LINTER: Record<string, string> = {
  ruff: "ruff",
  clippy: "cargo",
  pylint: "pylint",
  rubocop: "rubocop",
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
// Schema resolution
// ---------------------------------------------------------------------------

export function resolveSchema(schema: unknown): string | null {
  if (typeof schema !== "string") {
    console.warn(
      `Invalid schema value: expected a preset name or file path string. Skipping.`,
    );
    return null;
  }
  const preset = STRUCTURE_PRESETS[schema];
  if (preset) return preset;
  const resolved = resolve(schema);
  if (existsSync(resolved)) return resolved;
  console.warn(`Schema not found: "${schema}". Skipping.`);
  return null;
}

function resolveStructures(raw: unknown): StructureEntry[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ files: string; schema: unknown }>)
    .map((entry) => {
      const schema = resolveSchema(entry.schema);
      if (!schema) return null;
      return { files: entry.files, schema };
    })
    .filter((entry): entry is StructureEntry => entry !== null);
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
      extends?: string;
      rules?: Partial<RulesConfig>;
      structures?: unknown;
    };

    const packName = userConfig.extends ?? "recommended";
    const pack = RULE_PACKS[packName];
    if (!pack) {
      console.warn(`Unknown rule pack: "${packName}". Using "recommended".`);
    }
    const basePack = pack ?? RULE_PACKS["recommended"];

    const config: VigilesConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      rules: { ...basePack.rules, ...userConfig.rules },
      linters: { ...userConfig.linters },
      files: Array.isArray(userConfig.files) ? userConfig.files : DEFAULT_FILES,
      structures: resolveStructures(
        userConfig.structures ?? basePack.structures,
      ),
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

export function parseClaudeMd(
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
  {
    ruleMarkers,
    rules: rulesConfig,
    basePath,
    linters: lintersConfig,
    structures,
    filePath,
  }: ValidateOptions = {},
): ValidationResult {
  const activeRules = rulesConfig ?? DEFAULT_RULES;
  const parsedRules = parseClaudeMd(content, { ruleMarkers });
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

  if (activeRules["require-annotations"] !== false && missingCount > 0) {
    const lines = content.split("\n");
    for (let ri = 0; ri < parsedRules.length; ri++) {
      const rule = parsedRules[ri];
      if (rule.enforcement !== "missing") continue;

      // Scan lines between this rule and the next for near-miss annotations
      const startLine = rule.line; // 1-based, header itself
      const endLine =
        ri + 1 < parsedRules.length
          ? parsedRules[ri + 1].line - 1
          : lines.length;

      let nearMiss: { text: string; line: number; suggestion: string } | null =
        null;
      for (let li = startLine; li < endLine; li++) {
        const line = lines[li]; // 0-based array, li is already offset
        if (!nearMiss && NEAR_MISS_ENFORCED_RE.test(line)) {
          // Only flag if it's NOT the exact correct pattern
          if (!/\*\*Enforced by:\*\*/.test(line)) {
            const match = line.match(/(\*\*[^*]+\*\*)/);
            nearMiss = {
              text: match?.[1] ?? line.trim(),
              line: li + 1,
              suggestion: "**Enforced by:** `<rule>`",
            };
          }
        }
        if (!nearMiss && NEAR_MISS_GUIDANCE_RE.test(line)) {
          if (!/\*\*Guidance only\*\*/.test(line)) {
            const match = line.match(/(\*\*[^*]+\*\*)/);
            nearMiss = {
              text: match?.[1] ?? line.trim(),
              line: li + 1,
              suggestion: "**Guidance only**",
            };
          }
        }
      }

      if (nearMiss) {
        errors.push({
          rule: "require-annotations",
          message: `Line ${String(nearMiss.line)}: near-miss annotation ${nearMiss.text} — did you mean ${nearMiss.suggestion}?`,
          line: nearMiss.line,
        });
      } else {
        errors.push({
          rule: "require-annotations",
          message: `Line ${String(rule.line)}: "${rule.title}" is missing an enforcement annotation`,
          line: rule.line,
        });
      }
    }
  }

  const maxLines = activeRules["max-lines"];
  if (maxLines !== false && maxLines !== undefined) {
    const limit = typeof maxLines === "number" ? maxLines : 500;
    const lineCount = content.split("\n").length;
    if (lineCount > limit) {
      errors.push({
        rule: "max-lines",
        message: `File has ${String(lineCount)} lines, exceeding the limit of ${String(limit)}. Consider splitting into subdirectory files — see https://github.com/zernie/vigiles#organizing-rules`,
        line: lineCount,
      });
    }
  }

  // --- no-broken-links ---
  if (activeRules["no-broken-links"] !== false && basePath) {
    const lines = content.split("\n");
    let fenceDelimiter: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      // Track fenced code blocks — match opening char and min length to close
      const fenceMatch = lines[i].match(FENCE_RE);
      if (fenceMatch) {
        const char = fenceMatch[1][0]; // ` or ~
        const len = fenceMatch[1].length;
        if (fenceDelimiter === null) {
          fenceDelimiter = char.repeat(len);
        } else if (char === fenceDelimiter[0] && len >= fenceDelimiter.length) {
          fenceDelimiter = null;
        }
        continue;
      }
      if (fenceDelimiter !== null) continue;

      // Strip inline code spans before scanning for links
      const lineText = lines[i].replace(/`[^`]+`/g, "");
      let m: RegExpExecArray | null;
      MD_LINK_RE.lastIndex = 0;
      while ((m = MD_LINK_RE.exec(lineText)) !== null) {
        // Strip optional link title: [text](path "title")
        const raw = m[2].replace(/\s+"[^"]*"$/, "").replace(/\s+'[^']*'$/, "");
        const target = raw.split(/[#?]/)[0]; // strip fragment/query
        if (!target || EXTERNAL_RE.test(raw)) continue;
        const resolved = resolve(basePath, target);
        if (!existsSync(resolved)) {
          errors.push({
            rule: "no-broken-links",
            message: `Broken link: [${m[1]}](${m[2]}) — "${target}" does not exist (line ${String(i + 1)})`,
            line: i + 1,
          });
        }
      }
    }
  }

  // --- require-structure ---
  if (activeRules["require-structure"] !== false && structures && filePath) {
    for (const entry of structures) {
      const basename = filePath.split("/").pop() ?? "";
      if (
        minimatch(filePath, entry.files, { matchBase: true }) ||
        minimatch(basename, entry.files)
      ) {
        const { errors: structErrors, available } = validateStructure(
          resolve(filePath),
          entry.schema,
        );
        if (!available) {
          errors.push({
            rule: "require-structure",
            message:
              "mdschema is not installed. Install with: npm install @jackchuka/mdschema",
            line: 1,
          });
          break;
        }
        errors.push(...structErrors);
      }
    }
  }

  // --- require-rule-file ---
  const ruleFileMode = activeRules["require-rule-file"];
  const detectedLinters: DetectedLinter[] = [];
  if (ruleFileMode !== false && basePath) {
    const resolverCache = new Map<
      string,
      EslintRuleSet | Set<string> | "cli" | null
    >();
    const cliAvailCache = new Map<string, boolean>();

    for (const rule of parsedRules) {
      if (rule.enforcement !== "enforced" || !rule.enforcedBy) continue;
      const linterName = extractLinterName(rule.enforcedBy);
      const ruleName = extractRuleName(rule.enforcedBy);
      if (!ruleName || !SAFE_RULE_NAME_RE.test(ruleName)) continue;

      // Resolve linter rules (cached)
      if (!resolverCache.has(linterName)) {
        let resolved: EslintRuleSet | Set<string> | "cli" | null = null;

        const resolver = LINTER_RESOLVERS[linterName];
        if (resolver) {
          try {
            resolved = resolver(basePath);
            if (resolved instanceof Set) {
              detectedLinters.push({
                name: linterName,
                ruleCount: resolved.size,
              });
            }
          } catch {
            resolved = null;
          }
        }

        if (!resolved) {
          const pluginRules = resolveEslintPluginRules(linterName, basePath);
          if (pluginRules) {
            resolved = pluginRules;
            detectedLinters.push({
              name: linterName,
              ruleCount: pluginRules.size,
            });
          }
        }

        if (!resolved && CLI_RULE_CHECKS[linterName]) {
          const tool = CLI_TOOL_FOR_LINTER[linterName];
          if (tool) {
            if (!cliAvailCache.has(tool)) {
              cliAvailCache.set(tool, cliAvailable(tool));
            }
            if (cliAvailCache.get(tool)) {
              resolved = "cli";
              detectedLinters.push({ name: linterName, via: "cli" });
            }
          }
        }

        resolverCache.set(linterName, resolved);
      }

      const resolved = resolverCache.get(linterName);

      const checkConfigEnabled = (): void => {
        if (ruleFileMode === "catalog-only") return;
        const checker = LINTER_CONFIG_CHECKERS[linterName];
        if (!checker) return;
        try {
          const status = checker(ruleName, basePath);
          if (status === "disabled") {
            errors.push({
              rule: "require-rule-file",
              message: `Rule "${ruleName}" exists but is disabled in ${linterName} config (referenced in "${rule.title}", line ${String(rule.line)})`,
              line: rule.line,
            });
          }
        } catch {
          // Can't determine config status — skip
        }
      };

      if (resolved instanceof Set) {
        const eslintSet = resolved as EslintRuleSet;
        if (!resolved.has(ruleName)) {
          let foundInPlugin = false;
          if (eslintSet._isEslint && ruleName.includes("/")) {
            const pluginPrefix = ruleName.substring(0, ruleName.indexOf("/"));
            const pluginRuleName = ruleName.substring(
              ruleName.indexOf("/") + 1,
            );
            const pluginRules = resolveEslintPluginRules(
              pluginPrefix,
              eslintSet._basePath ?? basePath,
            );
            if (pluginRules?.has(pluginRuleName)) {
              foundInPlugin = true;
            }
          }
          if (!foundInPlugin) {
            errors.push({
              rule: "require-rule-file",
              message: `Rule "${ruleName}" not found in ${linterName} (referenced in "${rule.title}", line ${String(rule.line)})`,
              line: rule.line,
            });
          } else {
            checkConfigEnabled();
          }
        } else {
          checkConfigEnabled();
        }
        continue;
      }

      if (resolved === "cli") {
        const cliCheck = CLI_RULE_CHECKS[linterName];
        try {
          cliCheck(ruleName);
          checkConfigEnabled();
        } catch {
          errors.push({
            rule: "require-rule-file",
            message: `Rule "${ruleName}" not found in ${linterName} (referenced in "${rule.title}", line ${String(rule.line)})`,
            line: rule.line,
          });
        }
        continue;
      }

      // Fallback: rulesDir
      const linterCfg = lintersConfig?.[linterName];
      if (linterCfg?.rulesDir) {
        const dirs = Array.isArray(linterCfg.rulesDir)
          ? linterCfg.rulesDir
          : [linterCfg.rulesDir];

        let found = false;
        let anyDirExists = false;
        for (const dir of dirs) {
          const absDir = resolve(basePath, dir);
          if (!existsSync(absDir)) continue;
          anyDirExists = true;
          if (ruleFileExists(ruleName, dir, basePath)) {
            found = true;
            break;
          }
        }

        if (!anyDirExists) {
          errors.push({
            rule: "require-rule-file",
            message: `Rules directory "${dirs.join(", ")}" for linter "${linterName}" does not exist`,
            line: rule.line,
          });
        } else if (!found) {
          errors.push({
            rule: "require-rule-file",
            message: `Rule file for "${ruleName}" not found in ${dirs.join(", ")} (referenced in "${rule.title}", line ${String(rule.line)})`,
            line: rule.line,
          });
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
    valid: errors.length === 0,
    detectedLinters,
  };
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

export function readClaudeMd(
  filePath: string,
  { followSymlinks = false }: ReadOptions = {},
): ReadResult {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() && !followSymlinks) {
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
    linters: lintersConfig,
    structures,
  }: ValidatePathsOptions = {},
): ValidatePathsResult {
  const fileResults: FileResult[] = [];
  let allValid = true;

  for (const filePath of paths) {
    const { content, skipped, reason } = readClaudeMd(filePath, {
      followSymlinks,
    });

    if (skipped) {
      fileResults.push({ path: filePath, skipped: true, reason, result: null });
      continue;
    }

    if (content === null) {
      fileResults.push({
        path: filePath,
        skipped: false,
        reason,
        result: null,
      });
      allValid = false;
      continue;
    }

    const result = validate(content, {
      ruleMarkers,
      rules: rulesConfig,
      basePath: dirname(resolve(filePath)),
      linters: lintersConfig,
      structures,
      filePath,
    });
    if (!result.valid) allValid = false;
    fileResults.push({ path: filePath, skipped: false, reason: null, result });
  }

  return { fileResults, valid: allValid };
}
