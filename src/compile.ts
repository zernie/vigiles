/**
 * vigiles v2 — Compiler: spec → markdown.
 *
 * Reads .spec.ts files, validates references, and produces
 * markdown instruction files with integrity hashes.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

import type {
  ClaudeSpec,
  SkillSpec,
  Rule,
  InstructionFragment,
  Ref,
  ProofAssertion,
} from "./spec.js";

import { checkLinterRule } from "./linters.js";
import type { LinterCheckResult } from "./linters.js";

// ---------------------------------------------------------------------------
// Hash utilities
// ---------------------------------------------------------------------------

const HASH_RE = /^<!-- vigiles:sha256:([a-f0-9]+) compiled from (.+) -->\n/;

/** Compute SHA-256 hash of content (excluding any existing hash line). */
export function computeHash(content: string): string {
  const body = content.replace(HASH_RE, "");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** Prepend a hash comment to compiled content. */
export function addHash(content: string, specFile: string): string {
  const hash = computeHash(content);
  return `<!-- vigiles:sha256:${hash} compiled from ${specFile} -->\n${content}`;
}

/** Check if a file's hash matches its content. Returns null if no hash found. */
export function verifyHash(
  content: string,
): { valid: boolean; specFile: string } | null {
  const match = content.match(HASH_RE);
  if (!match) return null;
  const expectedHash = match[1];
  const specFile = match[2];
  const body = content.replace(HASH_RE, "");
  const actualHash = createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  return { valid: actualHash === expectedHash, specFile };
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export interface CompileError {
  type: "stale-file" | "stale-command" | "stale-ref" | "invalid-rule";
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

function validateCommandRef(
  command: string,
  basePath: string,
): CompileError | null {
  // Check "npm run <script>" or "npm <script>" against package.json
  const npmRunMatch = command.match(/^npm\s+run\s+(\S+)/);
  const npmMatch = command.match(/^npm\s+(test|start|build|pretest)\b/);
  const scriptName = npmRunMatch?.[1] ?? npmMatch?.[1];

  if (scriptName) {
    const pkgPath = resolve(basePath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        if (!pkg.scripts?.[scriptName]) {
          return {
            type: "stale-command",
            message: `Script "${scriptName}" not found in package.json`,
            path: command,
          };
        }
      } catch {
        // Can't parse package.json — skip validation
      }
    }
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
    const r = fragment as Ref;
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

// ---------------------------------------------------------------------------
// Compile CLAUDE.md spec → markdown
// ---------------------------------------------------------------------------

function describeAssertion(assertion: ProofAssertion): string {
  switch (assertion._type) {
    case "file-pairing":
      return `every \`${assertion.glob}\` has \`${assertion.pattern}\``;
    case "pattern-absence":
      return `no match for \`${assertion.astPattern}\` in \`${assertion.glob}\``;
    case "layer-boundary": {
      const pairs = Object.entries(assertion.layers)
        .map(
          ([layer, { canImport }]) =>
            `${layer} → ${canImport.length > 0 ? canImport.join(", ") : "(none)"}`,
        )
        .join("; ");
      return `layer boundaries: ${pairs}`;
    }
  }
}

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

    case "prove":
      return [
        `### ${title}`,
        "",
        `**Enforced by:** \`vigiles/${id}\``,
        `**Why:** ${rule.why}`,
        `**Proof:** ${describeAssertion(rule.assertion)}`,
      ].join("\n");

    case "guidance":
      return [`### ${title}`, "", `**Guidance only** — ${rule.text}`].join(
        "\n",
      );
  }
}

export interface CompileClaudeResult {
  markdown: string;
  errors: CompileError[];
  linterResults: LinterCheckResult[];
}

export interface CompileClaudeOptions {
  basePath?: string;
  specFile?: string;
  /** Maximum number of rules allowed. Compilation fails if exceeded. */
  maxRules?: number;
  /** Skip config-enabled checks, only verify rule exists in catalog. */
  catalogOnly?: boolean;
  /** Custom linter configs (rulesDir). */
  linters?: Record<string, { rulesDir?: string | string[] }>;
}

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
  const basePath = options.basePath ?? process.cwd();
  const specFile = options.specFile ?? "CLAUDE.md.spec.ts";
  const errors: CompileError[] = [];
  const linterResults: LinterCheckResult[] = [];
  const sections: string[] = [];

  // maxRules check
  const ruleCount = Object.keys(spec.rules).length;
  if (options.maxRules && ruleCount > options.maxRules) {
    errors.push({
      type: "invalid-rule",
      message: `${String(ruleCount)} rules exceeds maxRules limit of ${String(options.maxRules)}. Split into subdirectory specs.`,
    });
  }

  sections.push("# CLAUDE.md");

  // Prose sections (before commands/key files/rules)
  if (spec.sections) {
    for (const [name, content] of Object.entries(spec.sections)) {
      const heading = name.charAt(0).toUpperCase() + name.slice(1);
      sections.push(`## ${heading}\n\n${content.trim()}`);
    }
  }

  // Key files
  if (spec.keyFiles) {
    const lines = ["## Key Files", ""];
    for (const [filePath, desc] of Object.entries(spec.keyFiles)) {
      lines.push(`- \`${filePath}\` — ${desc}`);
      const err = validateFileRef(filePath, basePath);
      if (err) errors.push(err);
    }
    sections.push(lines.join("\n"));
  }

  // Commands
  if (spec.commands) {
    const lines = ["## Commands", ""];
    for (const [command, desc] of Object.entries(spec.commands)) {
      lines.push(`- \`${command}\` — ${desc}`);
      const err = validateCommandRef(command, basePath);
      if (err) errors.push(err);
    }
    sections.push(lines.join("\n"));
  }

  // Rules
  if (Object.keys(spec.rules).length > 0) {
    const ruleLines = ["## Rules"];
    for (const [id, rule] of Object.entries(spec.rules)) {
      ruleLines.push("");
      ruleLines.push(compileRule(id, rule));

      // Verify enforce() rules against real linter configs
      if (rule._kind === "enforce") {
        const result = checkLinterRule(rule.linterRule, basePath, {
          catalogOnly: options.catalogOnly,
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
    sections.push(ruleLines.join("\n"));
  }

  const body = sections.join("\n\n") + "\n";
  const markdown = addHash(body, specFile);

  return { markdown, errors, linterResults };
}

// ---------------------------------------------------------------------------
// Compile SKILL.md spec → markdown
// ---------------------------------------------------------------------------

function renderFragment(fragment: InstructionFragment): string {
  if (typeof fragment === "string") return fragment;
  const r = fragment as Ref;
  switch (r._ref) {
    case "file":
      return `\`${r.path}\``;
    case "cmd":
      return `\`${r.command}\``;
    case "skill":
      return `[${basename(dirname(r.path))}](${r.path})`;
  }
}

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

  // Validate refs in body
  if (Array.isArray(spec.body)) {
    errors.push(...validateRefs(spec.body, basePath));
  }

  // Build frontmatter
  const fm: string[] = ["---"];
  fm.push(`name: ${spec.name}`);
  fm.push(`description: ${spec.description}`);
  if (spec.disableModelInvocation !== undefined) {
    fm.push(`disable-model-invocation: ${String(spec.disableModelInvocation)}`);
  }
  if (spec.argumentHint) {
    fm.push(`argument-hint: ${spec.argumentHint}`);
  }
  fm.push("---");

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
