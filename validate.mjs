#!/usr/bin/env node

import { readFileSync, lstatSync } from "node:fs";
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
};
const DEFAULT_CONFIG = { ruleMarkers: ["headings"], rules: DEFAULT_RULES };

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

export function validate(content, { ruleMarkers, rules: rulesConfig } = {}) {
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
        message: `File has ${lineCount} lines, exceeding the limit of ${limit}`,
        line: lineCount,
      });
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
 * Validate multiple CLAUDE.md files. Returns a combined report.
 */
export function validatePaths(
  paths,
  { followSymlinks = false, ruleMarkers, rules: rulesConfig } = {},
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

    const result = validate(content, { ruleMarkers, rules: rulesConfig });
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
  console.log("=".repeat(40));

  if (result.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const error of result.errors) {
      console.log(`  [${error.rule}] ${error.message}`);
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
  const paths = args.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    paths.push("CLAUDE.md");
  }

  const config = loadConfig();
  const ruleMarkers = markersArg
    ? markersArg.split("=")[1].split(",")
    : config.ruleMarkers;

  const { fileResults, valid } = validatePaths(paths, {
    followSymlinks,
    ruleMarkers,
    rules: config.rules,
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

  console.log("");
  if (valid) {
    console.log("All rules have enforcement annotations.");
  } else {
    console.log(
      "Add **Enforced by:** `<rule>` or **Guidance only** to each rule.",
    );
    console.log("");
    console.log("::error::Validation failed — see report above");
    process.exit(1);
  }
}
