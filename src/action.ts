/**
 * GitHub Action entry point for vigiles.
 *
 * Runs `compile` or `audit` depending on the action input.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { globSync } from "glob";

import { compileClaude, compileSkill, addHash } from "./compile.js";
import type { ClaudeSpec, SkillSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Read action inputs
// ---------------------------------------------------------------------------

const command = process.env["INPUT_COMMAND"] ?? "audit";
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
  // Try several resolution strategies:
  // 1. Replace /src/ with /dist/ (standard TS project layout)
  // 2. Look under dist/ directly (root-level specs like CLAUDE.md.spec.ts)
  // 3. Use the .js extension in-place (pre-compiled specs)
  const jsName = specPath.replace(/\.ts$/, ".js");
  const candidates = [
    resolve(process.cwd(), jsName.replace(/\/src\//, "/dist/")),
    resolve(process.cwd(), "dist", jsName),
    resolve(process.cwd(), jsName),
  ];
  // Deduplicate (candidate 1 and 3 may match when there's no /src/)
  const unique = [...new Set(candidates)];

  for (const distPath of unique) {
    if (!existsSync(distPath)) continue;
    try {
      const mod = (await import(distPath)) as {
        default: ClaudeSpec | SkillSpec | { default: ClaudeSpec | SkillSpec };
      };
      // CJS modules (TypeScript with module: "Node16", no "type":
      // "module") produce `exports["default"] = spec`, so dynamic
      // import wraps it as `{ default: { default: spec } }`. Unwrap
      // the double-default when present.
      const raw = mod.default;
      if (raw && typeof raw === "object" && "default" in raw) {
        return (raw as { default: ClaudeSpec | SkillSpec }).default;
      }
      return raw;
    } catch {
      continue;
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
      const primaryOutput = specPath.replace(/\.spec\.ts$/, "");
      const { markdown, errors, targets } = compileClaude(spec, {
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

      // Write primary target
      writeFileSync(resolve(basePath, primaryOutput), markdown);
      const outputNames = [primaryOutput];

      // Write additional targets with swapped heading + recomputed hash
      for (const t of targets.slice(1)) {
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

      console.log(`Compiled: ${specPath} → ${outputNames.join(", ")}`);
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

function runAudit(): boolean {
  // Delegate to the CLI so the action always runs the full audit flow
  // (hash verification, spec validation, duplicate detection, coverage
  // report, strengthen suggestions). Previously this only ran
  // checkFileHash, which silently skipped everything else.
  const files = pathsInput
    ? pathsInput
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const cliPath = resolve(__dirname, "cli.js");
  const args = ["audit", ...files];
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      // Ensure the CLI emits GitHub annotations during the action run
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? "true",
    },
  });

  if (result.error) {
    console.log(
      `::error::Failed to run vigiles audit: ${result.error.message}`,
    );
    return false;
  }

  // Exit codes: 0 clean, 1 warnings, 2 hard errors.
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void (async () => {
  let valid: boolean;
  if (command === "compile") {
    valid = await runCompile();
  } else if (command === "audit") {
    valid = runAudit();
  } else {
    console.log(
      `::error::Unknown vigiles command "${command}". Valid commands: compile, audit.`,
    );
    process.exit(1);
  }

  console.log(`::set-output name=valid::${String(valid)}`);

  if (!valid) {
    console.log("::error::vigiles failed — see errors above");
    process.exit(1);
  }
})();
