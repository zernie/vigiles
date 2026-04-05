#!/usr/bin/env node

import {
  validatePaths,
  expandGlobs,
  loadConfig,
  discoverInstructionFiles,
} from "./validate.js";
import type { MarkerType, ValidationResult } from "./types.js";

function printResult(filePath: string, result: ValidationResult): void {
  console.log("");
  console.log(`Validation Report: ${filePath}`);
  console.log("=".repeat(40));
  console.log(`  Total rules:    ${String(result.total)}`);
  console.log(`  Enforced:       ${String(result.enforced)}`);
  console.log(`  Guidance only:  ${String(result.guidanceOnly)}`);
  console.log(`  Disabled:       ${String(result.disabled)}`);
  console.log(`  Missing:        ${String(result.missing)}`);
  if (result.detectedLinters.length > 0) {
    const parts = result.detectedLinters.map((l) =>
      l.ruleCount
        ? `${l.name} (${String(l.ruleCount)} built-in rules)`
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
        `::error file=${filePath},line=${String(error.line)}::${error.message}`,
      );
    }
  }
}

const args = process.argv.slice(2);
const followSymlinks = args.includes("--follow-symlinks");
const markersArg = args.find((a) => a.startsWith("--markers="));
const rawPaths = args.filter((a) => !a.startsWith("--"));

const config = loadConfig();

let discoveryMissing: Array<{
  tool: string;
  expected: string;
  indicator: string;
}> = [];
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

const ruleMarkers: MarkerType[] = markersArg
  ? (markersArg.split("=")[1].split(",") as MarkerType[])
  : config.ruleMarkers;

const { fileResults, valid } = validatePaths(paths, {
  followSymlinks,
  ruleMarkers,
  rules: config.rules,
  linters: config.linters,
  structures: config.structures,
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
