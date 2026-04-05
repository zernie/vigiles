#!/usr/bin/env node

import {
  validatePaths,
  expandGlobs,
  loadConfig,
  findInstructionFiles,
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
const markersArg = args.find((a: string) => a.startsWith("--markers="));
const rawPaths = args.filter((a: string) => !a.startsWith("--"));

const config = loadConfig();

if (rawPaths.length === 0) {
  const found = findInstructionFiles(process.cwd(), config.files);
  rawPaths.push(...found);
}

if (rawPaths.length === 0) {
  console.log(
    "No instruction files found. Looked for: " + config.files.join(", "),
  );
  console.log('Specify files explicitly or set "files" in .vigilesrc.json.');
  process.exit(0);
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
