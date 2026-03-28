#!/usr/bin/env node

import { readFileSync, lstatSync, existsSync } from "node:fs";
import { globSync } from "glob";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { cosmiconfigSync } from "cosmiconfig";

const ENFORCED_BY_RE = /\*\*Enforced by:\*\*/;
const GUIDANCE_RE = /\*\*Guidance only\*\*/;
const DISABLE_RE = /<!--\s*agent-lint-disable\s*-->/;
const RULE_HEADER_RE = /^###\s+(.+)$/;
const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+)$/;

const VALID_MARKERS = ["headings", "checkboxes"];
const DEFAULT_RULES = {
  "require-annotations": true,
  "max-lines": 500,
  "require-rule-file": "auto",
};
const SAFE_RULE_NAME_RE = /^[a-zA-Z0-9_\-/.:#]+$/;

// AI coding tools: presence indicators and required instruction files
const AGENT_TOOLS = [
  {
    name: "Claude Code",
    indicators: [".claude"],
    instructionFiles: ["CLAUDE.md"],
  },
  {
    name: "Cursor",
    indicators: [".cursor"],
    instructionFiles: [".cursorrules"],
  },
  {
    name: "Windsurf",
    indicators: [".windsurf"],
    instructionFiles: [".windsurfrules"],
  },
  // Tools where the instruction file IS the indicator
  {
    name: "OpenAI Codex",
    indicators: ["AGENTS.md"],
    instructionFiles: ["AGENTS.md"],
  },
  {
    name: "GitHub Copilot",
    indicators: [".github/copilot-instructions.md"],
    instructionFiles: [".github/copilot-instructions.md"],
  },
  {
    name: "Cline",
    indicators: [".clinerules"],
    instructionFiles: [".clinerules"],
  },
];

const DEFAULT_CONFIG = {
  ruleMarkers: ["headings", "checkboxes"],
  rules: DEFAULT_RULES,
  linters: {},
  agents: null, // null = auto-detect; array = explicit list of tool names
};

function extractLinterName(enforcedBy) {
  const colonIdx = enforcedBy.indexOf("::");
  const slashIdx = enforcedBy.indexOf("/");
  if (colonIdx === -1 && slashIdx === -1) return enforcedBy;
  if (colonIdx === -1) return enforcedBy.substring(0, slashIdx);
  if (slashIdx === -1) return enforcedBy.substring(0, colonIdx);
  return enforcedBy.substring(0, Math.min(slashIdx, colonIdx));
}

function extractRuleName(enforcedBy) {
  const colonIdx = enforcedBy.indexOf("::");
  const slashIdx = enforcedBy.indexOf("/");
  if (colonIdx === -1 && slashIdx === -1) return null;
  if (colonIdx === -1) return enforcedBy.substring(slashIdx + 1);
  if (slashIdx === -1) return enforcedBy.substring(colonIdx + 2);
  const idx = Math.min(slashIdx, colonIdx);
  const sep = idx === colonIdx ? 2 : 1;
  return enforcedBy.substring(idx + sep);
}

function ruleFileExists(ruleName, rulesDir, basePath) {
  const dir = resolve(basePath, rulesDir);
  if (!existsSync(dir)) return null;
  const matches = globSync(`${ruleName}.*`, { cwd: dir });
  return matches.length > 0;
}

// Try to resolve an ESLint plugin's rules by package name
function resolveEslintPluginRules(pluginName, basePath) {
  try {
    const req = createRequire(resolve(basePath, "package.json"));
    // @scope/foo -> @scope/eslint-plugin-foo, or @scope -> @scope/eslint-plugin
    // foo -> eslint-plugin-foo
    let pkgNames;
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
        const plugin = req(pkg);
        const rules = plugin.rules || (plugin.default && plugin.default.rules);
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

// Built-in resolvers: return a Set of valid rule names, or null if linter not available
const LINTER_RESOLVERS = {
  eslint(basePath) {
    const req = createRequire(resolve(basePath, "package.json"));
    const { builtinRules } = req("eslint/use-at-your-own-risk");
    const rules = new Set(builtinRules.keys());
    // Tag with basePath so we can resolve plugins later
    rules._basePath = basePath;
    rules._isEslint = true;
    return rules;
  },
  stylelint(basePath) {
    const req = createRequire(resolve(basePath, "package.json"));
    const mod = req("stylelint");
    return new Set(Object.keys(mod.rules));
  },
};

// CLI-based per-rule checks: throw on failure (rule doesn't exist)
const CLI_RULE_CHECKS = {
  ruff(ruleName) {
    execSync(`ruff rule ${ruleName}`, { stdio: "ignore" });
  },
  clippy(ruleName) {
    execSync(`cargo clippy --explain ${ruleName}`, { stdio: "ignore" });
  },
  pylint(ruleName) {
    const output = execSync(`pylint --help-msg=${ruleName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (output.includes("No such message id")) {
      throw new Error(`Unknown pylint message: ${ruleName}`);
    }
  },
  rubocop(ruleName) {
    // rubocop --show-cops exits 0 for both valid and invalid cops,
    // but outputs nothing for invalid ones
    const output = execSync(`rubocop --show-cops ${ruleName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!output || output.trim().length === 0) {
      throw new Error(`Unknown cop: ${ruleName}`);
    }
  },
};

// Check if a CLI tool is available on PATH
function cliAvailable(command) {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CLI_TOOL_FOR_LINTER = {
  ruff: "ruff",
  clippy: "cargo",
  pylint: "pylint",
  rubocop: "rubocop",
};

/**
 * Detect AI coding tools and their instruction files.
 * @param {string} cwd — directory to scan
 * @param {string[]|null} agents — explicit list of tool names to check, or null for auto-detect
 * Returns { detected, files, missing } where:
 *   detected: [{ name, indicator }] — tools found in the project
 *   files: string[] — instruction files to validate
 *   missing: [{ tool, expected, indicator }] — detected tools missing instruction files
 */
export function discoverInstructionFiles(cwd = process.cwd(), agents = null) {
  const detected = [];
  const files = [];
  const missing = [];
  const seen = new Set();

  const toolsToCheck = agents
    ? AGENT_TOOLS.filter((t) =>
        agents.some((a) => t.name.toLowerCase() === a.toLowerCase()),
      )
    : AGENT_TOOLS;

  for (const tool of toolsToCheck) {
    // In explicit mode, always check (no indicator needed)
    // In auto mode, require an indicator to be present
    const indicator = agents
      ? tool.indicators[0]
      : tool.indicators.find((ind) => existsSync(resolve(cwd, ind)));
    if (!agents && !indicator) continue;

    detected.push({
      name: tool.name,
      indicator: indicator || tool.indicators[0],
    });

    for (const file of tool.instructionFiles) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (existsSync(resolve(cwd, file))) {
        files.push(file);
      } else {
        missing.push({
          tool: tool.name,
          expected: file,
          indicator: indicator || tool.indicators[0],
        });
      }
    }
  }

  return { detected, files, missing };
}

export function loadConfig() {
  try {
    const explorer = cosmiconfigSync("agent-lint", {
      searchPlaces: [".agent-lintrc.json"],
      mergeSearchPlaces: false,
    });
    const result = explorer.search();
    if (!result || !result.config) return DEFAULT_CONFIG;

    const config = {
      ...DEFAULT_CONFIG,
      ...result.config,
      rules: { ...DEFAULT_RULES, ...result.config.rules },
      linters: { ...result.config.linters },
      agents: result.config.agents !== undefined ? result.config.agents : null,
    };

    if (
      !Array.isArray(config.ruleMarkers) ||
      !config.ruleMarkers.every((m) => VALID_MARKERS.includes(m))
    ) {
      console.warn(
        `Invalid ruleMarkers in config: ${JSON.stringify(config.ruleMarkers)}. Using default.`,
      );
      config.ruleMarkers = DEFAULT_CONFIG.ruleMarkers;
    }

    return config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function parseClaudeMd(content, { ruleMarkers } = {}) {
  const markers = ruleMarkers || DEFAULT_CONFIG.ruleMarkers;
  const lines = content.split("\n");
  const rules = [];

  let currentRule = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = markers.includes("headings")
      ? line.match(RULE_HEADER_RE)
      : null;
    const checkboxMatch = markers.includes("checkboxes")
      ? line.match(CHECKBOX_RE)
      : null;

    if (headerMatch || checkboxMatch) {
      // Flush previous rule
      if (currentRule) {
        rules.push(currentRule);
      }
      const title = headerMatch
        ? headerMatch[1].trim()
        : checkboxMatch[2].trim();
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
      currentRule.enforcedBy = enforcedMatch[1];
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

  // Flush last rule
  if (currentRule) {
    rules.push(currentRule);
  }

  return rules;
}

export function validate(
  content,
  { ruleMarkers, rules: rulesConfig, basePath, linters: lintersConfig } = {},
) {
  const activeRules = rulesConfig || DEFAULT_RULES;
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
  const missing = parsedRules.filter((r) => r.enforcement === "missing").length;

  const errors = [];

  if (activeRules["require-annotations"] !== false && missing > 0) {
    for (const rule of parsedRules) {
      if (rule.enforcement === "missing") {
        errors.push({
          rule: "require-annotations",
          message: `Line ${rule.line}: "${rule.title}" is missing an enforcement annotation`,
          line: rule.line,
        });
      }
    }
  }

  const maxLines = activeRules["max-lines"];
  if (maxLines !== false) {
    const limit = typeof maxLines === "number" ? maxLines : 500;
    const lineCount = content.split("\n").length;
    if (lineCount > limit) {
      errors.push({
        rule: "max-lines",
        message: `File has ${lineCount} lines, exceeding the limit of ${limit}. Consider splitting into subdirectory files — see https://github.com/zernie/agent-lint#organizing-rules`,
        line: lineCount,
      });
    }
  }

  const ruleFileMode = activeRules["require-rule-file"];
  const detectedLinters = [];
  if (ruleFileMode !== false && basePath) {
    const resolverCache = new Map(); // linterName -> Set | "cli" | null
    const cliAvailCache = new Map();

    for (const rule of parsedRules) {
      if (rule.enforcement !== "enforced" || !rule.enforcedBy) continue;
      const linterName = extractLinterName(rule.enforcedBy);
      const ruleName = extractRuleName(rule.enforcedBy);
      if (!ruleName || !SAFE_RULE_NAME_RE.test(ruleName)) continue;

      // Resolve linter rules (cached)
      if (!resolverCache.has(linterName)) {
        let result = null;

        // Try Node API resolver
        const resolver = LINTER_RESOLVERS[linterName];
        if (resolver) {
          try {
            result = resolver(basePath);
            if (result instanceof Set) {
              detectedLinters.push({
                name: linterName,
                ruleCount: result.size,
              });
            }
          } catch {
            result = null;
          }
        }

        // Try as ESLint plugin (e.g. @typescript-eslint, import, react)
        if (!result) {
          const pluginRules = resolveEslintPluginRules(linterName, basePath);
          if (pluginRules) {
            result = pluginRules;
            detectedLinters.push({
              name: linterName,
              ruleCount: pluginRules.size,
            });
          }
        }

        // Try CLI resolver
        if (!result && CLI_RULE_CHECKS[linterName]) {
          const tool = CLI_TOOL_FOR_LINTER[linterName];
          if (!cliAvailCache.has(tool)) {
            cliAvailCache.set(tool, cliAvailable(tool));
          }
          if (cliAvailCache.get(tool)) {
            result = "cli";
            detectedLinters.push({ name: linterName, via: "cli" });
          }
        }

        resolverCache.set(linterName, result);
      }

      const resolved = resolverCache.get(linterName);

      // Check via Node API resolver (Set of rules)
      if (resolved instanceof Set) {
        if (!resolved.has(ruleName)) {
          // For eslint: rule might be a plugin rule (e.g. "import/no-unresolved")
          let foundInPlugin = false;
          if (resolved._isEslint && ruleName.includes("/")) {
            const pluginPrefix = ruleName.substring(0, ruleName.indexOf("/"));
            const pluginRuleName = ruleName.substring(
              ruleName.indexOf("/") + 1,
            );
            const pluginRules = resolveEslintPluginRules(
              pluginPrefix,
              resolved._basePath,
            );
            if (pluginRules && pluginRules.has(pluginRuleName)) {
              foundInPlugin = true;
            }
          }
          if (!foundInPlugin) {
            errors.push({
              rule: "require-rule-file",
              message: `Rule "${ruleName}" not found in ${linterName} (referenced in "${rule.title}", line ${rule.line})`,
              line: rule.line,
            });
          }
        }
        continue;
      }

      // Check via CLI
      if (resolved === "cli") {
        const cliCheck = CLI_RULE_CHECKS[linterName];
        try {
          cliCheck(ruleName);
        } catch {
          errors.push({
            rule: "require-rule-file",
            message: `Rule "${ruleName}" not found in ${linterName} (referenced in "${rule.title}", line ${rule.line})`,
            line: rule.line,
          });
        }
        continue;
      }

      // Fallback: rulesDir from user config
      const linterCfg = lintersConfig && lintersConfig[linterName];
      if (linterCfg && linterCfg.rulesDir) {
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
            message: `Rule file for "${ruleName}" not found in ${dirs.join(", ")} (referenced in "${rule.title}", line ${rule.line})`,
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
    missing,
    total: parsedRules.length,
    errors,
    valid: errors.length === 0,
    detectedLinters,
  };
}

/**
 * Read a file, optionally checking if it's a symlink.
 * Returns { content, skipped, reason } where skipped=true means the file was
 * a symlink and follow-symlinks was not enabled.
 */
export function readClaudeMd(filePath, { followSymlinks = false } = {}) {
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

/**
 * Expand an array of file paths / glob patterns into resolved file paths.
 * Plain paths that don't contain glob characters are kept as-is.
 */
export function expandGlobs(patterns) {
  const GLOB_CHARS = /[*?{[]/;
  const paths = [];

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

/**
 * Validate multiple CLAUDE.md files. Returns a combined report.
 */
export function validatePaths(
  paths,
  {
    followSymlinks = false,
    ruleMarkers,
    rules: rulesConfig,
    linters: lintersConfig,
  } = {},
) {
  const fileResults = [];
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
    });
    if (!result.valid) allValid = false;
    fileResults.push({ path: filePath, skipped: false, reason: null, result });
  }

  return { fileResults, valid: allValid };
}

function printResult(filePath, result) {
  console.log("");
  console.log(`Validation Report: ${filePath}`);
  console.log("=".repeat(40));
  console.log(`  Total rules:    ${result.total}`);
  console.log(`  Enforced:       ${result.enforced}`);
  console.log(`  Guidance only:  ${result.guidanceOnly}`);
  console.log(`  Disabled:       ${result.disabled}`);
  console.log(`  Missing:        ${result.missing}`);
  if (result.detectedLinters && result.detectedLinters.length > 0) {
    const parts = result.detectedLinters.map((l) =>
      l.ruleCount
        ? `${l.name} (${l.ruleCount} built-in rules)`
        : `${l.name} (cli)`,
    );
    console.log(`  Linters:        ${parts.join(", ")}`);
  }
  console.log("=".repeat(40));

  if (result.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const error of result.errors) {
      console.log(`  [${error.rule}] ${error.message}`);
      console.log(
        `::error file=${filePath},line=${error.line}::${error.message}`,
      );
    }
  }
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("validate.mjs") ||
    process.argv[1].endsWith("validate") ||
    process.argv[1].endsWith("agent-lint"))
) {
  const args = process.argv.slice(2);
  const followSymlinks = args.includes("--follow-symlinks");
  const markersArg = args.find((a) => a.startsWith("--markers="));
  const rawPaths = args.filter((a) => !a.startsWith("--"));

  const config = loadConfig();

  let discoveryMissing = [];
  if (rawPaths.length === 0) {
    const discovery = discoverInstructionFiles(process.cwd(), config.agents);
    if (discovery.detected.length > 0) {
      const tools = discovery.detected
        .map((d) => `${d.name} (${d.indicator})`)
        .join(", ");
      console.log(`Detected agents: ${tools}`);
    }
    rawPaths.push(...discovery.files);
    discoveryMissing = discovery.missing;
  }

  const paths = expandGlobs(rawPaths);

  const ruleMarkers = markersArg
    ? markersArg.split("=")[1].split(",")
    : config.ruleMarkers;

  const { fileResults, valid } = validatePaths(paths, {
    followSymlinks,
    ruleMarkers,
    rules: config.rules,
    linters: config.linters,
  });

  for (const { path: filePath, skipped, reason, result } of fileResults) {
    if (skipped) {
      console.log(`\nSkipped: ${reason}`);
      continue;
    }
    if (!result) {
      console.log(`\n::error::${reason}`);
      continue;
    }
    printResult(filePath, result);
  }

  let hasMissing = false;
  for (const m of discoveryMissing) {
    console.log(
      `\n::error::${m.tool} detected (${m.indicator}) but ${m.expected} is missing`,
    );
    hasMissing = true;
  }

  console.log("");
  if (valid && !hasMissing) {
    console.log("All rules have enforcement annotations.");
  } else {
    if (!valid) {
      console.log(
        "Add **Enforced by:** `<rule>` or **Guidance only** to each rule.",
      );
    }
    if (hasMissing) {
      console.log("Create missing instruction files for detected agents.");
    }
    console.log("");
    console.log("::error::Validation failed — see report above");
    process.exit(1);
  }
}
