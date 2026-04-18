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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { CoverageThresholds } from "./types.js";

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
 * Read npm scripts from package.json.
 */
export function readNpmScripts(basePath: string): string[] {
  const pkgPath = resolve(basePath, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return Object.keys(pkg.scripts ?? {}).sort();
  } catch {
    return [];
  }
}

/**
 * Collect commands documented in compiled instruction files.
 * Extracts from "## Commands" sections in compiled markdown.
 */
export function collectDocumentedCommands(basePath: string): Set<string> {
  const commands = new Set<string>();

  const dir = resolve(basePath, ".vigiles");
  if (!existsSync(dir)) return commands;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return commands;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".inputs.json")) continue;
    const target = entry.replace(".inputs.json", "");
    const targetPath = resolve(basePath, target);
    if (!existsSync(targetPath)) continue;

    try {
      const content = readFileSync(targetPath, "utf-8");
      const cmdRe = /^- `([^`]+)` — /gm;
      let match: RegExpExecArray | null;
      // Only extract from Commands section
      const cmdSection = content.match(
        /## Commands\n\n((?:- `[^`]+` — .+\n?)+)/,
      );
      if (cmdSection) {
        while ((match = cmdRe.exec(cmdSection[1])) !== null) {
          commands.add(match[1]);
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
  threshold?: number,
): CoverageMetric {
  const allScripts = readNpmScripts(basePath);
  const documented = collectDocumentedCommands(basePath);

  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const script of allScripts) {
    // Check both "npm run <script>" and "npm <script>" forms
    const npmRun = `npm run ${script}`;
    const npmDirect = `npm ${script}`;
    if (
      documented.has(npmRun) ||
      documented.has(npmDirect) ||
      documented.has(script)
    ) {
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
  const scriptMetric = computeScriptCoverage(basePath, thresholds.scripts);
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
