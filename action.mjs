import { readFileSync } from "node:fs";
import { validate } from "./validate.mjs";

const claudeMdPath = process.env.INPUT_CLAUDE_MD_PATH || process.env["INPUT_CLAUDE-MD-PATH"] || "CLAUDE.md";

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

// Set outputs for downstream steps
console.log(`::set-output name=total::${result.total}`);
console.log(`::set-output name=enforced::${result.enforced}`);
console.log(`::set-output name=guidance::${result.guidanceOnly}`);
console.log(`::set-output name=missing::${result.missing}`);
console.log(`::set-output name=valid::${result.valid}`);

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
