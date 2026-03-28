import {
  validatePaths,
  expandGlobs,
  loadConfig,
  discoverInstructionFiles,
} from "./validate.mjs";

const pathsInput =
  process.env.INPUT_PATHS ||
  process.env["INPUT_CLAUDE-MD-PATH"] ||
  process.env.INPUT_CLAUDE_MD_PATH;
const followSymlinks =
  (process.env.INPUT_FOLLOW_SYMLINKS ||
    process.env["INPUT_FOLLOW-SYMLINKS"] ||
    "false") === "true";
const markersInput = process.env.INPUT_MARKERS || process.env["INPUT_MARKERS"];
const requireAnnotationsInput =
  process.env.INPUT_REQUIRE_ANNOTATIONS ||
  process.env["INPUT_REQUIRE-ANNOTATIONS"];
const maxLinesInput =
  process.env.INPUT_MAX_LINES || process.env["INPUT_MAX-LINES"];
const requireRuleFileInput =
  process.env.INPUT_REQUIRE_RULE_FILE || process.env["INPUT_REQUIRE-RULE-FILE"];
const lintersInput = process.env.INPUT_LINTERS || process.env["INPUT_LINTERS"];

const config = loadConfig();

let discoveryMissing = [];
let paths;
if (pathsInput) {
  paths = expandGlobs(
    pathsInput
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
} else {
  const discovery = discoverInstructionFiles(process.cwd(), config.agents);
  if (discovery.detected.length > 0) {
    const tools = discovery.detected
      .map((d) => `${d.name} (${d.indicator})`)
      .join(", ");
    console.log(`Detected agents: ${tools}`);
  }
  paths = discovery.files;
  discoveryMissing = discovery.missing;
}

const ruleMarkers = markersInput
  ? markersInput.split(",").map((m) => m.trim())
  : config.ruleMarkers;

// Merge action inputs into rules config (action inputs override config file)
const rules = { ...config.rules };
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
  else rules["require-rule-file"] = requireRuleFileInput;
}

// Merge linters config (action input overrides config file)
let linters = config.linters;
if (lintersInput) {
  try {
    linters = { ...linters, ...JSON.parse(lintersInput) };
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

let hasMissingFiles = false;
for (const m of discoveryMissing) {
  console.log(
    `\n::error::${m.tool} detected (${m.indicator}) but ${m.expected} is missing`,
  );
  hasMissingFiles = true;
}

console.log("");
if (valid && !hasMissingFiles) {
  console.log("All rules have enforcement annotations.");
} else {
  if (!valid) {
    console.log(
      "Add **Enforced by:** `<rule>` or **Guidance only** to each rule.",
    );
  }
  if (hasMissingFiles) {
    console.log("Create missing instruction files for detected agents.");
  }
  console.log("");
  console.log(
    `::error::Validation failed — ${totalMissing} rule(s) missing enforcement annotations`,
  );
  process.exit(1);
}
