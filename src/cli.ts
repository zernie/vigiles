#!/usr/bin/env node

import { validate } from "./validator/index.js";

const args = process.argv.slice(2);
const command = args[0];

if (command !== "validate") {
  console.error("Usage: agent-lint validate [--claude-md <path>] [--check-eslint-rules]");
  process.exit(1);
}

const claudeMdPath = args.includes("--claude-md")
  ? args[args.indexOf("--claude-md") + 1]
  : undefined;

const checkEslintRules = args.includes("--check-eslint-rules");

try {
  const result = validate({ claudeMdPath, checkEslintRules });

  console.log("\n📋 CLAUDE.md Validation Report");
  console.log("═".repeat(40));
  console.log(`  Total rules:    ${result.total}`);
  console.log(`  Enforced:       ${result.enforced}`);
  console.log(`  Guidance only:  ${result.guidanceOnly}`);
  console.log(`  Missing:        ${result.missing}`);
  console.log("═".repeat(40));

  if (result.missing > 0) {
    console.log("\nRules missing enforcement annotations:");
    for (const rule of result.rules) {
      if (rule.enforcement === "missing") {
        console.log(`  Line ${rule.line}: "${rule.title}"`);
      }
    }
  }

  if (result.valid) {
    console.log("\n✅ All rules have enforcement annotations.");
  } else {
    console.log(
      "\n❌ Some rules are missing enforcement annotations.",
    );
    console.log("   Add `**Enforced by:** \\`<rule>\\`` or `**Guidance only**` to each rule.\n");
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
