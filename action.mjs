import { validatePaths } from "./validate.mjs";

const pathsInput =
  process.env.INPUT_PATHS ||
  process.env["INPUT_CLAUDE-MD-PATH"] ||
  process.env.INPUT_CLAUDE_MD_PATH ||
  "CLAUDE.md";
const followSymlinks =
  (process.env.INPUT_FOLLOW_SYMLINKS ||
    process.env["INPUT_FOLLOW-SYMLINKS"] ||
    "false") === "true";

const paths = pathsInput
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const { fileResults, valid } = validatePaths(paths, { followSymlinks });

let totalEnforced = 0;
let totalGuidance = 0;
let totalMissing = 0;
let totalRules = 0;

for (const { path: filePath, skipped, reason, result } of fileResults) {
  if (skipped) {
    console.log(`\nSkipped: ${reason}`);
    continue;
  }
  if (!result) {
    console.log(`\n::error::${reason}`);
    continue;
  }

  totalEnforced += result.enforced;
  totalGuidance += result.guidanceOnly;
  totalMissing += result.missing;
  totalRules += result.total;

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

// Set outputs
console.log(`::set-output name=total::${totalRules}`);
console.log(`::set-output name=enforced::${totalEnforced}`);
console.log(`::set-output name=guidance::${totalGuidance}`);
console.log(`::set-output name=missing::${totalMissing}`);
console.log(`::set-output name=valid::${valid}`);

console.log("");
if (valid) {
  console.log("All rules have enforcement annotations.");
} else {
  console.log(
    "Add **Enforced by:** `<rule>` or **Guidance only** to each rule.",
  );
  console.log("");
  console.log(
    `::error::Validation failed — ${totalMissing} rule(s) missing enforcement annotations`,
  );
  process.exit(1);
}
