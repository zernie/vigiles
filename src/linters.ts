/**
 * Linter cross-referencing engine.
 *
 * Verifies that linter rule references (e.g., "eslint/no-console") point to
 * real rules that exist and are enabled in project config. Supports:
 *   ESLint, Stylelint (Node API), Ruff, Clippy, Pylint, RuboCop (CLI).
 *
 * This is the core moat — no other tool resolves rules against 6 linter APIs
 * and checks config-enabled status.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { globSync } from "glob";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigEnabledStatus = "enabled" | "disabled" | "unknown";

export interface LinterCheckResult {
  exists: boolean;
  enabled: ConfigEnabledStatus;
  linter: string;
  rule: string;
  error?: string;
}

export interface DetectedLinter {
  name: string;
  ruleCount?: number;
  via?: string;
}

/** Extended Set with eslint metadata. */
interface EslintRuleSet extends Set<string> {
  _basePath?: string;
  _isEslint?: boolean;
}

// ---------------------------------------------------------------------------
// Parsing enforcement references
// ---------------------------------------------------------------------------

/** @internal */ export function extractLinterName(enforcedBy: string): string {
  const colonIdx = enforcedBy.indexOf("::");
  const slashIdx = enforcedBy.indexOf("/");
  if (colonIdx === -1 && slashIdx === -1) return enforcedBy;
  if (colonIdx === -1) return enforcedBy.substring(0, slashIdx);
  if (slashIdx === -1) return enforcedBy.substring(0, colonIdx);
  return enforcedBy.substring(0, Math.min(slashIdx, colonIdx));
}

/** @internal */ export function extractRuleName(
  enforcedBy: string,
): string | null {
  const colonIdx = enforcedBy.indexOf("::");
  const slashIdx = enforcedBy.indexOf("/");
  if (colonIdx === -1 && slashIdx === -1) return null;
  if (colonIdx === -1) return enforcedBy.substring(slashIdx + 1);
  if (slashIdx === -1) return enforcedBy.substring(colonIdx + 2);
  const idx = Math.min(slashIdx, colonIdx);
  const sep = idx === colonIdx ? 2 : 1;
  return enforcedBy.substring(idx + sep);
}

