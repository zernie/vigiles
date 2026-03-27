import { readFileSync } from "node:fs";

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

// CLI entry point
if (process.argv[1] &&
    (process.argv[1].endsWith("validate.mjs") || process.argv[1].endsWith("validate"))) {
  const claudeMdPath = process.argv[2] || "CLAUDE.md";

  let content;
  try {
    content = readFileSync(claudeMdPath, "utf-8");
  } catch {
    console.log(`::error::CLAUDE.md not found at ${claudeMdPath}`);
    process.exit(1);
  }

  const result = validate(content);

  console.log("");
  console.log("CLAUDE.md Validation Report");
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
    console.log("");
    console.log("Add **Enforced by:** `<rule>` or **Guidance only** to each rule.");
    console.log("");
    console.log(`::error::${result.missing} rule(s) in CLAUDE.md are missing enforcement annotations`);
    process.exit(1);
  }

  if (result.total === 0) {
    console.log("");
    console.log(`No rules (### headings) found in ${claudeMdPath}`);
    process.exit(0);
  }

  console.log("");
  console.log("All rules have enforcement annotations.");
}
