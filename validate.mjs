import { readFileSync, lstatSync } from "node:fs";

const ENFORCED_BY_RE = /\*\*Enforced by:\*\*/;
const GUIDANCE_RE = /\*\*Guidance only\*\*/;
const RULE_HEADER_RE = /^###\s+(.+)$/;

export function parseClaudeMd(content) {
  const lines = content.split("\n");
  const rules = [];

  let currentRule = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(RULE_HEADER_RE);

    if (headerMatch) {
      // Flush previous rule
      if (currentRule) {
        rules.push(currentRule);
      }
      currentRule = {
        title: headerMatch[1].trim(),
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
  }

  // Flush last rule
  if (currentRule) {
    rules.push(currentRule);
  }

  return rules;
}

export function validate(content) {
  const rules = parseClaudeMd(content);
  const enforced = rules.filter((r) => r.enforcement === "enforced").length;
  const guidanceOnly = rules.filter((r) => r.enforcement === "guidance").length;
  const missing = rules.filter((r) => r.enforcement === "missing").length;

  return {
    rules,
    enforced,
    guidanceOnly,
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
export function validatePaths(paths, { followSymlinks = false } = {}) {
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

    const result = validate(content);
    if (!result.valid) allValid = false;
    fileResults.push({ path: filePath, skipped: false, reason: null, result });
  }

  return { fileResults, valid: allValid };
}

function printResult(filePath, result) {
  console.log("");
  console.log(`CLAUDE.md Validation Report: ${filePath}`);
  console.log("=".repeat(40));
  console.log(`  Total rules:    ${result.total}`);
  console.log(`  Enforced:       ${result.enforced}`);
  console.log(`  Guidance only:  ${result.guidanceOnly}`);
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
    process.argv[1].endsWith("validate"))
) {
  const args = process.argv.slice(2);
  const followSymlinks = args.includes("--follow-symlinks");
  const paths = args.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    paths.push("CLAUDE.md");
  }

  const { fileResults, valid } = validatePaths(paths, { followSymlinks });

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
