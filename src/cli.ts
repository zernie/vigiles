#!/usr/bin/env node

/**
 * vigiles CLI — compile typed specs to instruction files.
 *
 * Commands:
 *   vigiles compile         — compile .spec.ts → .md with linter verification
 *   vigiles check           — verify hashes, run assertions
 *   vigiles init            — scaffold a spec from scratch
 *   vigiles generate-types  — emit .d.ts with types from project state
 *   vigiles discover        — scan linter configs, report coverage gaps
 *   vigiles adopt           — detect manual edits, show diff
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
import { validate } from "./validate.js";

import {
  compileClaude,
  compileSkill,
  checkFileHash,
  executeChecks,
  adoptDiff,
} from "./compile.js";
import type { CompileError, AssertionResult } from "./compile.js";
import type { ClaudeSpec, SkillSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IGNORE_NODE_MODULES = ["node_modules/**"];

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface VigilesConfig {
  maxRules?: number;
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
  const glob = pattern ?? "**/*.spec.ts";
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

        // Write additional targets with swapped heading
        for (const t of targets.slice(1)) {
          const additional = markdown.replace(
            /^(<!-- vigiles:[^\n]+\n\n?)# [^\n]+/,
            `$1# ${t}`,
          );
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

function verifyHashes(filePaths: string[]): boolean {
  let allValid = true;
  for (const filePath of filePaths) {
    const fullPath = resolve(process.cwd(), filePath);
    const result = checkFileHash(fullPath);

    if (!result.hasHash) {
      console.log(`\n- ${filePath} — no vigiles hash (hand-written or pre-v2)`);
      continue;
    }

    if (result.valid) {
      console.log(`\n✓ ${filePath} — hash valid (from ${result.specFile})`);
      continue;
    }

    console.log(
      `\n✗ ${filePath} — hash mismatch (manually edited after compilation)`,
    );
    console.log(
      `  Re-run \`vigiles compile\` to regenerate from ${result.specFile ?? "spec"}.`,
    );
    console.log(
      `::error file=${filePath}::Hash mismatch — file was manually edited after compilation`,
    );
    allValid = false;
  }
  return allValid;
}

function printAssertionResult(r: AssertionResult): boolean {
  if (r.passed) {
    console.log(
      `\n✓ ${r.id} — ${String(r.matched)}/${String(r.total)} files pass`,
    );
    return true;
  }
  console.log(
    `\n✗ ${r.id} — ${String(r.matched)}/${String(r.total)} files pass (${String(r.missing.length)} missing)`,
  );
  for (const m of r.missing) {
    console.log(`  ${m}`);
  }
  return false;
}

async function runAssertions(): Promise<boolean> {
  let allValid = true;
  const specs = findSpecs();
  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec || spec._specType !== "claude") continue;

    const hasChecks = Object.values(spec.rules).some(
      (r) => r._kind === "check",
    );
    if (!hasChecks) continue;

    const results = executeChecks(spec, process.cwd());
    for (const r of results) {
      if (!printAssertionResult(r)) allValid = false;
    }
  }
  return allValid;
}

