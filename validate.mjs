#!/usr/bin/env node

import { readFileSync, lstatSync } from "node:fs";
import { cosmiconfigSync } from "cosmiconfig";

const ENFORCED_BY_RE = /\*\*Enforced by:\*\*/;
const GUIDANCE_RE = /\*\*Guidance only\*\*/;
const DISABLE_RE = /<!--\s*agent-lint-disable\s*-->/;
const RULE_HEADER_RE = /^###\s+(.+)$/;
const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+)$/;

const VALID_MARKERS = ["headings", "checkboxes"];
const DEFAULT_CONFIG = { ruleMarkers: ["headings"] };

export function loadConfig() {
  try {
    const explorer = cosmiconfigSync("agent-lint");
    const result = explorer.search();
    if (!result || !result.config) return DEFAULT_CONFIG;

    const config = { ...DEFAULT_CONFIG, ...result.config };

    if (
      Array.isArray(config.ruleMarkers) &&
      config.ruleMarkers.every((m) => VALID_MARKERS.includes(m))
    ) {
      return config;
    }

    console.warn(
      `Invalid ruleMarkers in config: ${JSON.stringify(config.ruleMarkers)}. Using default.`,
    );
    return DEFAULT_CONFIG;
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

export function validate(content, { ruleMarkers } = {}) {
  const rules = parseClaudeMd(content, { ruleMarkers });
  const enforced = rules.filter((r) => r.enforcement === "enforced").length;
  const guidanceOnly = rules.filter((r) => r.enforcement === "guidance").length;
  const disabled = rules.filter((r) => r.enforcement === "disabled").length;
  const missing = rules.filter((r) => r.enforcement === "missing").length;

  return {
    rules,
    enforced,
    guidanceOnly,
    disabled,
    missing,
    total: rules.length,
    valid: missing === 0,
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
  { followSymlinks = false, ruleMarkers } = {},
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

    const result = validate(content, { ruleMarkers });
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

  if (result.missing > 0) {
    console.log("");
    console.log("Rules missing enforcement annotations:");
    for (const rule of result.rules) {
      if (rule.enforcement === "missing") {
        console.log(`  Line ${rule.line}: "${rule.title}"`);
      }
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
