#!/usr/bin/env node

/**
 * vigiles CLI — compile typed specs to instruction files.
 *
 * Commands:
 *   vigiles init            — scaffold a spec from scratch
 *   vigiles compile         — compile .spec.ts → .md with linter verification
 *   vigiles audit           — verify hashes, report coverage, detect duplicates
 *   vigiles generate-types  — emit .d.ts with types from project state
 */

import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";
import { generateTypes } from "./generate-types.js";
import { validate, loadConfig as loadValidateConfig } from "./validate.js";

import {
  compileClaude,
  compileSkill,
  checkFileHash,
  addHash,
} from "./compile.js";
import type { CompileError } from "./compile.js";
import type { ClaudeSpec, SkillSpec } from "./spec.js";
import { findSimilarRules } from "./proofs.js";
import { parseInlineRules } from "./inline.js";
import { checkLinterRule } from "./linters.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IGNORE_NODE_MODULES = ["node_modules/**"];

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface VigilesConfig {
  maxRules?: number;
  maxTokens?: number;
  maxSectionLines?: number;
  catalogOnly?: boolean;
  linters?: Record<string, { rulesDir?: string | string[] }>;
}

function loadConfig(): VigilesConfig {
  const configPath = resolve(process.cwd(), "vigiles.config.ts");
  // For now, fall back to .vigilesrc.json-style detection.
  // Full TS config loading (via tsx/jiti) is a future enhancement.
  if (existsSync(configPath)) {
    console.log(
      `Note: vigiles.config.ts found but TS config loading is not yet supported.`,
    );
    console.log(`Using default config. TS config support coming soon.`);
  }
  return {};
}

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

function findSpecs(pattern?: string): string[] {
  const glob = pattern ?? "**/*.md.spec.ts";
  return globSync(glob, {
    ignore: [...IGNORE_NODE_MODULES, "dist/**"],
    cwd: process.cwd(),
  });
}

