/**
 * vigiles v2 — Compiler: spec → markdown.
 *
 * Reads .spec.ts files, validates references, and produces
 * markdown instruction files with integrity hashes.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

import { sha256short, assertNever } from "./hash.js";

import type {
  ClaudeSpec,
  SkillSpec,
  Rule,
  InstructionFragment,
} from "./spec.js";

import { checkLinterRule, extractLinterName } from "./linters.js";
import type { LinterCheckResult } from "./linters.js";

// ---------------------------------------------------------------------------
// Hash utilities
// ---------------------------------------------------------------------------

const HASH_RE =
  /^<!-- vigiles:sha256:([a-f0-9]+) compiled from (.+) -->\r?\n\r?\n?/;

/** @internal Compute SHA-256 hash of content (excluding any existing hash line). */
export function computeHash(content: string): string {
  const body = content.replace(HASH_RE, "");
  return sha256short(body);
}

/** @internal Prepend a hash comment to compiled content. */
export function addHash(content: string, specFile: string): string {
  const hash = computeHash(content);
  return `<!-- vigiles:sha256:${hash} compiled from ${specFile} -->\n\n${content}`;
}

/** @internal Check if a file's hash matches its content. Returns null if no hash found. */
export function verifyHash(
  content: string,
): { valid: boolean; specFile: string } | null {
  const match = content.match(HASH_RE);
  if (!match) return null;
  const expectedHash = match[1];
  const specFile = match[2];
  const body = content.replace(HASH_RE, "");
  const actualHash = sha256short(body);
  return { valid: actualHash === expectedHash, specFile };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a string.
 *
 * Uses the ~4 characters per token heuristic (accurate within ~10% for
 * English text and code). Swap in a real BPE tokenizer (tiktoken, gpt-tokenizer)
 * for exact counts if needed.
 */
/** @internal */ export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export interface CompileError {
  type:
    | "stale-file"
    | "stale-command"
    | "stale-ref"
    | "invalid-rule"
    | "budget-exceeded"
    | "section-too-long"
    | "section-has-header"
    | "reserved-section-key"
    | "spec-name-mismatch";
  message: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Reference validation
// ---------------------------------------------------------------------------

function validateFileRef(
  filePath: string,
  basePath: string,
): CompileError | null {
  const resolved = resolve(basePath, filePath);
  if (!existsSync(resolved)) {
    return {
      type: "stale-file",
      message: `File not found: "${filePath}"`,
      path: filePath,
    };
  }
  return null;
}

export function readPackageScripts(
  basePath: string,
): Record<string, string> | null {
  const pkgPath = resolve(basePath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? null;
  } catch {
    return null;
  }
}

function validateCommandRef(
  command: string,
  basePath: string,
): CompileError | null {
  // Check "npm run <script>" or "npm <script>" against package.json
  const npmRunMatch = command.match(/^npm\s+run\s+(\S+)/);
  const npmMatch = command.match(/^npm\s+(test|start|build|pretest)\b/);
  const scriptName = npmRunMatch?.[1] ?? npmMatch?.[1];
  if (!scriptName) return null;

  const scripts = readPackageScripts(basePath);
  if (!scripts) return null;

  if (!scripts[scriptName]) {
    return {
      type: "stale-command",
      message: `Script "${scriptName}" not found in package.json`,
      path: command,
    };
  }
  return null;
}

function validateRefs(
  fragments: InstructionFragment[],
  basePath: string,
): CompileError[] {
  const errors: CompileError[] = [];
  for (const fragment of fragments) {
    if (typeof fragment === "string") continue;
    const r = fragment;
    switch (r._ref) {
      case "file": {
        const err = validateFileRef(r.path, basePath);
        if (err) errors.push(err);
        break;
      }
      case "cmd": {
        const err = validateCommandRef(r.command, basePath);
        if (err) errors.push(err);
        break;
      }
      case "skill": {
        const err = validateFileRef(r.path, basePath);
        if (err) {
          errors.push({
            type: "stale-ref",
            message: `Skill not found: "${r.path}"`,
            path: r.path,
          });
        }
        break;
      }
    }
  }
  return errors;
}

function renderFragment(fragment: InstructionFragment): string {
  if (typeof fragment === "string") return fragment;
  switch (fragment._ref) {
    case "file":
      return `\`${fragment.path}\``;
    case "cmd":
      return `\`${fragment.command}\``;
    case "skill":
      return `[${basename(dirname(fragment.path))}](${fragment.path})`;
    default:
      return assertNever(fragment);
  }
}

// ---------------------------------------------------------------------------
// Compile CLAUDE.md spec → markdown
// ---------------------------------------------------------------------------

function compileRule(id: string, rule: Rule): string {
  const title = id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  switch (rule._kind) {
    case "enforce":
      return [
        `### ${title}`,
        "",
        `**Enforced by:** \`${rule.linterRule}\``,
        `**Why:** ${rule.why}`,
      ].join("\n");

    case "guidance":
      return [`### ${title}`, "", `**Guidance only** — ${rule.text}`].join(
        "\n",
      );

    case "guard": {
      const patterns = Array.isArray(rule.watch)
        ? rule.watch.join("`, `")
        : rule.watch;
      return [
        `### ${title}`,
        "",
        `**Guard:** \`${patterns}\` → \`${rule.run}\``,
        `**Why:** ${rule.description}`,
      ].join("\n");
    }

    default:
      return assertNever(rule);
  }
}

export interface CompileClaudeResult {
  markdown: string;
  errors: CompileError[];
  linterResults: LinterCheckResult[];
  /** Estimated token count of compiled output (~4 chars/token). */
  tokens: number;
  /** All targets from the spec (for multi-target compilation). */
  targets: string[];
}

export interface CompileClaudeOptions {
  basePath?: string;
  specFile?: string;
  /** Maximum number of rules allowed. Compilation fails if exceeded. */
  maxRules?: number;
  /** Maximum estimated tokens for compiled output. */
  maxTokens?: number;
  /** Maximum lines per prose section. Forces splitting into named sections. */
  maxSectionLines?: number;
  /** Skip config-enabled checks, only verify rule exists in catalog. */
  catalogOnly?: boolean;
  /** Custom linter configs (rulesDir). */
  linters?: Record<string, { rulesDir?: string | string[] }>;
  /** Global kill switch: skip ALL linter verification. */
  verifyLinters?: boolean;
  /** Per-linter verification mode: true (full), "catalog-only", or false (skip). */
  linterModes?: Record<string, boolean | "catalog-only">;
}

// ---------------------------------------------------------------------------
// compileClaude section helpers
// ---------------------------------------------------------------------------

interface SectionResult {
  lines: string[];
  errors: CompileError[];
}

function validateSectionContent(
  name: string,
  text: string,
  maxSectionLines?: number,
): CompileError[] {
  const errors: CompileError[] = [];
  const contentLines = text.split("\n");

  // Reject markdown headers inside sections — sections compile to ## headings,
  // so raw # headers break document structure and signal pasted-in content.
  // Skip lines inside fenced code blocks (``` or ~~~).
  let inFence = false;
  for (const line of contentLines) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^ {0,3}#{1,2}\s/.test(line)) {
      errors.push({
        type: "section-has-header",
        message: `Section "${name}" contains a markdown header ("${line.trim().slice(0, 60)}"). Break into separate named sections instead.`,
      });
      break;
    }
  }

  if (maxSectionLines && contentLines.length > maxSectionLines) {
    errors.push({
      type: "section-too-long",
      message: `Section "${name}" is ${String(contentLines.length)} lines (max ${String(maxSectionLines)}). Split into smaller named sections.`,
    });
  }

  return errors;
}

