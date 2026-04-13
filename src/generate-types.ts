/**
 * vigiles generate-types — emit .d.ts with type unions from actual project state.
 *
 * Scans linter configs, package.json, and filesystem to generate TypeScript
 * types that the compiler uses to PROVE references are valid at authoring time.
 *
 * Generated types:
 *   - EslintRule / StylelintRule / RuffRule / ... — enabled rules per linter
 *   - NpmScript — scripts from package.json
 *   - ProjectFile — files in the project (scoped to src/ by default)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { globSync } from "glob";

// ---------------------------------------------------------------------------
// Linter config detection
// ---------------------------------------------------------------------------

function fileContainsSection(filePath: string, section: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return readFileSync(filePath, "utf-8").includes(section);
  } catch {
    return false;
  }
}

function hasRuffConfig(basePath: string): boolean {
  return (
    existsSync(resolve(basePath, "ruff.toml")) ||
    existsSync(resolve(basePath, ".ruff.toml")) ||
    fileContainsSection(resolve(basePath, "pyproject.toml"), "[tool.ruff")
  );
}

function hasPylintConfig(basePath: string): boolean {
  return (
    existsSync(resolve(basePath, ".pylintrc")) ||
    existsSync(resolve(basePath, "pylintrc")) ||
    fileContainsSection(resolve(basePath, "pyproject.toml"), "[tool.pylint") ||
    fileContainsSection(resolve(basePath, "setup.cfg"), "[pylint")
  );
}

function hasRubocopConfig(basePath: string): boolean {
  return existsSync(resolve(basePath, ".rubocop.yml"));
}

// ---------------------------------------------------------------------------
// Linter rule discovery
// ---------------------------------------------------------------------------

interface DiscoveredRules {
  linter: string;
  rules: string[];
  via: string;
}

function discoverEslintRules(basePath: string): DiscoveredRules | null {
  try {
    const script = `
      const { loadESLint } = require("eslint");
      (async () => {
        try {
          const ESLint = await loadESLint();
          const eslint = new ESLint({ cwd: ${JSON.stringify(basePath)} });
          const config = await eslint.calculateConfigForFile("dummy.js");
          const enabled = Object.entries(config.rules || {})
            .filter(([, v]) => {
              const sev = Array.isArray(v) ? v[0] : v;
              return sev !== 0 && sev !== "off";
            })
            .map(([k]) => k);
          console.log(JSON.stringify(enabled));
        } catch(e) {
          console.log("[]");
        }
      })();
    `;
    const output = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      cwd: basePath,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    const rules = JSON.parse(output.trim() || "[]") as string[];
    if (rules.length === 0) return null;
    return { linter: "eslint", rules, via: "flat config" };
  } catch {
    return null;
  }
}

function discoverStylelintRules(basePath: string): DiscoveredRules | null {
  try {
    const script = `
      const stylelint = require("stylelint");
      (async () => {
        try {
          const linter = stylelint.createLinter({});
          const result = await linter.getConfigForFile(${JSON.stringify(resolve(basePath, "dummy.css"))});
          const enabled = Object.entries(result.config.rules || {})
            .filter(([, v]) => v !== null && !(Array.isArray(v) && v[0] === null))
            .map(([k]) => k);
          console.log(JSON.stringify(enabled));
        } catch(e) {
          console.log("[]");
        }
      })();
    `;
    const output = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      cwd: basePath,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    const rules = JSON.parse(output.trim() || "[]") as string[];
    if (rules.length === 0) return null;
    return { linter: "stylelint", rules, via: "config" };
  } catch {
    return null;
  }
}

function discoverRuffRules(basePath: string): DiscoveredRules | null {
  try {
    if (!hasRuffConfig(basePath)) return null;
    execSync("which ruff", { stdio: "ignore" });
    const dummyPath = resolve(basePath, "dummy.py");
    const output = execSync(`ruff check --show-settings ${dummyPath}`, {
      encoding: "utf-8",
      cwd: basePath,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    const enabledMatch = output.match(
      /linter\.rules\.enabled\s*=\s*\[([\s\S]*?)\]/,
    );
    const rules: string[] = [];
    if (enabledMatch?.[1]) {
      const codeRe = /\(([A-Z]+\d*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = codeRe.exec(enabledMatch[1])) !== null) {
        rules.push(m[1]);
      }
    }
    if (rules.length === 0) return null;
    return { linter: "ruff", rules, via: "CLI" };
  } catch {
    return null;
  }
}

function discoverPylintRules(basePath: string): DiscoveredRules | null {
  try {
    if (!hasPylintConfig(basePath)) return null;
    execSync("which pylint", { stdio: "ignore" });
    const output = execSync("pylint --list-msgs-enabled", {
      encoding: "utf-8",
      cwd: basePath,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    const disabledIdx = output.indexOf("Disabled messages:");
    const enabledSection =
      disabledIdx >= 0 ? output.substring(0, disabledIdx) : output;
    // Extract rule IDs like (C0114), (W0611) etc.
    const rules: string[] = [];
    const idRe = /\(([A-Z]\d{4})\)/g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(enabledSection)) !== null) {
      rules.push(m[1]);
    }
    // Also extract symbolic names like "missing-module-docstring"
    const nameRe = /^(\w[\w-]+)\s*\(/gm;
    while ((m = nameRe.exec(enabledSection)) !== null) {
      rules.push(m[1]);
    }
    if (rules.length === 0) return null;
    return { linter: "pylint", rules, via: "CLI" };
  } catch {
    return null;
  }
}

function discoverRubocopRules(basePath: string): DiscoveredRules | null {
  try {
    if (!hasRubocopConfig(basePath)) return null;
    execSync("which rubocop", { stdio: "ignore" });
    const output = execSync(
      "rubocop --list-target-files --show-cops 2>/dev/null | head -500",
      {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
        shell: "/bin/sh",
      },
    );
    const rules: string[] = [];
    const copRe = /^(\w+\/\w+):/gm;
    let m: RegExpExecArray | null;
    while ((m = copRe.exec(output)) !== null) {
      rules.push(m[1]);
    }
    if (rules.length === 0) return null;
    return { linter: "rubocop", rules, via: "CLI" };
  } catch {
    return null;
  }
}

function discoverClippyRules(basePath: string): DiscoveredRules | null {
  try {
    const cargoPath = resolve(basePath, "Cargo.toml");
    if (!existsSync(cargoPath)) return null;
    execSync("which cargo", { stdio: "ignore" });
    // Clippy doesn't have a good "list enabled lints" command.
    // We read Cargo.toml [lints.clippy] section for explicit config,
    // and include default warn/deny lints from clippy -W clippy::all
    const content = readFileSync(cargoPath, "utf-8");
    const sectionMatch = content.match(/\[lints\.clippy\]([\s\S]*?)(?=\n\[|$)/);
    const rules: string[] = [];
    if (sectionMatch?.[1]) {
      const ruleRe = /^(\w[\w-]+)\s*=\s*"(\w+)"/gm;
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(sectionMatch[1])) !== null) {
        if (m[2] !== "allow") {
          rules.push(m[1]);
        }
      }
    }
    if (rules.length === 0) return null;
    return { linter: "clippy", rules, via: "Cargo.toml" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NPM script discovery
// ---------------------------------------------------------------------------

function discoverNpmScripts(basePath: string): string[] {
  const pkgPath = resolve(basePath, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Project file discovery
// ---------------------------------------------------------------------------

function discoverProjectFiles(
  basePath: string,
  globs: string[] = ["src/**/*"],
): string[] {
  const files: string[] = [];
  for (const pattern of globs) {
    const matches = globSync(pattern, {
      cwd: basePath,
      ignore: ["node_modules/**", "dist/**", ".git/**"],
      nodir: true,
    });
    files.push(...matches);
  }
  return [...new Set(files)].sort();
}

