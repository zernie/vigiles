import {
  validatePaths,
  expandGlobs,
  loadConfig,
  findInstructionFiles,
} from "./validate.js";
import type { RulesConfig, LinterConfig, MarkerType } from "./types.js";

const pathsInput: string | undefined =
  process.env["INPUT_PATHS"] ||
  process.env["INPUT_CLAUDE-MD-PATH"] ||
  process.env["INPUT_CLAUDE_MD_PATH"];
const followSymlinks: boolean =
  (process.env["INPUT_FOLLOW_SYMLINKS"] ||
    process.env["INPUT_FOLLOW-SYMLINKS"] ||
    "false") === "true";
const markersInput: string | undefined =
  process.env["INPUT_MARKERS"] || process.env["INPUT_MARKERS"];
const requireAnnotationsInput: string | undefined =
  process.env["INPUT_REQUIRE_ANNOTATIONS"] ||
  process.env["INPUT_REQUIRE-ANNOTATIONS"];
const maxLinesInput: string | undefined =
  process.env["INPUT_MAX_LINES"] || process.env["INPUT_MAX-LINES"];
const requireRuleFileInput: string | undefined =
  process.env["INPUT_REQUIRE_RULE_FILE"] ||
  process.env["INPUT_REQUIRE-RULE-FILE"];
const lintersInput: string | undefined =
  process.env["INPUT_LINTERS"] || process.env["INPUT_LINTERS"];

const config = loadConfig();

let paths: string[];
if (pathsInput) {
  paths = expandGlobs(
    pathsInput
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
} else {
  paths = findInstructionFiles(process.cwd(), config.files);
}

const ruleMarkers: MarkerType[] = markersInput
  ? (markersInput.split(",").map((m) => m.trim()) as MarkerType[])
  : config.ruleMarkers;

// Merge action inputs into rules config (action inputs override config file)
const rules: RulesConfig = { ...config.rules };
if (requireAnnotationsInput !== undefined) {
  rules["require-annotations"] = requireAnnotationsInput !== "false";
}
if (maxLinesInput !== undefined) {
  rules["max-lines"] =
    maxLinesInput === "false" ? false : Number(maxLinesInput) || 500;
}
if (requireRuleFileInput !== undefined) {
  if (requireRuleFileInput === "false") rules["require-rule-file"] = false;
  else if (requireRuleFileInput === "true") rules["require-rule-file"] = true;
  else
    rules["require-rule-file"] = requireRuleFileInput as
      | "auto"
      | "catalog-only";
}

// Merge linters config (action input overrides config file)
let linters: Record<string, LinterConfig> = config.linters;
if (lintersInput) {
  try {
    linters = {
      ...linters,
      ...(JSON.parse(lintersInput) as Record<string, LinterConfig>),
    };
  } catch {
    console.warn(
      `Invalid linters JSON input: ${lintersInput}. Using config file value.`,
    );
  }
}

const { fileResults, valid } = validatePaths(paths, {
  followSymlinks,
  ruleMarkers,
  rules,
  linters,
  structures: config.structures,
});

let totalEnforced = 0;
let totalGuidance = 0;
let totalDisabled = 0;
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
  totalDisabled += result.disabled;
  totalMissing += result.missing;
  totalRules += result.total;

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

  for (const error of result.errors) {
    console.log(
      `::error file=${filePath},line=${error.line}::${error.message}`,
    );
  }
}

// Set outputs
console.log(`::set-output name=total::${totalRules}`);
console.log(`::set-output name=enforced::${totalEnforced}`);
console.log(`::set-output name=guidance::${totalGuidance}`);
console.log(`::set-output name=disabled::${totalDisabled}`);
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
