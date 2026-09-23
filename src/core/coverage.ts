/**
 * Spec coverage analysis: how much of the project surface is documented in specs.
 *
 * Two metrics:
 * - Linter rule coverage: % of enabled linter rules with enforce() declarations
 * - Script coverage: % of npm scripts documented in spec commands
 *
 * Configurable thresholds in .vigilesrc.json trigger warnings or errors when
 * coverage drops below the minimum.
 */

import { existsSync, readFileSync } from "node:fs";
import { findIntegrityHeader } from "./integrity.js";
import { resolve } from "node:path";
import { globSync } from "glob";

import { withIgnored, type GlobIgnore } from "./glob-ignore.js";

import { readPackageScripts } from "./compile.js";
import type { CoverageThresholds } from "./types.js";
import type { ClaudeSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoverageMetric {
  name: string;
  total: number;
  covered: number;
  percent: number;
  threshold: number | undefined;
  passing: boolean;
  /** Items that ARE covered. */
  coveredItems: string[];
  /** Items that are NOT covered. */
  uncoveredItems: string[];
}

export interface CoverageReport {
  metrics: CoverageMetric[];
  passing: boolean;
}

// ---------------------------------------------------------------------------
// Script coverage
// ---------------------------------------------------------------------------

/**
 * Read npm script names from package.json. Reuses readPackageScripts
 * from compile.ts and returns sorted keys.
 */
export function readNpmScripts(basePath: string): string[] {
  const scripts = readPackageScripts(basePath);
  return scripts ? Object.keys(scripts).sort() : [];
}

/**
 * Collect commands documented in specs by loading spec source files directly.
 * Reads the structured `commands` field — no markdown parsing.
 */
export function collectDocumentedCommands(
  basePath: string,
  specs: ClaudeSpec[] | undefined,
  ignore: GlobIgnore,
): Set<string> {
  const commands = new Set<string>();

  if (specs) {
    for (const spec of specs) {
      if (spec.commands) {
        for (const cmd of Object.keys(spec.commands)) commands.add(cmd);
      }
    }
    return commands;
  }

  // Fallback: scan compiled markdown for spec file references, then
  // load the compiled JS spec from dist/. If that fails, try to
  // extract commands from the compiled output (last resort).
  // `ignore` is the repo's `ExcludeSet.globIgnore` (src/exclude.ts, correct
  // from any cwd) or patterns relative to `basePath`, required so this fallback cannot walk a
  // vendored corpus the repo excluded (#192). The CLI always passes `specs`,
  // so this branch is reached by the library path and tests only.
  const mdFiles = globSync("**/*.md", {
    ignore: withIgnored([], ignore),
    cwd: basePath,
  });

  for (const mdFile of mdFiles) {
    const fullPath = resolve(basePath, mdFile);
    try {
      const content = readFileSync(fullPath, "utf-8");
      // Ask integrity.ts where the header is — a compiled SKILL.md carries it AFTER its
      // frontmatter, so an `^`-anchored match here silently skipped every skill.
      const found = findIntegrityHeader(content);
      if (!found) continue;

      // Try to load the spec's compiled JS from dist/
      const specFile = found.specFile;
      const jsPath = resolve(
        basePath,
        "dist",
        specFile.replace(/\.ts$/, ".js"),
      );
      if (existsSync(jsPath)) {
        try {
          const mod = require(jsPath) as {
            default?: ClaudeSpec | { default?: ClaudeSpec };
          };
          const spec =
            mod.default && "default" in mod.default
              ? (mod.default.default as ClaudeSpec)
              : (mod.default as ClaudeSpec | undefined);
          if (spec?.commands) {
            for (const cmd of Object.keys(spec.commands)) commands.add(cmd);
          }
          continue;
        } catch {
          // Fall through to next file
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return commands;
}

/**
 * Compute script coverage: what % of npm scripts are documented in specs.
 */
export function computeScriptCoverage(
  basePath: string,
  threshold: number | undefined,
  specs: ClaudeSpec[] | undefined,
  ignore: GlobIgnore,
): CoverageMetric {
  const allScripts = readNpmScripts(basePath);
  const documented = collectDocumentedCommands(basePath, specs, ignore);

  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const script of allScripts) {
    // Match the same forms compile-time validation accepts in cmd():
    // "npm run <script>" or "npm <script>". Bare script names are not
    // executable refs — accepting them here would let stale entries
    // satisfy the coverage threshold without being verifiable.
    const npmRun = `npm run ${script}`;
    const npmDirect = `npm ${script}`;
    if (documented.has(npmRun) || documented.has(npmDirect)) {
      covered.push(script);
    } else {
      uncovered.push(script);
    }
  }

  const total = allScripts.length;
  const percent = total > 0 ? Math.round((covered.length / total) * 100) : 100;
  const passing = threshold === undefined || percent >= threshold;

  return {
    name: "scripts",
    total,
    covered: covered.length,
    percent,
    threshold,
    passing,
    coveredItems: covered,
    uncoveredItems: uncovered,
  };
}

/**
 * Compute linter rule coverage from pre-computed totals.
 * The actual linter scanning is done by the existing discover() in cli.ts.
 */
export function computeLinterRuleCoverage(
  enabled: number,
  documented: number,
  threshold?: number,
): CoverageMetric {
  const percent = enabled > 0 ? Math.round((documented / enabled) * 100) : 100;
  const passing = threshold === undefined || percent >= threshold;

  return {
    name: "linterRules",
    total: enabled,
    covered: documented,
    percent,
    threshold,
    passing,
    coveredItems: [],
    uncoveredItems: [],
  };
}

/**
 * Check all coverage metrics against thresholds.
 */
export function checkCoverage(
  basePath: string,
  thresholds: CoverageThresholds,
  linterEnabled: number,
  linterDocumented: number,
  specs: ClaudeSpec[] | undefined,
  ignore: GlobIgnore,
): CoverageReport {
  const metrics: CoverageMetric[] = [];

  // Linter rule coverage
  const linterMetric = computeLinterRuleCoverage(
    linterEnabled,
    linterDocumented,
    thresholds.linterRules,
  );
  metrics.push(linterMetric);

  // Script coverage
  const scriptMetric = computeScriptCoverage(
    basePath,
    thresholds.scripts,
    specs,
    ignore,
  );
  metrics.push(scriptMetric);

  const passing = metrics.every((m) => m.passing);
  return { metrics, passing };
}

/**
 * Format coverage report as human-readable text.
 */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];

  for (const m of report.metrics) {
    const status = m.threshold !== undefined ? (m.passing ? "✓" : "✗") : " ";
    const thresholdStr =
      m.threshold !== undefined ? ` (threshold: ${String(m.threshold)}%)` : "";
    lines.push(
      `  ${status} ${m.name}: ${String(m.covered)}/${String(m.total)} (${String(m.percent)}%)${thresholdStr}`,
    );

    if (!m.passing && m.uncoveredItems.length > 0) {
      const show = m.uncoveredItems.slice(0, 5);
      for (const item of show) {
        lines.push(`      missing: ${item}`);
      }
      if (m.uncoveredItems.length > 5) {
        lines.push(`      ... and ${String(m.uncoveredItems.length - 5)} more`);
      }
    }
  }

  return lines.join("\n");
}