const RESERVED_SECTION_KEYS = new Set([
  "commands",
  "keyFiles",
  "key-files",
  "key_files",
  "rules",
]);

function compileSectionsSection(
  spec: ClaudeSpec,
  basePath: string,
  maxSectionLines?: number,
): SectionResult {
  if (!spec.sections) return { lines: [], errors: [] };
  const lines: string[] = [];
  const errors: CompileError[] = [];
  for (const [name, content] of Object.entries(spec.sections)) {
    // #4: reject reserved section keys that clash with structured fields
    if (RESERVED_SECTION_KEYS.has(name)) {
      errors.push({
        type: "reserved-section-key",
        message: `Section key "${name}" is reserved — use the dedicated \`${name}\` field on the spec instead.`,
      });
    }
    const heading = name.charAt(0).toUpperCase() + name.slice(1);
    if (typeof content === "string") {
      errors.push(...validateSectionContent(name, content, maxSectionLines));
      lines.push(`## ${heading}\n\n${content.trim()}`);
    } else {
      errors.push(...validateRefs(content, basePath));
      const rendered = content.map(renderFragment).join("");
      errors.push(...validateSectionContent(name, rendered, maxSectionLines));
      lines.push(`## ${heading}\n\n${rendered.trim()}`);
    }
  }
  return { lines, errors };
}

