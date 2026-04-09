/**
 * GitHub Action entry point for vigiles v2.
 *
 * Runs `compile` or `check` depending on the action input.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";

import { compileClaude, compileSkill, checkFileHash } from "./compile.js";
import type { ClaudeSpec, SkillSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Read action inputs
// ---------------------------------------------------------------------------

const command = process.env["INPUT_COMMAND"] ?? "check";
const pathsInput = process.env["INPUT_PATHS"];
const maxRulesInput =
  process.env["INPUT_MAX-RULES"] ?? process.env["INPUT_MAX_RULES"];
const catalogOnly =
  (process.env["INPUT_CATALOG-ONLY"] ??
    process.env["INPUT_CATALOG_ONLY"] ??
    "false") === "true";

const maxRules = maxRulesInput ? Number(maxRulesInput) : undefined;

// ---------------------------------------------------------------------------
// Spec loading (from compiled dist/)
// ---------------------------------------------------------------------------

async function loadSpec(
  specPath: string,
): Promise<ClaudeSpec | SkillSpec | null> {
  const distPath = resolve(
    process.cwd(),
    specPath.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js"),
  );
  if (existsSync(distPath)) {
    try {
      const mod = (await import(distPath)) as {
        default: ClaudeSpec | SkillSpec;
      };
      return mod.default;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runCompile(): Promise<boolean> {
  const specs = pathsInput
    ? pathsInput
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : globSync("**/*.spec.ts", { ignore: ["node_modules/**", "dist/**"] });

  if (specs.length === 0) {
    console.log("No .spec.ts files found.");
    return true;
  }

  let allValid = true;
  const basePath = process.cwd();

  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec) {
      console.log(`::error file=${specPath}::Failed to load spec`);
      allValid = false;
      continue;
    }

    if (spec._specType === "claude") {
      const outputPath = specPath.replace(/\.spec\.ts$/, "");
      const { markdown, errors } = compileClaude(spec, {
        basePath,
        specFile: specPath,
        maxRules,
        catalogOnly,
      });

      if (errors.length > 0) {
        for (const err of errors) {
          console.log(`::error file=${specPath}::${err.message}`);
        }
        allValid = false;
      }
      writeFileSync(resolve(basePath, outputPath), markdown);
      console.log(`Compiled: ${specPath} → ${outputPath}`);
    } else if (spec._specType === "skill") {
      const outputPath = specPath.replace(/\.spec\.ts$/, "");
      const { markdown, errors } = compileSkill(spec, {
        basePath,
        specFile: specPath,
      });

      if (errors.length > 0) {
        for (const err of errors) {
          console.log(`::error file=${specPath}::${err.message}`);
        }
        allValid = false;
      }
      writeFileSync(resolve(basePath, outputPath), markdown);
      console.log(`Compiled: ${specPath} → ${outputPath}`);
    }
  }

  return allValid;
}

function runCheck(): boolean {
  const files = pathsInput
    ? pathsInput
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [
        ...globSync("**/CLAUDE.md", { ignore: ["node_modules/**"] }),
        ...globSync("**/SKILL.md", { ignore: ["node_modules/**"] }),
      ];

  let allValid = true;

  for (const filePath of files) {
    const result = checkFileHash(resolve(process.cwd(), filePath));
    if (!result.hasHash) {
      console.log(`${filePath}: no vigiles hash (skipped)`);
      continue;
    }
    if (result.valid) {
      console.log(`${filePath}: hash valid`);
    } else {
      console.log(
        `::error file=${filePath}::Hash mismatch — file was manually edited after compilation`,
      );
      allValid = false;
    }
  }

  return allValid;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  let valid: boolean;
  if (command === "compile") {
    valid = await runCompile();
  } else {
    valid = runCheck();
  }

  console.log(`::set-output name=valid::${String(valid)}`);

  if (!valid) {
    console.log("::error::vigiles failed — see errors above");
    process.exit(1);
  }
})();