function validateSpecs(filePaths: string[]): boolean {
  let allValid = true;
  for (const filePath of filePaths) {
    const fullPath = resolve(process.cwd(), filePath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    const result = validate(content, { filePath: fullPath });
    for (const err of result.errors) {
      console.log(`  [${err.rule}] ${err.message}`);
      allValid = false;
    }
  }
  return allValid;
}

async function check(filePaths: string[]): Promise<boolean> {
  const hashesValid = verifyHashes(filePaths);
  const assertionsValid = await runAssertions();
  const specsValid = validateSpecs(filePaths);
  return hashesValid && assertionsValid && specsValid;
}

function printDiffLines(lines: string[], label: string, prefix: string): void {
  if (lines.length === 0) return;
  console.log(`\n  ${label}:`);
  for (const line of lines.slice(0, 15)) {
    console.log(`    ${prefix} ${line}`);
  }
  if (lines.length > 15) {
    console.log(`    ... and ${String(lines.length - 15)} more`);
  }
}

async function adopt(): Promise<void> {
  const specs = findSpecs();
  if (specs.length === 0) {
    console.log("No .spec.ts files found.");
    return;
  }

  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec) continue;

    const outputPath = specPath
      .replace(/\.spec\.ts$/, "")
      .replace(/^examples\//, "");

    if (!existsSync(resolve(process.cwd(), outputPath))) {
      console.log(
        `\n- ${outputPath} — not found (run \`vigiles compile\` first)`,
      );
      continue;
    }

    const result = adoptDiff(outputPath, spec, process.cwd());

    if (!result.hasHash) {
      console.log(`\n- ${outputPath} — no vigiles hash (not a compiled file)`);
      continue;
    }

    if (result.valid) {
      console.log(`\n✓ ${outputPath} — unchanged since compilation`);
      continue;
    }

    if (!result.changed) {
      console.log(`\n- ${outputPath} — whitespace-only changes`);
      continue;
    }

    console.log(
      `\n✗ ${outputPath} — manually edited (from ${result.specFile})`,
    );

    printDiffLines(result.addedLines, "Lines added (not in spec)", "+");
    printDiffLines(
      result.removedLines,
      "Lines removed (present in spec output)",
      "-",
    );

    console.log(
      `\n  To accept: update ${specPath} and run \`vigiles compile\``,
    );
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
): CoverageTotals {
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

  console.log(
    `  ${linter.linter}: ${String(documented.length)}/${String(linter.rules.length)} rules documented (${String(pct)}%)`,
  );

  if (documented.length > 0 && documented.length <= 10) {
    for (const r of documented) {
      console.log(`    ✓ ${linter.linter}/${r}`);
    }
  }

  if (undocumented.length > 0) {
    const show = undocumented.slice(0, 5);
    console.log(`    Top undocumented:`);
    for (const r of show) {
      console.log(`    ✗ ${linter.linter}/${r}`);
    }
    if (undocumented.length > 5) {
      console.log(`    ... and ${String(undocumented.length - 5)} more`);
    }
  }
  console.log("");

  return { enabled: linter.rules.length, documented: documented.length };
}

function discover(): void {
  console.log("Scanning project for linter rules...\n");

  const result = generateTypes({ basePath: process.cwd() });
  const documentedRules = collectDocumentedRules();

  console.log("Detected linters:\n");

  let totalEnabled = 0;
  let totalDocumented = 0;

  for (const linter of result.linters) {
    const totals = printLinterCoverage(linter, documentedRules);
    totalEnabled += totals.enabled;
    totalDocumented += totals.documented;
  }

  if (result.linters.length === 0) {
    console.log("  No linters detected.\n");
  }

  const totalPct =
    totalEnabled > 0 ? Math.round((totalDocumented / totalEnabled) * 100) : 0;
  console.log(
    `Coverage: ${String(totalDocumented)}/${String(totalEnabled)} rules documented (${String(totalPct)}%)`,
  );

  if (totalDocumented < totalEnabled) {
    console.log(
      `\nConsider adding enforce() rules for frequently-triggered undocumented rules.`,
    );
    console.log(
      `The agent encounters these rules but has no context about WHY.`,
    );
  }
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
  const template = `import { claude, enforce, guidance, check, every } from "vigiles/spec";

export default claude({${targetLine}
  sections: {
    // Prose sections become ## headings in the compiled output.
    // Do not add # or ## headers inside sections.
    // positioning: "What this project does and why.",

    // This section is included in the compiled output to help agents
    // understand how to work with specs. Remove it once your team is familiar.
    "how-to-edit": "This file is compiled from a .spec.ts file. Do not edit it directly — edit the spec and run 'npx vigiles compile'. To add a rule: add to the rules object in the spec. To strengthen a guidance rule to enforcement: run 'npx vigiles strengthen'.",
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
    // check() — filesystem assertion:
    // "test-pairing": check(every("src/**/*.ts").has("{name}.test.ts"), "All files need tests."),
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
        run: npx vigiles check && npx vigiles generate-types --check`;

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
      // Find the last "run:" line and add after it
      const lines = content.split("\n");
      let lastRunIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s+-?\s*run:/.test(lines[i])) {
          lastRunIdx = i;
          break;
        }
      }
      if (lastRunIdx >= 0) {
        lines.splice(lastRunIdx + 1, 0, "", VIGILES_CI_STEP);
        writeFileSync(fullPath, lines.join("\n"));
        console.log(`✓ Added vigiles check step to ${ciPath}`);
        return true;
      }
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

  console.log("vigiles setup\n");

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
      if (needsSpec.every((f) => detected.instructionFiles.includes(f))) {
        // All existing files need migration — don't create new ones
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
  const addedGha = addGhaStep();
  if (!addedGha) {
    console.log("  No CI workflow found. Add this step to your CI:\n");
    console.log("    npx vigiles check && npx vigiles generate-types --check");
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

      if (!hooks["PreToolUse"]) {
        hooks["PreToolUse"] = [
          {
            matcher: "Edit|Write",
            command: `FILE=$(cat | jq -r '.tool_input.file_path // empty') && case "$FILE" in *.md) [ -f "$FILE" ] && head -1 "$FILE" | grep -q 'vigiles:sha256:' && { SPEC=$(head -1 "$FILE" | sed -n 's/.*compiled from \\(.*\\) -->/\\1/p'); echo "BLOCKED: Edit $SPEC instead." >&2; exit 2; } ;; esac; exit 0`,
          },
        ];
      }

      if (!hooks["PostToolUse"]) {
        hooks["PostToolUse"] = [
          {
            matcher: "Edit|Write",
            command: `FILE=$(cat | jq -r '.tool_input.file_path // empty') && case "$(basename "$FILE")" in eslint.config.*|.eslintrc*|package.json|pyproject.toml|Cargo.toml) npx vigiles generate-types 2>&1 || true ;; esac && case "$FILE" in *.spec.ts) npx vigiles compile 2>&1 || true ;; esac`,
          },
        ];
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log("✓ Installed hooks in .claude/settings.json");
      console.log(
        "  (For skills like edit-spec and migrate-to-spec, also run: npx skills add zernie/vigiles)",
      );
    }
  }

  // Step 8: Agent-specific guidance
  const specPaths = targets.map((t) => `${t}.spec.ts`).join(", ");

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

  // Step 9: Summary
  console.log("\n---");
  console.log("Setup complete.\n");
  console.log(`  Edit ${specPaths} — add your project's conventions`);
  console.log("  Run `npx vigiles strengthen` to upgrade guidance → enforce");
  console.log("\n  To commit everything now:");
  console.log(
    `    git add ${targets.join(" ")} ${specPaths} .vigiles/generated.d.ts${shouldInstallPlugin ? " .claude/settings.json" : ""} && git commit -m "Add vigiles spec"`,
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

async function strengthen(): Promise<void> {
  console.log("Scanning specs for guidance rules that could be enforced...\n");

  const specs = findSpecs();
  if (specs.length === 0) {
    console.log("No .spec.ts files found. Run `vigiles setup` first.");
    return;
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
        console.log(`  "${ruleId}" (guidance) → could be enforced:`);
        for (const m of matches) {
          console.log(`    enforce("${m}", "${rule.text.slice(0, 60)}")`);
        }
        console.log("");
      }
    }
  }

  if (suggestions === 0) {
    console.log(
      "No strengthening suggestions found. All guidance rules look correct,",
    );
    console.log("or no matching linter rules are enabled in your project.\n");
    console.log("To see all available linter rules: npx vigiles discover");
  } else {
    console.log(`${String(suggestions)} rule(s) could be strengthened.`);
    console.log(
      "Edit the spec to replace guidance() with enforce() for the suggested rules.",
    );
  }
}

