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

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";
import { generateTypes } from "./generate-types.js";

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
  const distPath = fullPath
    .replace(/\/src\//, "/dist/")
    .replace(/\.ts$/, ".js");

  // Try loading from dist/ (compiled)
  if (existsSync(distPath)) {
    try {
      const mod = (await import(distPath)) as {
        default: ClaudeSpec | SkillSpec;
      };
      return mod.default;
    } catch {
      // Fall through
    }
  }

  // Try loading .ts directly (requires tsx or similar)
  try {
    const mod = (await import(fullPath)) as {
      default: ClaudeSpec | SkillSpec;
    };
    return mod.default;
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
      const outputPath = specPath
        .replace(/\.spec\.ts$/, "")
        .replace(/^examples\//, "");
      const { markdown, errors, linterResults } = compileClaude(spec, {
        basePath,
        specFile: specPath,
        maxRules: config.maxRules,
        catalogOnly: config.catalogOnly,
        linters: config.linters,
      });

      const linterCount = linterResults.filter((r) => r.exists).length;

      if (errors.length === 0) {
        writeFileSync(resolve(basePath, outputPath), markdown);
        console.log(`\n✓ ${specPath} → ${outputPath}`);
        console.log(
          `  ${String(Object.keys(spec.rules).length)} rules (${String(linterCount)} linter-verified)`,
        );
      } else {
        console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
        printErrors(specPath, errors);
        allValid = false;
        // Still write the file so the user can see partial output
        writeFileSync(resolve(basePath, outputPath), markdown);
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

async function check(filePaths: string[]): Promise<boolean> {
  const hashesValid = verifyHashes(filePaths);
  const assertionsValid = await runAssertions();
  return hashesValid && assertionsValid;
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

function init(): void {
  const specPath = "CLAUDE.md.spec.ts";
  if (existsSync(resolve(process.cwd(), specPath))) {
    console.log(`${specPath} already exists.`);
    return;
  }

  const template = `import { claude, enforce, guidance } from "vigiles/spec";

export default claude({
  commands: {
    // "npm run build": "Compile the project",
    // "npm test": "Run all tests",
  },

  keyFiles: {
    // "src/index.ts": "Main entry point",
  },

  sections: {
    // positioning: "What this project does and why.",
  },

  rules: {
    // "no-console": enforce("eslint/no-console", "Use structured logger."),
    // "research-first": guidance("Google unfamiliar APIs before implementing."),
  },
});
`;
  writeFileSync(resolve(process.cwd(), specPath), template);
  console.log(`Created ${specPath} — edit it and run \`vigiles compile\`.`);
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
  console.log("  vigiles compile [files...]    Compile .spec.ts → .md");
  console.log("  vigiles check [files...]      Verify hashes + run assertions");
  console.log("  vigiles init                  Scaffold a CLAUDE.md.spec.ts");
  console.log("  vigiles generate-types [out]  Emit .d.ts from project state");
  console.log("  vigiles discover              Show linter rule coverage gaps");
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
    case "init":
      init();
      break;
    case "discover":
      discover();
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