// ---------------------------------------------------------------------------
// Type generation
// ---------------------------------------------------------------------------

function escapeForUnion(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatUnion(items: string[], indent: string = "  "): string {
  if (items.length === 0) return "never";
  if (items.length <= 3) {
    return items.map((i) => `"${escapeForUnion(i)}"`).join(" | ");
  }
  return (
    "\n" + items.map((i) => `${indent}| "${escapeForUnion(i)}"`).join("\n")
  );
}

export interface GenerateTypesOptions {
  basePath?: string;
  fileGlobs?: string[];
}

export interface GenerateTypesResult {
  dts: string;
  linters: DiscoveredRules[];
  scripts: string[];
  files: string[];
}

/**
 * Generate .d.ts content with type unions from actual project state.
 *
 * Scans all available linters, package.json scripts, and project files.
 */
export function generateTypes(
  options: GenerateTypesOptions = {},
): GenerateTypesResult {
  const basePath = options.basePath ?? process.cwd();
  const fileGlobs = options.fileGlobs ?? ["src/**/*"];

  // Discover everything
  const linters: DiscoveredRules[] = [];

  const eslint = discoverEslintRules(basePath);
  if (eslint) linters.push(eslint);

  const stylelint = discoverStylelintRules(basePath);
  if (stylelint) linters.push(stylelint);

  const ruff = discoverRuffRules(basePath);
  if (ruff) linters.push(ruff);

  const pylint = discoverPylintRules(basePath);
  if (pylint) linters.push(pylint);

  const rubocop = discoverRubocopRules(basePath);
  if (rubocop) linters.push(rubocop);

  const clippy = discoverClippyRules(basePath);
  if (clippy) linters.push(clippy);

  const scripts = discoverNpmScripts(basePath);
  const files = discoverProjectFiles(basePath, fileGlobs);

  // Generate .d.ts
  const sections: string[] = [];

  sections.push(`/**`);
  sections.push(` * Auto-generated by \`vigiles generate-types\`.`);
  sections.push(
    ` * DO NOT EDIT — re-run \`vigiles generate-types\` to update.`,
  );
  sections.push(` */`);
  sections.push(``);
  // ---------------------------------------------------------------------------
  // vigiles/generated — standalone types for direct import
  // ---------------------------------------------------------------------------

  sections.push(`declare module "vigiles/generated" {`);

  // Linter rules
  for (const { linter, rules, via } of linters) {
    const typeName =
      linter.charAt(0).toUpperCase() +
      linter.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) +
      "Rule";
    sections.push(``);
    sections.push(
      `  /** ${String(rules.length)} enabled ${linter} rules (via ${via}). */`,
    );
    sections.push(`  export type ${typeName} = ${formatUnion(rules, "    ")};`);
  }

  // Combined linter rule type
  if (linters.length > 0) {
    const allNames = linters.map(
      (l) =>
        l.linter.charAt(0).toUpperCase() +
        l.linter
          .slice(1)
          .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) +
        "Rule",
    );
    sections.push(``);
    sections.push(
      `  /** All enabled linter rules across all detected linters. */`,
    );
    sections.push(`  export type LinterRule = ${allNames.join(" | ")};`);
  }

  // NPM scripts
  if (scripts.length > 0) {
    sections.push(``);
    sections.push(
      `  /** ${String(scripts.length)} npm scripts from package.json. */`,
    );
    sections.push(`  export type NpmScript = ${formatUnion(scripts, "    ")};`);
  }

  // Project files
  if (files.length > 0) {
    sections.push(``);
    sections.push(`  /** ${String(files.length)} project files. */`);
    sections.push(`  export type ProjectFile = ${formatUnion(files, "    ")};`);
  }

  sections.push(`}`);

  // ---------------------------------------------------------------------------
  // vigiles/spec augmentation — populates KnownLinterRules, KnownProjectFiles,
  // KnownNpmScripts interfaces so enforce(), file(), cmd() narrow automatically.
  // ---------------------------------------------------------------------------

  sections.push(``);
  sections.push(`declare module "vigiles/spec" {`);

  if (linters.length > 0) {
    sections.push(`  interface KnownLinterRules {`);
    for (const { linter, rules } of linters) {
      sections.push(
        `    "${escapeForUnion(linter)}": ${formatUnion(rules, "      ")};`,
      );
    }
    sections.push(`  }`);
  }

  if (files.length > 0) {
    sections.push(`  interface KnownProjectFiles {`);
    sections.push(`    files: ${formatUnion(files, "      ")};`);
    sections.push(`  }`);
  }

  if (scripts.length > 0) {
    sections.push(`  interface KnownNpmScripts {`);
    sections.push(`    scripts: ${formatUnion(scripts, "      ")};`);
    sections.push(`  }`);
  }

  sections.push(`}`);
  sections.push(``);

  return {
    dts: sections.join("\n"),
    linters,
    scripts,
    files,
  };
}