// ---------------------------------------------------------------------------
// Migrate: hand-written .md → .spec.ts scaffold
// ---------------------------------------------------------------------------

function migrate(args: string[]): void {
  const inputFile = args.find((a) => !a.startsWith("--")) ?? "CLAUDE.md";
  const inputPath = resolve(process.cwd(), inputFile);

  if (!existsSync(inputPath)) {
    console.log(`File not found: ${inputFile}`);
    return;
  }

  const specPath = `${inputFile}.spec.ts`;
  if (existsSync(resolve(process.cwd(), specPath))) {
    console.log(`${specPath} already exists.`);
    return;
  }

  const content = readFileSync(inputPath, "utf-8");

  // Parse sections (## headings)
  const sectionEntries: Array<{ name: string; body: string }> = [];
  const lines = content.split("\n");
  let currentSection: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      if (currentSection) {
        sectionEntries.push({
          name: currentSection.name,
          body: currentSection.lines.join("\n").trim(),
        });
      }
      currentSection = { name: h2[1].trim(), lines: [] };
      continue;
    }
    if (currentSection) {
      currentSection.lines.push(line);
    }
  }
  if (currentSection) {
    sectionEntries.push({
      name: currentSection.name,
      body: currentSection.lines.join("\n").trim(),
    });
  }

  // Parse rules from ### headings
  const { parseRules } =
    require("./validate.js") as typeof import("./validate.js");
  const parsedRules = parseRules(content);

  // Build spec source
  const specLines: string[] = [];
  specLines.push(`import { claude, enforce, guidance } from "vigiles/spec";`);
  specLines.push(``);
  specLines.push(`export default claude({`);

  // Target
  if (inputFile !== "CLAUDE.md") {
    specLines.push(`  target: "${inputFile}",`);
    specLines.push(``);
  }

  // Sections (exclude Rules/Commands/Key Files — those have dedicated fields)
  const reservedSections = new Set([
    "rules",
    "commands",
    "key files",
    "keyfiles",
  ]);
  const sections = sectionEntries.filter(
    (s) => !reservedSections.has(s.name.toLowerCase()),
  );
  if (sections.length > 0) {
    specLines.push(`  sections: {`);
    for (const s of sections) {
      const key = s.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const escaped = s.body.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
      specLines.push(`    "${key}": \`${escaped}\`,`);
      specLines.push(``);
    }
    specLines.push(`  },`);
    specLines.push(``);
  }

  // Rules
  if (parsedRules.length > 0) {
    specLines.push(`  rules: {`);
    for (const rule of parsedRules) {
      const key = rule.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (rule.enforcement === "enforced" && rule.enforcedBy) {
        specLines.push(
          `    "${key}": enforce("${rule.enforcedBy}", "${rule.title}"),`,
        );
      } else {
        specLines.push(`    "${key}": guidance("${rule.title}"),`);
      }
    }
    specLines.push(`  },`);
  } else {
    specLines.push(`  rules: {},`);
  }

  specLines.push(`});`);
  specLines.push(``);

  writeFileSync(resolve(process.cwd(), specPath), specLines.join("\n"));
  console.log(`✓ Migrated ${inputFile} → ${specPath}`);
  console.log(``);
  console.log(`  ${String(sections.length)} sections extracted`);
  console.log(
    `  ${String(parsedRules.length)} rules found (${String(parsedRules.filter((r) => r.enforcement === "enforced").length)} enforced, ${String(parsedRules.filter((r) => r.enforcement === "guidance").length)} guidance)`,
  );
  console.log(``);
  console.log(`  Review the spec, then run: npx vigiles compile`);
  console.log(`  Strengthen guidance rules: npx vigiles strengthen`);
}