function compileKeyFilesSection(
  spec: ClaudeSpec,
  basePath: string,
): SectionResult {
  if (!spec.keyFiles) return { lines: [], errors: [] };
  const lines = ["## Key Files", ""];
  const errors: CompileError[] = [];
  for (const [filePath, desc] of Object.entries(spec.keyFiles)) {
    lines.push(`- \`${filePath}\` — ${desc}`);
    const err = validateFileRef(filePath, basePath);
    if (err) errors.push(err);
  }
  return { lines: [lines.join("\n")], errors };
}

function compileCommandsSection(
  spec: ClaudeSpec,
  basePath: string,
): SectionResult {
  if (!spec.commands) return { lines: [], errors: [] };
  const lines = ["## Commands", ""];
  const errors: CompileError[] = [];
  for (const [command, desc] of Object.entries(spec.commands)) {
    lines.push(`- \`${command}\` — ${desc}`);
    const err = validateCommandRef(command, basePath);
    if (err) errors.push(err);
  }
  return { lines: [lines.join("\n")], errors };
}

/**
 * Determine if a rule should be verified, checking three levels:
 * 1. Per-rule: enforce("...", "...", { verify: false })
 * 2. Global: options.verifyLinters === false
 * 3. Per-linter: options.linterModes[linterName] === false
 */
function shouldVerifyRule(
  rule: { linterRule: string; verify: boolean },
  options: CompileClaudeOptions,
): boolean {
  if (!rule.verify) return false;
  if (options.verifyLinters === false) return false;
  const linterName = extractLinterName(rule.linterRule);
  const linterMode = options.linterModes?.[linterName];
  if (linterMode === false) return false;
  return true;
}

interface RulesSectionResult extends SectionResult {
  linterResults: LinterCheckResult[];
}

function compileRulesSection(
  spec: ClaudeSpec,
  basePath: string,
  options: CompileClaudeOptions,
): RulesSectionResult {
  const ruleEntries = Object.entries(spec.rules);
  if (ruleEntries.length === 0) {
    return { lines: [], errors: [], linterResults: [] };
  }
  const ruleLines = ["## Rules"];
  const errors: CompileError[] = [];
  const linterResults: LinterCheckResult[] = [];

  for (const [id, rule] of ruleEntries) {
    ruleLines.push("");
    ruleLines.push(compileRule(id, rule));
    if (rule._kind === "enforce") {
      const shouldVerify = shouldVerifyRule(rule, options);
      if (!shouldVerify) continue;

      const linterName = extractLinterName(rule.linterRule);
      const linterMode = options.linterModes?.[linterName];
      const catalogOnly = options.catalogOnly || linterMode === "catalog-only";

      const result = checkLinterRule(rule.linterRule, basePath, {
        catalogOnly,
        linters: options.linters,
      });
      linterResults.push(result);
      if (!result.exists) {
        errors.push({
          type: "invalid-rule",
          message:
            result.error ??
            `Rule "${rule.linterRule}" not found in ${result.linter}`,
          path: rule.linterRule,
        });
      } else if (result.enabled === "disabled") {
        errors.push({
          type: "invalid-rule",
          message: `Rule "${result.rule}" exists but is disabled in ${result.linter} config`,
          path: rule.linterRule,
        });
      }
    }
  }
  return { lines: [ruleLines.join("\n")], errors, linterResults };
}