async function loadSpec(
  specPath: string,
): Promise<ClaudeSpec | SkillSpec | null> {
  const fullPath = resolve(process.cwd(), specPath);

  // Try multiple dist/ path strategies
  const candidates: string[] = [];

  // src/ → dist/ mapping (e.g., src/CLAUDE.md.spec.ts → dist/CLAUDE.md.spec.js)
  if (fullPath.includes("/src/")) {
    candidates.push(
      fullPath.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js"),
    );
  }

  // Root-level spec → dist/ (e.g., CLAUDE.md.spec.ts → dist/CLAUDE.md.spec.js)
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  const base = fullPath.substring(fullPath.lastIndexOf("/") + 1);
  candidates.push(resolve(dir, "dist", base.replace(/\.ts$/, ".js")));

  // examples/ → dist/examples/ mapping
  candidates.push(
    fullPath
      .replace(/\.ts$/, ".js")
      .replace(process.cwd(), resolve(process.cwd(), "dist")),
  );

  for (const distPath of candidates) {
    if (existsSync(distPath)) {
      try {
        const mod = (await import(distPath)) as {
          default: ClaudeSpec | SkillSpec;
        };
        return mod.default;
      } catch {
        // Try next candidate
      }
    }
  }

  // Try loading .ts directly via tsx
  try {
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    // Handle ESM/CJS double-default: m.default may itself have a .default
    const script = `import(${JSON.stringify(fullPath)}).then(m => { const d = m.default?.default ?? m.default; console.log(JSON.stringify(d)); })`;
    const output = execSync(`npx tsx -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    return JSON.parse(output.trim()) as ClaudeSpec | SkillSpec;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printErrors(specFile: string, errors: CompileError[]): void {
  for (const err of errors) {
    const pathInfo = err.path ? ` (${err.path})` : "";
    console.log(`  [${err.type}] ${err.message}${pathInfo}`);
    console.log(`::error file=${specFile}::${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function compile(
  specPaths: string[],
  config: VigilesConfig,
): Promise<boolean> {
  let allValid = true;

  for (const specPath of specPaths) {
    const spec = await loadSpec(specPath);
    if (!spec) {
      console.log(`\n✗ ${specPath} — failed to load`);
      console.log(
        `  Ensure the spec is compiled: run \`npm run build\` first.`,
      );
      allValid = false;
      continue;
    }

    const basePath = process.cwd();

    if (spec._specType === "claude") {
      const { markdown, errors, linterResults, targets } = compileClaude(spec, {
        basePath,
        specFile: specPath,
        maxRules: config.maxRules,
        maxTokens: config.maxTokens,
        maxSectionLines: config.maxSectionLines,
        catalogOnly: config.catalogOnly,
        linters: config.linters,
      });

      const linterCount = linterResults.filter((r) => r.exists).length;
      const primaryOutput = specPath
        .replace(/\.spec\.ts$/, "")
        .replace(/^examples\//, "");

      if (errors.length === 0) {
        // Write primary target
        writeFileSync(resolve(basePath, primaryOutput), markdown);
        const outputNames = [primaryOutput];

        // Write additional targets with swapped heading + recomputed hash
        for (const t of targets.slice(1)) {
          // Strip hash, replace heading, recompute hash
          const body = markdown
            .replace(/^<!-- vigiles:[^\n]+\n\n?/, "")
            .replace(/^# [^\n]+/, `# ${t}`);
          const additional = addHash(body, specPath);
          const dir = primaryOutput.substring(
            0,
            primaryOutput.lastIndexOf("/") + 1,
          );
          const targetPath = dir + t;
          writeFileSync(resolve(basePath, targetPath), additional);
          outputNames.push(targetPath);
        }

        console.log(`\n✓ ${specPath} → ${outputNames.join(", ")}`);
        console.log(
          `  ${String(Object.keys(spec.rules).length)} rules (${String(linterCount)} linter-verified)`,
        );
      } else {
        console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
        printErrors(specPath, errors);
        allValid = false;
        // Still write the file so the user can see partial output
        writeFileSync(resolve(basePath, primaryOutput), markdown);
      }
    } else if (spec._specType === "skill") {
      const outputPath = specPath.replace(/\.spec\.ts$/, "");
      const { markdown, errors } = compileSkill(spec, {
        basePath,
        specFile: specPath,
      });

      if (errors.length === 0) {
        writeFileSync(resolve(basePath, outputPath), markdown);
        console.log(`\n✓ ${specPath} → ${outputPath}`);
      } else {
        console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
        printErrors(specPath, errors);
        allValid = false;
        writeFileSync(resolve(basePath, outputPath), markdown);
      }
    }
  }

  return allValid;
}

/** True when running inside a GitHub Actions workflow. */
function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

/**
 * Emit a GitHub Actions annotation for the inline PR experience.
 * No-op outside GitHub Actions.
 */
function ghAnnotate(
  level: "error" | "warning",
  message: string,
  file?: string,
  line?: number,
): void {
  if (!isGitHubActions()) return;
  const locParts: string[] = [];
  if (file) locParts.push(`file=${file}`);
  if (line !== undefined) locParts.push(`line=${String(line)}`);
  const loc = locParts.length > 0 ? " " + locParts.join(",") : "";
  console.log(`::${level}${loc}::${message}`);
}

interface HashCheckResult {
  valid: boolean;
  errorCount: number;
}

function verifyHashes(filePaths: string[], silent = false): HashCheckResult {
  let errorCount = 0;
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  for (const filePath of filePaths) {
    const fullPath = resolve(process.cwd(), filePath);
    const result = checkFileHash(fullPath);

    if (!result.hasHash) {
      log(`\n- ${filePath} — no vigiles hash (hand-written or pre-v2)`);
      continue;
    }

    if (result.valid) {
      log(`\n✓ ${filePath} — hash valid (from ${result.specFile})`);
      continue;
    }

    log(`\n✗ ${filePath} — hash mismatch (manually edited after compilation)`);
    log(
      `  Re-run \`vigiles compile\` to regenerate from ${result.specFile ?? "spec"}.`,
    );
    if (!silent) {
      ghAnnotate(
        "error",
        "Hash mismatch — file was manually edited after compilation",
        filePath,
      );
    }
    errorCount++;
  }
  return { valid: errorCount === 0, errorCount };
}

function validateSpecs(
  filePaths: string[],
  rulesConfig?: import("./types.js").RulesConfig,
  silent = false,
): boolean {
  let allValid = true;
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  for (const filePath of filePaths) {
    const fullPath = resolve(process.cwd(), filePath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    // Multi-target: if file has a "compiled from" hash, it has a spec
    // even if it's not named <file>.spec.ts (e.g., AGENTS.md from CLAUDE.md.spec.ts)
    const hashMatch = content.match(
      /<!-- vigiles:sha256:[a-f0-9]+ compiled from (.+) -->/,
    );
    if (hashMatch) {
      // Verify the referenced spec still exists
      const specRef = resolve(process.cwd(), hashMatch[1]);
      if (!existsSync(specRef)) {
        log(
          `  ✗ [require-spec] ${filePath} references "${hashMatch[1]}" but that spec no longer exists.`,
        );
        allValid = false;
      }
      continue;
    }

    const result = validate(content, {
      filePath: fullPath,
      rules: rulesConfig,
    });
    for (const err of result.errors) {
      log(`  ✗ [${err.rule}] ${err.message}`);
      allValid = false;
    }
    for (const warn of result.warnings) {
      log(`  ⚠ [${warn.rule}] ${warn.message}`);
    }
  }
  return allValid;
}

function check(filePaths: string[], silent = false): HashCheckResult {
  const hashes = verifyHashes(filePaths, silent);
  const vConfig = loadValidateConfig();
  const specsValid = validateSpecs(filePaths, vConfig.rules, silent);
  return {
    valid: hashes.valid && specsValid,
    errorCount: hashes.errorCount + (specsValid ? 0 : 1),
  };
}

interface DuplicateResult {
  valid: boolean;
  pairCount: number;
}

/**
 * Find near-duplicate rules within each spec using NCD similarity.
 * Catches spec bloat — rules that likely say the same thing in different words.
 * Uses information-theoretic distance (gzip-based) — no LLM, fully deterministic.
 */
async function findDuplicateRules(
  threshold: number = 0.3,
  silent = false,
  scopeFiles?: string[],
): Promise<DuplicateResult> {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  const allSpecs = findSpecs();
  // If audit was invoked with explicit file arguments, only scan the specs
  // for those files — otherwise an unrelated duplicate elsewhere in the
  // repo would fail a targeted CI check (e.g. `vigiles audit path/foo.md`).
  // Paths are normalized to absolute form on both sides so "CLAUDE.md",
  // "./CLAUDE.md", and "/repo/CLAUDE.md" all match the same spec.
  const specs =
    scopeFiles && scopeFiles.length > 0
      ? (() => {
          const wanted = new Set(
            scopeFiles.map((f) => resolve(process.cwd(), `${f}.spec.ts`)),
          );
          return allSpecs.filter((specPath) =>
            wanted.has(resolve(process.cwd(), specPath)),
          );
        })()
      : allSpecs;
  if (specs.length === 0) return { valid: true, pairCount: 0 };

  let totalPairs = 0;
  let specsWithDuplicates = 0;

  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec || spec._specType !== "claude") continue;

    const rules = spec.rules;
    const ruleCount = Object.keys(rules).length;
    if (ruleCount < 2) continue;

    const pairs = findSimilarRules(rules, threshold);
    if (pairs.length === 0) continue;

    if (specsWithDuplicates === 0) {
      log(`Found near-duplicate rules (NCD < ${String(threshold)}):\n`);
    }
    specsWithDuplicates++;
    totalPairs += pairs.length;

    log(`  ${specPath}`);
    for (const pair of pairs.slice(0, 5)) {
      log(
        `    ${pair.idA}  ↔  ${pair.idB}  (distance: ${pair.distance.toFixed(3)})`,
      );
    }
    if (pairs.length > 5) {
      log(`    ... and ${String(pairs.length - 5)} more`);
    }
  }

  if (totalPairs === 0) {
    log("No near-duplicate rules detected.");
    return { valid: true, pairCount: 0 };
  }

  log(
    `\n  ${String(totalPairs)} duplicate pair(s) in ${String(specsWithDuplicates)} spec(s). Consider merging or rewording.`,
  );
  return { valid: false, pairCount: totalPairs };
}

/**
 * Structured audit report used by --json, --summary, and exit-code logic.
 */
interface AuditReport {
  hashErrors: number;
  inlineErrors: number;
  inlineRules: number;
  duplicatePairs: number;
  coverageEnabled: number;
  coverageDocumented: number;
  strengthenSuggestions: number;
  files: string[];
}

/** Exit codes: 0 clean, 1 warnings only, 2 hard errors. */
function auditExitCode(report: AuditReport): 0 | 1 | 2 {
  if (report.hashErrors > 0 || report.inlineErrors > 0) return 2;
  if (report.duplicatePairs > 0) return 1;
  // Coverage gaps and strengthen suggestions are informational, not failures
  return 0;
}

/**
 * Verify inline `<!-- vigiles:enforce ... -->` comments in an instruction
 * file. Each comment's linter rule goes through the same verification as
 * spec-declared enforce rules (existence, enabled status, closest-match
 * suggestions on typo).
 */
function verifyInlineRules(
  filePath: string,
  silent: boolean,
): { ok: boolean; errorCount: number; ruleCount: number } {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };

  let content: string;
  try {
    content = readFileSync(resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return { ok: true, errorCount: 0, ruleCount: 0 };
  }

  const { rules, errors: parseErrors } = parseInlineRules(content);
  if (rules.length === 0 && parseErrors.length === 0) {
    return { ok: true, errorCount: 0, ruleCount: 0 };
  }

  let errorCount = 0;
  log(`\n${filePath} (inline mode):`);

  for (const err of parseErrors) {
    log(`  ✗ line ${String(err.line)}: ${err.message}`);
    errorCount++;
    if (!silent) {
      ghAnnotate("error", err.message, filePath, err.line);
    }
  }

  for (const rule of rules) {
    const result = checkLinterRule(rule.linterRule, process.cwd());
    if (!result.exists) {
      const message = result.error ?? `Rule "${rule.linterRule}" not found`;
      log(`  ✗ line ${String(rule.line)}: ${message}`);
      errorCount++;
      if (!silent) {
        ghAnnotate("error", message, filePath, rule.line);
      }
    } else if (result.enabled === "disabled") {
      const message = `Rule "${rule.linterRule}" exists but is disabled in ${result.linter} config`;
      log(`  ✗ line ${String(rule.line)}: ${message}`);
      errorCount++;
      if (!silent) {
        ghAnnotate("error", message, filePath, rule.line);
      }
    } else {
      log(`  ✓ line ${String(rule.line)}: ${rule.linterRule}`);
    }
  }

  return { ok: errorCount === 0, errorCount, ruleCount: rules.length };
}

/**
 * Unified audit command: verify hashes, report coverage gaps, detect duplicates,
 * suggest improvements.
 *
 * Flags:
 *   --summary   Print a single-line summary (for SessionStart hooks)
 *   --json      Print structured JSON report (for CI integration)
 */
async function audit(
  restArgs: string[],
  flags: string[],
): Promise<AuditReport> {
  const summary = flags.includes("--summary");
  const json = flags.includes("--json");
  const silent = summary || json;

  const files = findInstructionFiles(restArgs);

  // 1. Verify hashes and structure
  if (!silent) {
    if (files.length > 0) {
      console.log("Verifying compiled files...\n");
    } else {
      console.log("No compiled instruction files found.\n");
    }
  }
  const hashResult =
    files.length > 0 ? check(files, silent) : { valid: true, errorCount: 0 };

  // 1b. Verify inline vigiles:enforce comments in any instruction file.
  // This supports projects that haven't adopted .spec.ts mode yet — see
  // docs/inline-mode.md.
  let inlineErrors = 0;
  let inlineRules = 0;
  if (!silent && files.length > 0) {
    console.log("\nInline rule verification:");
  }
  for (const filePath of files) {
    const result = verifyInlineRules(filePath, silent);
    inlineErrors += result.errorCount;
    inlineRules += result.ruleCount;
  }
  if (!silent && files.length > 0 && inlineRules === 0) {
    console.log("  (no inline vigiles:enforce comments found)");
  }

  // 2. Coverage gaps (discover)
  if (!silent) console.log("\nLinter rule coverage:\n");
  const coverage = discover(silent);

  // 3. Duplicate rule detection (NCD). Scope to the requested files when
  // audit was invoked with explicit paths, so targeted CI checks don't
  // fail on unrelated duplicates elsewhere in the repo.
  if (!silent) console.log("\nDuplicate rule detection:\n");
  const dups = await findDuplicateRules(
    0.3,
    silent,
    restArgs.length > 0 ? files : undefined,
  );

  // 4. Strengthen suggestions
  if (!silent) console.log("");
  const strengthenCount = await strengthen(silent);

  const report: AuditReport = {
    hashErrors: hashResult.errorCount,
    inlineErrors,
    inlineRules,
    duplicatePairs: dups.pairCount,
    coverageEnabled: coverage.enabled,
    coverageDocumented: coverage.documented,
    strengthenSuggestions: strengthenCount,
    files,
  };

  if (summary) {
    printAuditSummary(report);
  } else if (json) {
    console.log(JSON.stringify(report, null, 2));
  }

  return report;
}

/** Single-line audit summary for SessionStart hooks — minimal token cost. */
function printAuditSummary(report: AuditReport): void {
  const parts: string[] = [];
  if (report.hashErrors > 0) parts.push(`${String(report.hashErrors)} stale`);
  if (report.inlineErrors > 0)
    parts.push(`${String(report.inlineErrors)} inline errors`);
  if (report.duplicatePairs > 0)
    parts.push(`${String(report.duplicatePairs)} duplicates`);
  const undocumented = report.coverageEnabled - report.coverageDocumented;
  if (undocumented > 0)
    parts.push(`${String(undocumented)} undocumented rules`);
  if (report.strengthenSuggestions > 0)
    parts.push(`${String(report.strengthenSuggestions)} strengthenable`);
  if (parts.length === 0) {
    console.log("vigiles: clean");
  } else {
    console.log(`vigiles: ${parts.join(" / ")}`);
  }
}

function collectDocumentedRules(): Set<string> {
  const documented = new Set<string>();
  const mdFiles = globSync("**/CLAUDE.md", {
    ignore: IGNORE_NODE_MODULES,
    cwd: process.cwd(),
  });
  for (const mdFile of mdFiles) {
    const content = readFileSync(resolve(process.cwd(), mdFile), "utf-8");
    const enforcedRe = /\*\*Enforced by:\*\*\s*`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = enforcedRe.exec(content)) !== null) {
      documented.add(m[1]);
    }
  }
  return documented;
}

interface CoverageTotals {
  enabled: number;
  documented: number;
}

function printLinterCoverage(
  linter: { linter: string; rules: string[] },
  documentedRules: Set<string>,
  silent = false,
): CoverageTotals {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  const documented = linter.rules.filter((r) =>
    documentedRules.has(`${linter.linter}/${r}`),
  );
  const undocumented = linter.rules.filter(
    (r) => !documentedRules.has(`${linter.linter}/${r}`),
  );
  const pct =
    linter.rules.length > 0
      ? Math.round((documented.length / linter.rules.length) * 100)
      : 0;

  log(
    `  ${linter.linter}: ${String(documented.length)}/${String(linter.rules.length)} rules documented (${String(pct)}%)`,
  );

  if (documented.length > 0 && documented.length <= 10) {
    for (const r of documented) {
      log(`    ✓ ${linter.linter}/${r}`);
    }
  }

  if (undocumented.length > 0) {
    const show = undocumented.slice(0, 5);
    log(`    Top undocumented:`);
    for (const r of show) {
      log(`    ✗ ${linter.linter}/${r}`);
    }
    if (undocumented.length > 5) {
      log(`    ... and ${String(undocumented.length - 5)} more`);
    }
  }
  log("");

  return { enabled: linter.rules.length, documented: documented.length };
}

function discover(silent = false): CoverageTotals {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  log("Scanning project for linter rules...\n");

  const result = generateTypes({ basePath: process.cwd() });
  const documentedRules = collectDocumentedRules();

  log("Detected linters:\n");

  let totalEnabled = 0;
  let totalDocumented = 0;

  for (const linter of result.linters) {
    const totals = printLinterCoverage(linter, documentedRules, silent);
    totalEnabled += totals.enabled;
    totalDocumented += totals.documented;
  }

  if (result.linters.length === 0) {
    log("  No linters detected.\n");
  }

  const totalPct =
    totalEnabled > 0 ? Math.round((totalDocumented / totalEnabled) * 100) : 0;
  log(
    `Coverage: ${String(totalDocumented)}/${String(totalEnabled)} rules documented (${String(totalPct)}%)`,
  );

  if (totalDocumented < totalEnabled) {
    log(
      `\nConsider adding enforce() rules for frequently-triggered undocumented rules.`,
    );
    log(`The agent encounters these rules but has no context about WHY.`);
  }

  return { enabled: totalEnabled, documented: totalDocumented };
}

function init(args: string[]): void {
  const targetFlag = args.find((a) => a.startsWith("--target="));
  const target = targetFlag ? targetFlag.split("=")[1] : "CLAUDE.md";
  const specPath = `${target}.spec.ts`;

  if (existsSync(resolve(process.cwd(), specPath))) {
    console.log(`${specPath} already exists.`);
    return;
  }

  const targetLine = target !== "CLAUDE.md" ? `\n  target: "${target}",` : "";
  const template = `import { claude, enforce, guidance } from "vigiles/spec";

export default claude({${targetLine}
  sections: {
    // Prose sections become ## headings in the compiled output.
    // Do not add # or ## headers inside sections.
    // positioning: "What this project does and why.",

    // This section is included in the compiled output to help agents
    // understand how to work with specs. Remove it once your team is familiar.
    "how-to-edit": "This file is compiled from a .spec.ts file. Do not edit it directly — edit the spec and run 'npx vigiles compile'. To add a rule: add to the rules object in the spec.",
  },

  commands: {
    // Commands are verified against package.json at compile time.
    // "npm run build": "Compile the project",
    // "npm test": "Run all tests",
  },

  keyFiles: {
    // File paths are verified to exist at compile time.
    // "src/index.ts": "Main entry point",
  },

  rules: {
    // enforce() — backed by a linter rule, verified to exist AND be enabled:
    // "no-console": enforce("eslint/no-console", "Use structured logger."),
    //
    // guidance() — prose only, no enforcement:
    // "research-first": guidance("Google unfamiliar APIs before implementing."),
  },
});
`;
  writeFileSync(resolve(process.cwd(), specPath), template);
  console.log(`Created ${specPath} — edit it and run \`vigiles compile\`.`);
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

const VIGILES_CI_STEP = `      - name: Verify specs
        run: npx vigiles audit && npx vigiles generate-types --check`;

function addGhaStep(): boolean {
  // Find existing GHA workflow
  const ciPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    ".github/workflows/main.yml",
    ".github/workflows/main.yaml",
    ".github/workflows/test.yml",
    ".github/workflows/test.yaml",
  ];
  for (const ciPath of ciPaths) {
    const fullPath = resolve(process.cwd(), ciPath);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf-8");
      if (content.includes("vigiles")) {
        console.log(`✓ ${ciPath} already has vigiles steps`);
        return true;
      }
      // Append step at end of file (safe for all YAML formats)
      const trimmed = content.trimEnd();
      writeFileSync(fullPath, trimmed + "\n\n" + VIGILES_CI_STEP + "\n");
      console.log(`✓ Added vigiles check step to ${ciPath}`);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Project detection for setup wizard
// ---------------------------------------------------------------------------

interface DetectedProject {
  /** Instruction files found (with or without specs). */
  instructionFiles: { path: string; hasSpec: boolean; isSymlink: boolean }[];
  /** Agent tools detected. */
  agents: string[];
  /** Sync tools detected in package.json. */
  syncTools: string[];
  /** Non-markdown agent config files. */
  otherConfigs: string[];
  /** Whether Claude Code project config exists. */
  hasClaude: boolean;
}

const KNOWN_INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
const KNOWN_OTHER_CONFIGS: Record<string, string> = {
  ".cursorrules": "Cursor",
  ".github/copilot-instructions.md": "GitHub Copilot",
  ".windsurfrules": "Windsurf",
};
const KNOWN_SYNC_TOOLS = [
  "rule-porter",
  "rulesync",
  "vibe-cli",
  "@nichochar/rule-porter",
];

function detectProject(): DetectedProject {
  const cwd = process.cwd();
  const instructionFiles: DetectedProject["instructionFiles"] = [];
  const agents: string[] = [];
  const otherConfigs: string[] = [];

  // Check known instruction files
  for (const f of KNOWN_INSTRUCTION_FILES) {
    const full = resolve(cwd, f);
    if (existsSync(full)) {
      let isSymlink = false;
      try {
        isSymlink = lstatSync(full).isSymbolicLink();
      } catch {
        // ignore
      }
      const hasSpec = existsSync(resolve(cwd, `${f}.spec.ts`));
      instructionFiles.push({ path: f, hasSpec, isSymlink });
    }
  }

  // Detect agents from files
  if (
    instructionFiles.some((f) => f.path === "CLAUDE.md") ||
    existsSync(resolve(cwd, ".claude"))
  ) {
    agents.push("Claude Code");
  }
  if (instructionFiles.some((f) => f.path === "AGENTS.md")) {
    agents.push("Codex / GitHub Copilot");
  }

  // Check non-markdown configs
  for (const [path, agent] of Object.entries(KNOWN_OTHER_CONFIGS)) {
    if (existsSync(resolve(cwd, path))) {
      otherConfigs.push(`${path} (${agent})`);
      if (!agents.includes(agent)) agents.push(agent);
    }
  }

  // Check for sync tools in package.json
  const syncTools: string[] = [];
  const pkgPath = resolve(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const tool of KNOWN_SYNC_TOOLS) {
        if (tool in allDeps) syncTools.push(tool);
      }
    } catch {
      // ignore
    }
  }

  return {
    instructionFiles,
    agents,
    syncTools,
    otherConfigs,
    hasClaude: existsSync(resolve(cwd, ".claude")),
  };
}

async function setup(args: string[]): Promise<void> {
  const targetFlag = args.find((a) => a.startsWith("--target="));
  const strict = args.includes("--strict");
  const noGha = args.includes("--no-gha");

  console.log(`vigiles setup${strict ? " (strict mode)" : ""}\n`);

  // Step 1: Detect project
  const detected = detectProject();

  if (detected.agents.length > 0) {
    console.log(`Detected: ${detected.agents.join(", ")}`);
  }
  if (detected.otherConfigs.length > 0) {
    console.log(`Other agent configs: ${detected.otherConfigs.join(", ")}`);
  }
  if (detected.syncTools.length > 0) {
    console.log(`Sync tools: ${detected.syncTools.join(", ")}`);
  }
  for (const f of detected.instructionFiles) {
    if (f.isSymlink) {
      console.log(`Note: ${f.path} is a symlink`);
    }
  }
  if (
    detected.agents.length > 0 ||
    detected.otherConfigs.length > 0 ||
    detected.syncTools.length > 0
  ) {
    console.log("");
  }

  // Step 2: Determine targets
  let targets: string[];
  if (targetFlag) {
    targets = [targetFlag.split("=")[1]];
  } else {
    // Auto-detect: create specs for instruction files that need them
    const needsSpec = detected.instructionFiles.filter((f) => !f.hasSpec);
    if (needsSpec.length > 0) {
      // Existing files without specs — suggest migration
      for (const f of needsSpec) {
        console.log(
          `Found ${f.path} without a spec. Migrate with the migrate-to-spec skill`,
        );
        console.log(
          `  or create a blank spec: npx vigiles init --target=${f.path}\n`,
        );
      }
      const hasAnySpec = detected.instructionFiles.some((f) => f.hasSpec);
      if (
        !hasAnySpec &&
        needsSpec.length === detected.instructionFiles.length
      ) {
        // ALL existing files need migration — don't create new ones
        console.log("Install the plugin to use the migration skill:");
        console.log("  npx skills add zernie/vigiles");
        return;
      }
    }

    // Default: CLAUDE.md, plus AGENTS.md if Codex detected
    targets = ["CLAUDE.md"];
    const hasAgentsMd = detected.instructionFiles.some(
      (f) => f.path === "AGENTS.md",
    );
    const hasCodex =
      detected.agents.includes("Codex / GitHub Copilot") || hasAgentsMd;
    if (hasCodex && !hasAgentsMd) {
      targets.push("AGENTS.md");
    }
  }

  // Step 3: Create specs
  for (const target of targets) {
    const specPath = `${target}.spec.ts`;
    if (existsSync(resolve(process.cwd(), specPath))) {
      console.log(`✓ ${specPath} already exists`);
    } else if (existsSync(resolve(process.cwd(), target))) {
      console.log(
        `⚠ ${target} exists without spec — migrate with migrate-to-spec skill`,
      );
    } else {
      init(["--target=" + target]);
    }
  }

  // Step 4: Generate types
  console.log("\nScanning linters and project files...");
  const typesResult = generateTypes({ basePath: process.cwd() });
  const outPath = ".vigiles/generated.d.ts";
  const outDir = resolve(process.cwd(), ".vigiles");
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(resolve(process.cwd(), outPath), typesResult.dts);
  for (const l of typesResult.linters) {
    console.log(`  ${l.linter}: ${String(l.rules.length)} rules`);
  }
  if (typesResult.scripts.length > 0) {
    console.log(`  npm scripts: ${String(typesResult.scripts.length)}`);
  }
  console.log(`✓ Generated ${outPath}`);

  // Step 5: Compile specs
  console.log("\nCompiling specs...");
  const specs = findSpecs();
  if (specs.length > 0) {
    await compile(specs, loadConfig());
  }

  // Step 6: Add CI step
  console.log("");
  const addedGha = noGha ? false : addGhaStep();
  if (!addedGha) {
    console.log("  No CI workflow found. Add this step to your CI:\n");
    console.log("    npx vigiles audit && npx vigiles generate-types --check");
  }

  // Step 7: Install Claude Code plugin (hooks + skills)
  const shouldInstallPlugin =
    detected.hasClaude || targets.includes("CLAUDE.md");
  if (shouldInstallPlugin) {
    let pluginInstalled = false;

    // Try installing the full plugin via skills CLI (gives hooks + skills)
    try {
      const { execSync: exec } =
        require("node:child_process") as typeof import("node:child_process");
      exec("npx skills add zernie/vigiles", {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });
      pluginInstalled = true;
      console.log("✓ Installed vigiles plugin (hooks + skills) via skills CLI");
    } catch {
      // skills CLI not available — fall back to direct hook installation
    }

    if (!pluginInstalled) {
      // Fall back: write hooks directly to .claude/settings.json
      // (gives auto-compile + block edits, but no skills)
      const settingsDir = resolve(process.cwd(), ".claude");
      const settingsPath = resolve(settingsDir, "settings.json");
      if (!existsSync(settingsDir)) {
        mkdirSync(settingsDir, { recursive: true });
      }

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
            string,
            unknown
          >;
        } catch {
          // Ignore malformed settings
        }
      }

      if (!settings["hooks"]) {
        settings["hooks"] = {};
      }
      const hooks = settings["hooks"] as Record<string, unknown>;

      const preCmd = `FILE=$(cat | jq -r '.tool_input.file_path // empty') && case "$FILE" in *.md) [ -f "$FILE" ] && head -1 "$FILE" | grep -q 'vigiles:sha256:' && { SPEC=$(head -1 "$FILE" | sed -n 's/.*compiled from \\(.*\\) -->/\\1/p'); echo "BLOCKED: Edit $SPEC instead." >&2; exit 2; } ;; esac; exit 0`;
      const postCmd = `FILE=$(cat | jq -r '.tool_input.file_path // empty') && case "$(basename "$FILE")" in eslint.config.*|.eslintrc*|package.json|pyproject.toml|Cargo.toml) npx vigiles generate-types 2>&1 || true ;; esac && case "$FILE" in *.spec.ts) npx vigiles compile 2>&1 || true ;; esac`;

      // Append to existing arrays (don't duplicate if already present)
      const existingStr = JSON.stringify(settings);
      if (!existingStr.includes("vigiles:sha256")) {
        const pre = (hooks["PreToolUse"] ?? []) as unknown[];
        pre.push({ matcher: "Edit|Write", command: preCmd });
        hooks["PreToolUse"] = pre;
      }
      if (!existingStr.includes("vigiles compile")) {
        const post = (hooks["PostToolUse"] ?? []) as unknown[];
        post.push({ matcher: "Edit|Write", command: postCmd });
        hooks["PostToolUse"] = post;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log("✓ Installed hooks in .claude/settings.json");
      console.log(
        "  (For skills like edit-spec and migrate-to-spec, also run: npx skills add zernie/vigiles)",
      );
    }
  }

  // Step 8: Agent-specific guidance
  const specPathsList = targets.map((t) => `${t}.spec.ts`);
  const specPaths = specPathsList.join(", ");

  if (targets.includes("AGENTS.md")) {
    console.log(
      "\n  Codex / Copilot reads AGENTS.md directly — no hooks needed.",
    );
    console.log(
      "  Run `npx vigiles compile` after spec edits. CI enforces freshness.",
    );
  }

  if (detected.otherConfigs.length > 0 && detected.syncTools.length === 0) {
    console.log(
      "\n  Non-markdown agent configs detected. Use a sync tool to convert:",
    );
    console.log("    npm install -D rule-porter");
  }

  // Step 8b: Write config if strict mode
  if (strict) {
    const configPath = resolve(process.cwd(), ".vigilesrc.json");
    if (!existsSync(configPath)) {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            rules: {
              "require-spec": "error",
              "require-skill-spec": "error",
            },
          },
          null,
          2,
        ) + "\n",
      );
      console.log("✓ Created .vigilesrc.json with strict rules");
    }
  }

  // Step 9: Summary
  console.log("\n---");
  console.log("Setup complete.\n");
  console.log(`  1. Edit ${specPaths} — add your project's conventions`);
  console.log(
    "  2. Run `npx vigiles strengthen` to upgrade guidance → enforce",
  );
  if (!strict) {
    console.log(
      "  3. When ready, enforce specs in CI: npx vigiles setup --strict",
    );
  }
  console.log("\n  Commit:");
  const files = [
    ...targets,
    ...specPathsList,
    ".vigiles/generated.d.ts",
    ...(shouldInstallPlugin ? [".claude/settings.json"] : []),
    ...(strict ? [".vigilesrc.json"] : []),
  ];
  console.log(
    `    git add ${files.join(" ")} && git commit -m "Add vigiles spec"`,
  );
}

// ---------------------------------------------------------------------------
// Strengthen: guidance() → enforce() suggestions
// ---------------------------------------------------------------------------

// Keywords in guidance text that map to known linter rules
const GUIDANCE_TO_LINTER: Array<{
  keywords: string[];
  rules: string[];
}> = [
  {
    keywords: ["console.log", "console", "no-console", "logger", "logging"],
    rules: ["eslint/no-console", "ruff/T201"],
  },
  {
    keywords: ["any", "no-explicit-any", "unknown", "type safety"],
    rules: ["@typescript-eslint/no-explicit-any"],
  },
  {
    keywords: ["await", "promise", "floating", "async", ".catch"],
    rules: ["@typescript-eslint/no-floating-promises"],
  },
  {
    keywords: ["unused", "dead code", "no-unused"],
    rules: ["eslint/no-unused-vars", "@typescript-eslint/no-unused-vars"],
  },
  {
    keywords: ["import", "barrel", "internal", "restricted"],
    rules: ["eslint/no-restricted-imports", "import/no-internal-modules"],
  },
  {
    keywords: ["unwrap", "expect", "panic"],
    rules: ["clippy/unwrap_used"],
  },
  {
    keywords: ["print", "println", "stdout"],
    rules: ["ruff/T201", "clippy/print_stdout"],
  },
  {
    keywords: ["assert", "assertion"],
    rules: ["ruff/S101"],
  },
  {
    keywords: ["todo", "fixme", "hack"],
    rules: ["eslint/no-warning-comments"],
  },
  {
    keywords: ["debugger"],
    rules: ["eslint/no-debugger"],
  },
  {
    keywords: ["eval"],
    rules: ["eslint/no-eval"],
  },
];

async function strengthen(silent = false): Promise<number> {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  log("Scanning specs for guidance rules that could be enforced...\n");

  const specs = findSpecs();
  if (specs.length === 0) {
    log("No .spec.ts files found. Run `vigiles init` first.");
    return 0;
  }

  // Scan available linter rules
  const typesResult = generateTypes({ basePath: process.cwd() });
  const allLinterRules = new Set<string>();
  for (const l of typesResult.linters) {
    for (const r of l.rules) {
      allLinterRules.add(`${l.linter}/${r}`);
    }
  }

  let suggestions = 0;

  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec || spec._specType !== "claude") continue;

    for (const [ruleId, rule] of Object.entries(spec.rules)) {
      if (rule._kind !== "guidance") continue;
      const text = rule.text.toLowerCase();

      // Find matching linter rules via keyword matching
      const matches: string[] = [];
      for (const mapping of GUIDANCE_TO_LINTER) {
        if (mapping.keywords.some((kw) => text.includes(kw))) {
          for (const candidate of mapping.rules) {
            if (allLinterRules.has(candidate)) {
              matches.push(candidate);
            }
          }
        }
      }

      if (matches.length > 0) {
        suggestions++;
        log(`  "${ruleId}" (guidance) → could be enforced:`);
        for (const m of matches) {
          log(`    enforce("${m}", "${rule.text.slice(0, 60)}")`);
        }
        log("");
      }
    }
  }

  if (suggestions === 0) {
    log("No strengthening suggestions found. All guidance rules look correct,");
    log("or no matching linter rules are enabled in your project.");
  } else {
    log(`${String(suggestions)} rule(s) could be strengthened.`);
    log(
      "Edit the spec to replace guidance() with enforce() for the suggested rules.",
    );
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Command handlers for main()
// ---------------------------------------------------------------------------

function findInstructionFiles(restArgs: string[]): string[] {
  if (restArgs.length > 0) return restArgs;
  const patterns = ["**/CLAUDE.md", "**/AGENTS.md", "**/SKILL.md"];
  const files: string[] = [];
  for (const pattern of patterns) {
    files.push(
      ...globSync(pattern, { ignore: IGNORE_NODE_MODULES, cwd: process.cwd() }),
    );
  }
  return files;
}

function handleGenerateTypes(args: string[], restArgs: string[]): void {
  const checkOnly = args.includes("--check");
  const outPath = restArgs[0] ?? ".vigiles/generated.d.ts";
  const fileGlobs = args
    .filter((a) => a.startsWith("--files="))
    .map((a) => a.split("=")[1])
    .filter(Boolean);

  console.log("Scanning project...\n");
  const result = generateTypes({
    basePath: process.cwd(),
    fileGlobs: fileGlobs.length > 0 ? fileGlobs : undefined,
  });

  for (const l of result.linters) {
    console.log(
      `  ${l.linter}: ${String(l.rules.length)} enabled rules (via ${l.via})`,
    );
  }
  if (result.scripts.length > 0) {
    console.log(`  npm scripts: ${String(result.scripts.length)}`);
  }
  console.log(`  project files: ${String(result.files.length)}`);

  const fullOut = resolve(process.cwd(), outPath);

  if (checkOnly) {
    // --check: compare against existing file, exit 1 if stale
    if (!existsSync(fullOut)) {
      console.log(
        `\n✗ ${outPath} does not exist. Run \`vigiles generate-types\` to create it.`,
      );
      process.exit(1);
    }
    const existing = readFileSync(fullOut, "utf-8");
    // Normalize for formatter differences (trailing whitespace, blank lines)
    const normalize = (s: string): string =>
      s
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (normalize(existing) === normalize(result.dts)) {
      console.log(`\n✓ ${outPath} is up to date`);
    } else {
      console.log(
        `\n✗ ${outPath} is stale. Run \`vigiles generate-types\` to update.`,
      );
      process.exit(1);
    }
    return;
  }

  const outDir = fullOut.substring(0, fullOut.lastIndexOf("/"));
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(fullOut, result.dts);
  console.log(`\n✓ Generated ${outPath}`);
}

function printUsage(command: string | undefined): void {
  console.log("vigiles — compile typed specs to instruction files");
  console.log("");
  console.log("Commands:");
  console.log(
    "  vigiles init [flags]           Setup project (--target=X.md, --strict, --no-gha)",
  );
  console.log("  vigiles compile [files...]     Compile .spec.ts → .md");
  console.log(
    "  vigiles audit [files...]       Verify, find gaps, suggest improvements",
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  vigiles init                 Auto-detect project, create specs, wire CI",
  );
  console.log("  vigiles compile              Compile all .spec.ts files");
  console.log(
    "  vigiles audit                Verify hashes + coverage + suggestions",
  );
  console.log("");
  console.log("Plumbing:");
  console.log("  vigiles generate-types [out]  Emit .d.ts from project state");
  console.log("  vigiles generate-types --check  Verify .d.ts is up to date");
  if (command && command !== "--help") {
    console.log(`\nUnknown command: "${command}"`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const restArgs = args.slice(1).filter((a) => !a.startsWith("--"));
  const config = loadConfig();

  switch (command) {
    // --- Primary commands ---

    case "init": {
      // Explicit --target bypasses the setup wizard and always creates a
      // bare spec, so `npx vigiles init --target=<file>` is a reliable
      // remediation for the require-spec validator. Bare `vigiles init`
      // still runs the full wizard (project detection + auto-targets).
      const hasTarget = args.some((a) => a.startsWith("--target="));
      if (hasTarget) {
        init(args.slice(1));
      } else {
        await setup(args);
      }
      break;
    }

    case "compile": {
      const specs = restArgs.length > 0 ? restArgs : findSpecs();
      if (specs.length === 0) {
        console.log("No .spec.ts files found.");
        console.log("Run `vigiles init` to create one.");
        process.exit(0);
      }
      const valid = await compile(specs, config);
      console.log("");
      if (valid) {
        console.log("Compilation complete.");
      } else {
        console.log("Compilation complete with errors.");
        process.exit(1);
      }
      break;
    }

    case "audit": {
      // audit = verify + discover + strengthen
      const flags = args.slice(1).filter((a) => a.startsWith("--"));
      const report = await audit(restArgs, flags);
      const exitCode = auditExitCode(report);
      if (isGitHubActions()) {
        if (report.hashErrors > 0) {
          ghAnnotate(
            "error",
            `${String(report.hashErrors)} compiled file(s) with stale hash — run vigiles compile`,
          );
        }
        if (report.duplicatePairs > 0) {
          ghAnnotate(
            "warning",
            `${String(report.duplicatePairs)} near-duplicate rule pair(s) detected — consider merging`,
          );
        }
      }
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      break;
    }

    // --- Plumbing ---

    case "generate-types":
      handleGenerateTypes(args, restArgs);
      break;

    default:
      printUsage(command);
      break;
  }
}

void main();