const SAFE_RULE_NAME_RE = /^[a-zA-Z0-9_\-/.:#]+$/;

// ---------------------------------------------------------------------------
// ESLint plugin resolution
// ---------------------------------------------------------------------------

function eslintPluginPkgNames(pluginName: string): string[] {
  if (pluginName.startsWith("@")) {
    const parts = pluginName.split("/");
    if (parts.length === 1) return [`${parts[0]}/eslint-plugin`];
    return [
      `${parts[0]}/eslint-plugin-${parts[1]}`,
      `${parts[0]}/eslint-plugin`,
    ];
  }
  return [`eslint-plugin-${pluginName}`];
}

function tryResolvePlugin(
  req: NodeJS.Require,
  pkg: string,
): Set<string> | null {
  try {
    const plugin = req(pkg) as {
      rules?: Record<string, unknown>;
      default?: { rules?: Record<string, unknown> };
    };
    const rules = plugin.rules ?? plugin.default?.rules;
    if (rules) return new Set(Object.keys(rules));
    return null;
  } catch {
    return null;
  }
}

function resolveEslintPluginRules(
  pluginName: string,
  basePath: string,
): Set<string> | null {
  try {
    const req = createRequire(resolve(basePath, "package.json"));
    const pkgNames = eslintPluginPkgNames(pluginName);
    for (const pkg of pkgNames) {
      const result = tryResolvePlugin(req, pkg);
      if (result) return result;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Built-in resolvers (Node API)
// ---------------------------------------------------------------------------

const LINTER_RESOLVERS: Record<
  string,
  (basePath: string) => EslintRuleSet | Set<string>
> = {
  eslint(basePath: string): EslintRuleSet {
    const req = createRequire(resolve(basePath, "package.json"));
    const { builtinRules } = req("eslint/use-at-your-own-risk") as {
      builtinRules: Map<string, unknown>;
    };
    const rules: EslintRuleSet = new Set(builtinRules.keys());
    rules._basePath = basePath;
    rules._isEslint = true;
    return rules;
  },
  stylelint(basePath: string): Set<string> {
    const req = createRequire(resolve(basePath, "package.json"));
    const mod = req("stylelint") as { rules: Record<string, unknown> };
    return new Set(Object.keys(mod.rules));
  },
};

// ---------------------------------------------------------------------------
// CLI-based per-rule checks
// ---------------------------------------------------------------------------

const CLI_RULE_CHECKS: Record<string, (ruleName: string) => void> = {
  ruff(ruleName: string): void {
    execSync(`ruff rule ${ruleName}`, { stdio: "ignore" });
  },
  clippy(ruleName: string): void {
    execSync(`cargo clippy --explain ${ruleName}`, { stdio: "ignore" });
  },
  pylint(ruleName: string): void {
    const output = execSync(`pylint --help-msg=${ruleName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (output.includes("No such message id")) {
      throw new Error(`Unknown pylint message: ${ruleName}`);
    }
  },
  rubocop(ruleName: string): void {
    const output = execSync(`rubocop --show-cops ${ruleName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!output || output.trim().length === 0) {
      throw new Error(`Unknown cop: ${ruleName}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Config-enabled checkers
// ---------------------------------------------------------------------------

type ConfigLoader = (ruleName: string) => ConfigEnabledStatus;

function createCachedChecker(
  loadConfigFn: (basePath: string) => ConfigLoader | null,
): (ruleName: string, basePath: string) => ConfigEnabledStatus {
  const cache = new Map<string, ConfigLoader | null>();
  return (ruleName: string, basePath: string): ConfigEnabledStatus => {
    if (!cache.has(basePath)) {
      try {
        cache.set(basePath, loadConfigFn(basePath));
      } catch {
        cache.set(basePath, null);
      }
    }
    const config = cache.get(basePath);
    if (!config) return "unknown";
    return config(ruleName);
  };
}

const LINTER_CONFIG_CHECKERS: Record<
  string,
  (ruleName: string, basePath: string) => ConfigEnabledStatus
> = {
  eslint: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const script = `
        const { loadESLint } = require("eslint");
        (async () => {
          try {
            const ESLint = await loadESLint();
            const eslint = new ESLint({ cwd: ${JSON.stringify(basePath)} });
            const config = await eslint.calculateConfigForFile("dummy.js");
            console.log(JSON.stringify(config.rules || {}));
          } catch(e) {
            console.log("{}");
          }
        })();
      `;
      const output = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      const rules = JSON.parse(output.trim() || "{}") as Record<
        string,
        unknown
      >;
      return (ruleName: string): ConfigEnabledStatus => {
        if (!(ruleName in rules)) return "unknown";
        const setting: unknown = rules[ruleName];
        const severity: unknown = Array.isArray(setting) ? setting[0] : setting;
        if (severity === 0 || severity === "off") return "disabled";
        return "enabled";
      };
    } catch {
      return null;
    }
  }),

  stylelint: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const script = `
        const stylelint = require("stylelint");
        (async () => {
          try {
            const linter = stylelint.createLinter({});
            const result = await linter.getConfigForFile(${JSON.stringify(resolve(basePath, "dummy.css"))});
            console.log(JSON.stringify(result.config.rules || {}));
          } catch(e) {
            console.log("{}");
          }
        })();
      `;
      const output = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      const rules = JSON.parse(output.trim() || "{}") as Record<
        string,
        unknown
      >;
      return (ruleName: string): ConfigEnabledStatus => {
        if (!(ruleName in rules)) return "unknown";
        const setting = rules[ruleName];
        if (setting === null || (Array.isArray(setting) && setting[0] === null))
          return "disabled";
        return "enabled";
      };
    } catch {
      return null;
    }
  }),

  ruff: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
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
      const enabledCodes = new Set<string>();
      if (enabledMatch?.[1]) {
        const codeRe = /\(([A-Z]+\d*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = codeRe.exec(enabledMatch[1])) !== null) {
          enabledCodes.add(m[1]);
        }
      }
      return (ruleName: string): ConfigEnabledStatus => {
        if (enabledCodes.has(ruleName)) return "enabled";
        for (const code of enabledCodes) {
          if (code.startsWith(ruleName)) return "enabled";
        }
        return "disabled";
      };
    } catch {
      return null;
    }
  }),

  pylint: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const output = execSync("pylint --list-msgs-enabled", {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      const disabledIdx = output.indexOf("Disabled messages:");
      const enabledSection =
        disabledIdx >= 0 ? output.substring(0, disabledIdx) : output;
      const disabledSection =
        disabledIdx >= 0 ? output.substring(disabledIdx) : "";
      return (ruleName: string): ConfigEnabledStatus => {
        if (disabledSection.includes(ruleName)) return "disabled";
        if (enabledSection.includes(ruleName)) return "enabled";
        return "unknown";
      };
    } catch {
      return null;
    }
  }),

  rubocop(ruleName: string, basePath: string): ConfigEnabledStatus {
    try {
      const output = execSync(`rubocop --show-cops ${ruleName}`, {
        encoding: "utf-8",
        cwd: basePath,
        stdio: ["pipe", "pipe", "ignore"],
      });
      if (!output || output.trim().length === 0) return "unknown";
      const enabledMatch = output.match(/Enabled:\s*(true|false|pending)/);
      if (!enabledMatch) return "unknown";
      return enabledMatch[1] === "true" ? "enabled" : "disabled";
    } catch {
      return "unknown";
    }
  },

  clippy: createCachedChecker((basePath: string): ConfigLoader | null => {
    try {
      const cargoPath = resolve(basePath, "Cargo.toml");
      if (!existsSync(cargoPath)) return null;
      const content = readFileSync(cargoPath, "utf-8");
      const sectionMatch = content.match(
        /\[lints\.clippy\]([\s\S]*?)(?=\n\[|$)/,
      );
      if (!sectionMatch?.[1]) return null;
      const section = sectionMatch[1];
      return (ruleName: string): ConfigEnabledStatus => {
        const shortName = ruleName.replace(/^clippy::/, "");
        const ruleMatch = section.match(
          new RegExp(
            `${shortName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*"(\\w+)"`,
          ),
        );
        if (!ruleMatch?.[1]) return "unknown";
        return ruleMatch[1] === "allow" ? "disabled" : "enabled";
      };
    } catch {
      return null;
    }
  }),
};

function cliAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CLI_TOOL_FOR_LINTER: Record<string, string> = {
  ruff: "ruff",
  clippy: "cargo",
  pylint: "pylint",
  rubocop: "rubocop",
};

// ---------------------------------------------------------------------------
// Custom linter support (rulesDir)
// ---------------------------------------------------------------------------

function ruleFileExists(
  ruleName: string,
  rulesDir: string,
  basePath: string,
): boolean | null {
  const dir = resolve(basePath, rulesDir);
  if (!existsSync(dir)) return null;
  const matches = globSync(`${ruleName}.*`, { cwd: dir });
  return matches.length > 0;
}

// ---------------------------------------------------------------------------
// checkLinterRule helpers
// ---------------------------------------------------------------------------

interface RuleContext {
  linterName: string;
  ruleName: string;
  basePath: string;
  catalogOnly?: boolean;
  linters?: Record<string, { rulesDir?: string | string[] }>;
}

function makeResult(
  ctx: RuleContext,
  exists: boolean,
  enabled: ConfigEnabledStatus = "unknown",
  error?: string,
): LinterCheckResult {
  return { exists, enabled, linter: ctx.linterName, rule: ctx.ruleName, error };
}

/** @internal */ function tryNodeResolver(
  ctx: RuleContext,
): LinterCheckResult | null {
  const resolver = LINTER_RESOLVERS[ctx.linterName];
  if (!resolver) return null;
  try {
    const resolved = resolver(ctx.basePath);
    const eslintSet = resolved as EslintRuleSet;

    if (!resolved.has(ctx.ruleName)) {
      const foundInPlugin =
        eslintSet._isEslint &&
        ctx.ruleName.includes("/") &&
        isEslintPluginRule(ctx.ruleName, eslintSet._basePath ?? ctx.basePath);
      if (!foundInPlugin) {
        return makeResult(
          ctx,
          false,
          "unknown",
          `Rule "${ctx.ruleName}" not found in ${ctx.linterName}`,
        );
      }
    }

    const enabled = checkConfigEnabled(
      ctx.linterName,
      ctx.ruleName,
      ctx.basePath,
      ctx.catalogOnly,
    );
    return makeResult(ctx, true, enabled);
  } catch {
    return null;
  }
}

function isEslintPluginRule(ruleName: string, basePath: string): boolean {
  const pluginPrefix = ruleName.substring(0, ruleName.indexOf("/"));
  const pluginRuleName = ruleName.substring(ruleName.indexOf("/") + 1);
  const pluginRules = resolveEslintPluginRules(pluginPrefix, basePath);
  return pluginRules?.has(pluginRuleName) === true;
}

/** @internal */ function tryScopedPlugin(
  ctx: RuleContext,
): LinterCheckResult | null {
  const pluginRules = resolveEslintPluginRules(ctx.linterName, ctx.basePath);
  if (!pluginRules) return null;
  if (!pluginRules.has(ctx.ruleName)) {
    return makeResult(
      ctx,
      false,
      "unknown",
      `Rule "${ctx.ruleName}" not found in ${ctx.linterName}`,
    );
  }
  const enabled = checkConfigEnabled(
    "eslint",
    `${ctx.linterName}/${ctx.ruleName}`,
    ctx.basePath,
    ctx.catalogOnly,
  );
  return makeResult(ctx, true, enabled);
}

/** @internal */ function tryCliCheck(
  ctx: RuleContext,
): LinterCheckResult | null {
  const cliCheck = CLI_RULE_CHECKS[ctx.linterName];
  if (!cliCheck) return null;
  const tool = CLI_TOOL_FOR_LINTER[ctx.linterName];
  if (tool && !cliAvailable(tool)) {
    return makeResult(
      ctx,
      false,
      "unknown",
      `${ctx.linterName} CLI tool "${tool}" not found on PATH`,
    );
  }
  try {
    cliCheck(ctx.ruleName);
    const enabled = checkConfigEnabled(
      ctx.linterName,
      ctx.ruleName,
      ctx.basePath,
      ctx.catalogOnly,
    );
    return makeResult(ctx, true, enabled);
  } catch {
    return makeResult(
      ctx,
      false,
      "unknown",
      `Rule "${ctx.ruleName}" not found in ${ctx.linterName}`,
    );
  }
}

/** @internal */ function tryCustomRulesDir(
  ctx: RuleContext,
): LinterCheckResult | null {
  const linterCfg = ctx.linters?.[ctx.linterName];
  if (!linterCfg?.rulesDir) return null;
  const dirs = Array.isArray(linterCfg.rulesDir)
    ? linterCfg.rulesDir
    : [linterCfg.rulesDir];
  for (const dir of dirs) {
    const found = ruleFileExists(ctx.ruleName, dir, ctx.basePath);
    if (found) return makeResult(ctx, true);
  }
  return makeResult(
    ctx,
    false,
    "unknown",
    `Rule file for "${ctx.ruleName}" not found in ${ctx.linterName} rulesDir`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a single linter rule reference (e.g., "eslint/no-console").
 *
 * Verifies: (1) rule exists in linter, (2) rule is enabled in project config.
 * Returns a result with exists/enabled status.
 */
export function checkLinterRule(
  enforcedBy: string,
  basePath: string,
  options?: {
    catalogOnly?: boolean;
    linters?: Record<string, { rulesDir?: string | string[] }>;
  },
): LinterCheckResult {
  const linterName = extractLinterName(enforcedBy);
  const ruleName = extractRuleName(enforcedBy);

  if (!ruleName || !SAFE_RULE_NAME_RE.test(ruleName)) {
    return {
      exists: false,
      enabled: "unknown",
      linter: linterName,
      rule: ruleName ?? enforcedBy,
      error: `Invalid rule reference: "${enforcedBy}"`,
    };
  }

  const ctx: RuleContext = {
    linterName,
    ruleName,
    basePath,
    catalogOnly: options?.catalogOnly,
    linters: options?.linters,
  };

  return (
    tryNodeResolver(ctx) ??
    tryScopedPlugin(ctx) ??
    tryCliCheck(ctx) ??
    tryCustomRulesDir(ctx) ??
    makeResult(ctx, false, "unknown", `Unknown linter: "${linterName}"`)
  );
}

function checkConfigEnabled(
  linterName: string,
  ruleName: string,
  basePath: string,
  catalogOnly?: boolean,
): ConfigEnabledStatus {
  if (catalogOnly) return "unknown";
  const checker = LINTER_CONFIG_CHECKERS[linterName];
  if (!checker) return "unknown";
  try {
    return checker(ruleName, basePath);
  } catch {
    return "unknown";
  }
}