// ---------------------------------------------------------------------------
// compileClaude
// ---------------------------------------------------------------------------

/**
 * Compile a ClaudeSpec into markdown.
 *
 * Returns the compiled markdown, validation errors, and linter check results.
 * The markdown is generated even if there are errors (with warnings).
 */
export function compileClaude(
  spec: ClaudeSpec,
  options: CompileClaudeOptions = {},
): CompileClaudeResult {
  const targets = spec.target ?? "CLAUDE.md";
  const target = Array.isArray(targets) ? targets[0] : targets;
  const basePath = options.basePath ?? process.cwd();
  const specFile = options.specFile ?? `${target}.spec.ts`;
  const errors: CompileError[] = [];
  const sections: string[] = [`# ${target}`];

  // Verify spec file naming matches the primary target
  if (!specFile.endsWith(".spec.ts")) {
    errors.push({
      type: "spec-name-mismatch",
      message: `Spec file "${specFile}" must end with .spec.ts`,
    });
  } else {
    const baseName = basename(specFile, ".spec.ts");
    if (baseName !== target) {
      errors.push({
        type: "spec-name-mismatch",
        message: `Spec file "${specFile}" doesn't match target "${target}". Expected "${target}.spec.ts".`,
      });
    }
  }

  // maxRules check
  const ruleCount = Object.keys(spec.rules).length;
  if (options.maxRules && ruleCount > options.maxRules) {
    errors.push({
      type: "invalid-rule",
      message: `${String(ruleCount)} rules exceeds maxRules limit of ${String(options.maxRules)}. Split into subdirectory specs.`,
    });
  }

  // Per-spec maxSectionLines takes precedence, then compile options
  const maxSectionLines = spec.maxSectionLines ?? options.maxSectionLines;
  const prose = compileSectionsSection(spec, basePath, maxSectionLines);
  const keyFiles = compileKeyFilesSection(spec, basePath);
  const commands = compileCommandsSection(spec, basePath);
  const rules = compileRulesSection(spec, basePath, options);

  sections.push(
    ...prose.lines,
    ...keyFiles.lines,
    ...commands.lines,
    ...rules.lines,
  );
  errors.push(
    ...prose.errors,
    ...keyFiles.errors,
    ...commands.errors,
    ...rules.errors,
  );

  const body = sections.join("\n\n") + "\n";
  const tokens = estimateTokens(body);

  // Per-spec maxTokens takes precedence, then compile options
  const maxTokens = spec.maxTokens ?? options.maxTokens;
  if (maxTokens && tokens > maxTokens) {
    errors.push({
      type: "budget-exceeded",
      message: `Compiled output is ~${String(tokens)} tokens, exceeding maxTokens limit of ${String(maxTokens)}. Trim prose sections, split into multiple specs, or raise maxTokens.`,
    });
  }

  const markdown = addHash(body, specFile);
  const allTargets = Array.isArray(targets) ? targets : [targets];
  return {
    markdown,
    errors,
    linterResults: rules.linterResults,
    tokens,
    targets: allTargets,
  };
}

// ---------------------------------------------------------------------------
// Compile SKILL.md spec → markdown
// ---------------------------------------------------------------------------

function renderBody(body: string | InstructionFragment[]): string {
  if (typeof body === "string") return body;
  return body.map(renderFragment).join("");
}

export interface CompileSkillResult {
  markdown: string;
  errors: CompileError[];
}

/**
 * Compile a SkillSpec into SKILL.md markdown with YAML frontmatter.
 */
