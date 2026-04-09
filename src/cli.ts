#!/usr/bin/env node

/**
 * vigiles CLI — compile typed specs to instruction files.
 *
 * Commands:
 *   vigiles compile  — compile .spec.ts → .md with linter verification
 *   vigiles check    — verify hashes and validate hooks/skills
 *   vigiles init     — scaffold a spec from scratch
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";

import { compileClaude, compileSkill, checkFileHash } from "./compile.js";
import type { CompileError } from "./compile.js";
import type { ClaudeSpec, SkillSpec } from "./spec.js";

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
    ignore: ["node_modules/**", "dist/**"],
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
          `  ${String(Object.keys((spec as ClaudeSpec).rules).length)} rules (${String(linterCount)} linter-verified)`,
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

function check(filePaths: string[]): boolean {
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
    } else {
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
  }

  return allValid;
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
// Main
// ---------------------------------------------------------------------------

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
    compile(specs, config).then((valid) => {
      console.log("");
      if (valid) {
        console.log("Compilation complete.");
      } else {
        console.log("Compilation complete with errors.");
        process.exit(1);
      }
    });
    break;
  }
  case "check": {
    const files =
      restArgs.length > 0
        ? restArgs
        : globSync("**/CLAUDE.md", {
            ignore: ["node_modules/**"],
            cwd: process.cwd(),
          }).concat(
            globSync("**/SKILL.md", {
              ignore: ["node_modules/**"],
              cwd: process.cwd(),
            }),
          );
    if (files.length === 0) {
      console.log("No instruction files found to check.");
      process.exit(0);
    }
    const valid = check(files);
    console.log("");
    if (!valid) {
      process.exit(1);
    }
    break;
  }
  case "init":
    init();
    break;
  default:
    console.log("vigiles — compile typed specs to instruction files");
    console.log("");
    console.log("Commands:");
    console.log("  vigiles compile [files...]  Compile .spec.ts → .md");
    console.log("  vigiles check [files...]    Verify compiled file hashes");
    console.log("  vigiles init                Scaffold a CLAUDE.md.spec.ts");
    console.log("");
    console.log("Options:");
    console.log("  --help    Show this help");
    console.log("");
    console.log("Examples:");
    console.log("  vigiles compile              Compile all .spec.ts files");
    console.log("  vigiles check CLAUDE.md      Verify CLAUDE.md hash");
    console.log("  vigiles init                 Create starter spec");
    if (command && command !== "--help") {
      console.log(`\nUnknown command: "${command}"`);
      process.exit(1);
    }
    break;
}