// ---------------------------------------------------------------------------
// Command handlers for main()
// ---------------------------------------------------------------------------

function findInstructionFiles(restArgs: string[]): string[] {
  if (restArgs.length > 0) return restArgs;
  return globSync("**/CLAUDE.md", {
    ignore: IGNORE_NODE_MODULES,
    cwd: process.cwd(),
  }).concat(
    globSync("**/SKILL.md", {
      ignore: IGNORE_NODE_MODULES,
      cwd: process.cwd(),
    }),
  );
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
    if (existing === result.dts) {
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
    "  vigiles setup [--target=X.md]  One-command setup: init + types + compile",
  );
  console.log("  vigiles compile [files...]    Compile .spec.ts → .md");
  console.log("  vigiles check [files...]      Verify hashes + run assertions");
  console.log(
    "  vigiles init [--target=X.md]  Scaffold a spec (default: CLAUDE.md)",
  );
  console.log("  vigiles generate-types [out]  Emit .d.ts from project state");
  console.log("  vigiles generate-types --check  Verify .d.ts is up to date");
  console.log("  vigiles discover              Show linter rule coverage gaps");
  console.log(
    "  vigiles strengthen            Suggest enforce() upgrades for guidance rules",
  );
  console.log(
    "  vigiles migrate [file]        Convert hand-written .md to .spec.ts",
  );
  console.log("  vigiles adopt                 Detect manual edits, show diff");
  console.log("");
  console.log("Examples:");
  console.log("  vigiles compile              Compile all .spec.ts files");
  console.log("  vigiles check                Verify hashes + assertions");
  console.log("  vigiles discover             Show undocumented linter rules");
  console.log("  vigiles generate-types       Emit .vigiles/generated.d.ts");
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
    case "check": {
      const files = findInstructionFiles(restArgs);
      if (files.length === 0) {
        console.log("No instruction files found to check.");
        process.exit(0);
      }
      const valid = await check(files);
      console.log("");
      if (!valid) {
        process.exit(1);
      }
      break;
    }
    case "setup":
      await setup(args);
      break;
    case "init":
      init(args);
      break;
    case "discover":
      discover();
      break;
    case "strengthen":
      await strengthen();
      break;
    case "migrate":
      migrate(restArgs);
      break;
    case "adopt":
      await adopt();
      console.log("");
      break;
    case "generate-types":
      handleGenerateTypes(args, restArgs);
      break;
    default:
      printUsage(command);
      break;
  }
}

void main();