export function compileSkill(
  spec: SkillSpec,
  options: { basePath?: string; specFile?: string } = {},
): CompileSkillResult {
  const basePath = options.basePath ?? process.cwd();
  const specFile = options.specFile ?? "SKILL.md.spec.ts";
  const errors: CompileError[] = [];

  // Verify spec file naming
  if (!specFile.endsWith(".spec.ts")) {
    errors.push({
      type: "spec-name-mismatch",
      message: `Spec file "${specFile}" must end with .spec.ts`,
    });
  } else {
    const baseName = basename(specFile, ".spec.ts");
    if (!/\.md$/i.test(baseName)) {
      errors.push({
        type: "spec-name-mismatch",
        message: `Spec file "${specFile}" should be named <output>.spec.ts (e.g., SKILL.md.spec.ts)`,
      });
    }
  }

  // Validate refs in body
  if (Array.isArray(spec.body)) {
    errors.push(...validateRefs(spec.body, basePath));
  }

  // Build frontmatter (blank lines after opening/before closing --- for prettier)
  const fm: string[] = ["---", ""];
  fm.push(`name: ${spec.name}`);
  fm.push(`description: ${spec.description}`);
  if (spec.disableModelInvocation !== undefined) {
    fm.push(`disable-model-invocation: ${String(spec.disableModelInvocation)}`);
  }
  if (spec.argumentHint) {
    fm.push(`argument-hint: ${spec.argumentHint}`);
  }
  fm.push("", "---");

  const body = renderBody(spec.body);
  const content = fm.join("\n") + "\n\n" + body.trim() + "\n";
  const markdown = addHash(content, specFile);

  return { markdown, errors };
}

// ---------------------------------------------------------------------------
// Hash check for existing files
// ---------------------------------------------------------------------------

export interface HashCheckResult {
  hasHash: boolean;
  valid: boolean;
  specFile: string | null;
}

/** Check if a generated file's hash is intact. */
export function checkFileHash(filePath: string): HashCheckResult {
  if (!existsSync(filePath)) {
    return { hasHash: false, valid: false, specFile: null };
  }
  const content = readFileSync(filePath, "utf-8");
  const result = verifyHash(content);
  if (!result) {
    return { hasHash: false, valid: false, specFile: null };
  }
  return { hasHash: true, valid: result.valid, specFile: result.specFile };
}

// ---------------------------------------------------------------------------
// Adopt: detect manual edits and show diff
// ---------------------------------------------------------------------------

export interface AdoptResult {
  filePath: string;
  hasHash: boolean;
  valid: boolean;
  specFile: string | null;
  currentContent: string;
  compiledContent: string | null;
  addedLines: string[];
  removedLines: string[];
  changed: boolean;
}

/**
 * Compare a generated file against what the spec would produce.
 * Returns the diff so users can see what was manually changed.
 */
export function adoptDiff(
  filePath: string,
  spec: ClaudeSpec | SkillSpec,
  basePath: string,
): AdoptResult {
  const fullPath = resolve(basePath, filePath);
  const currentContent = existsSync(fullPath)
    ? readFileSync(fullPath, "utf-8")
    : "";

  const hashResult = verifyHash(currentContent);

  // Compile the spec to get what it WOULD produce
  let compiledContent: string | null = null;
  if (spec._specType === "claude") {
    const { markdown } = compileClaude(spec, { basePath, specFile: filePath });
    compiledContent = markdown;
  } else if (spec._specType === "skill") {
    const { markdown } = compileSkill(spec, { basePath, specFile: filePath });
    compiledContent = markdown;
  }

  // Simple line-based diff
  const currentLines = currentContent.replace(HASH_RE, "").split("\n");
  const compiledLines = (compiledContent ?? "")
    .replace(HASH_RE, "")
    .split("\n");

  const currentSet = new Set(currentLines);
  const compiledSet = new Set(compiledLines);

  const addedLines = currentLines.filter(
    (l) => l.trim() && !compiledSet.has(l),
  );
  const removedLines = compiledLines.filter(
    (l) => l.trim() && !currentSet.has(l),
  );

  return {
    filePath,
    hasHash: hashResult !== null,
    valid: hashResult?.valid ?? false,
    specFile: hashResult?.specFile ?? null,
    currentContent,
    compiledContent,
    addedLines,
    removedLines,
    changed: addedLines.length > 0 || removedLines.length > 0,
  };
}
