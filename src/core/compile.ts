/**
 * Compiler: spec → markdown with SHA-256 hash, linter verification, reference validation; compileClaude/compileSkill/compileAgent (subagents: frontmatter + verified tool contract + body marks + result-contract Output section) + compileRailway/validateRailway (orchestrator command over flat workers; delegate-target resolution + bounded recovery) + purity-floor enforcement (purityViolations: a pure/bounded contract rejects a tool looser than its floor; absent tools = inherits-all = checked as the '*' wildcard, never trivially pure) + emits a <!-- vigiles:purity:LEVEL --> marker on a compiled agent OR skill (dangerously-unrestricted → the neutral runtime level unrestricted) so the runtime PreToolUse gate can read+enforce the declared floor (parseAgentPurity/parseSkillPurity → decidePurityGate). renderFragment/validateRefs also handle the effect() EffectRegion fragment — rendering its body wrapped in <!-- vigiles:effect -->…<!-- /vigiles:effect --> markers (inside the integrity hash) and recursing to verify inner file()/cmd() refs.
 * Compile gates added 2026-06-20: a generous DEFAULT_MAX_SECTION_LINES=200 guard on every named prose section (claude + agent), overridable via maxSectionLines (TS types can't bound string length); agent disallowedTools verified via disallowedToolIssues (a close typo blocks nothing); a forked skill's output renders the SAME ## Output contract via renderOutputContract, and output without context:'fork' is the output-without-fork error; effect() in a skill body is the effect-in-skill error (effect() is a SUBAGENT primitive — a skill has no call→return region to scope; it declares a purity floor + context:fork instead)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve, dirname, basename } from "node:path";

import { sha256short, assertNever } from "./hash.js";
import { findIntegrityHeader, placeIntegrityHeader } from "./integrity.js";
import { fencedLineFlags } from "./markdown.js";
import { fileDefinesSymbol, langForFile } from "./symbols.js";
import { foldLegacyPostcondition } from "./skill-normalize.js";

import type {
  ClaudeSpec,
  SkillSpec,
  AgentSpec,
  SkillInput,
  SkillStep,
  Gate,
  Rule,
  InstructionFragment,
  OutputContract,
  OutputFieldType,
  Railway,
  RailwayStep,
  AuthoredPurity,
} from "./spec.js";

import { checkLinterRule, extractLinterName } from "./linters.js";
import {
  verifyToolContract,
  disallowedToolIssues,
  authoringIssues,
} from "./tool-contract.js";
import { purityViolations } from "./effects.js";
import type { LinterCheckResult } from "./linters.js";
import type { HarnessDialect, SkillFrontmatterProfile } from "./dialect.js";

// vigiles's default compile target when a spec names none and no dialect is
// injected — a product convention (vigiles emits CLAUDE.md by default), not a
// harness dialect. When a dialect IS injected its instructionTargets win.
const DEFAULT_TARGET = "CLAUDE.md";

// ---------------------------------------------------------------------------
// Hash utilities
// ---------------------------------------------------------------------------

// The header's position and format now live in ONE place — `./integrity.js`. The local
// `HASH_RE` that used to sit here was one of four independent copies of "the header is the first
// line", and that duplication is what let the placement invariant drift unnoticed (see the block
// comment on FRONTMATTER_RE in integrity.ts).

/** @internal Compute SHA-256 hash of content (excluding any existing hash line). */
export function computeHash(content: string): string {
  return sha256short(findIntegrityHeader(content)?.withoutHeader ?? content);
}

/** @internal Prepend a hash comment to compiled content. */
/**
 * A compiled body that carries a valid integrity stamp — mintable ONLY by
 * {@link addHash}, and by construction only handed out for a CLEAN compile.
 *
 * 🔴 WHY A BRAND AND NOT A CHECK AT THE WRITE SITE. #173 was a `CLAUDE.md`
 * written while its refs were known-dead: `compile` printed the errors, exited
 * 1, and wrote the file anyway, stamped. `lint` then verified the stamp and
 * exited 0 over an artifact that names files which do not exist. The fix that
 * shipped moved the write behind an error check in ONE compiler — and the same
 * three lines sat unchanged in four siblings (skill, subagent, railway,
 * generator), where the lint-side backstop does not even reach because
 * `spec-refs` only inspects `claude` specs. Reproduced end to end after that
 * fix: a skill spec with a stale ref still produced a stamped `SKILL.md` and a
 * green `lint`.
 *
 * Fixing five write sites leaves the class writable — the sixth compiler would
 * be written the same way. Branding the STAMP moves the guarantee to where it is
 * produced: `writeArtifact` accepts nothing else, and an erroring compile has no
 * stamp to give it.
 */
export type StampedMarkdown = string & { readonly __stamped: unique symbol };

export function addHash(content: string, specFile: string): StampedMarkdown {
  // 🔴 THE LAST GATE BEFORE A COMPILED FILE IS WRITTEN. Every compile path returns through here
  // (four call sites), which makes it the one place a whole class of defect can be stopped.
  //
  // `[object Object]` in output means a spec passed an object where the API takes a string, and
  // JS stringified it instead of complaining — types cannot stop this for a user's spec, because
  // `vigiles compile` runs `.spec.ts` through tsx: transpiled, types erased, never checked.
  // Observed 2026-08-17 from `input({ name, description })`, which shipped
  // `argument-hint: <[object Object]>` into a SKILL.md with no error anywhere.
  //
  // Hard error, not a warning: the string never appears legitimately (measured — zero
  // occurrences across every `.md` in this repository), and a file carrying it is broken in a
  // way its author cannot see by reading the spec.
  if (content.includes("[object Object]")) {
    throw new Error(
      `Compiled output for ${specFile} contains "[object Object]" — a spec value was an object ` +
        `where a string was expected, and JavaScript stringified it. Check the arguments to ` +
        `input()/file()/cmd() and friends: they take strings, not option objects.`,
    );
  }
  // The ONE mint. Every stamped artifact in the codebase originates here, which
  // is what makes the brand meaningful rather than decorative.
  return placeIntegrityHeader(
    content,
    computeHash(content),
    specFile,
  ) as StampedMarkdown;
}

/**
 * How every compiler finishes: the rendered body, plus a STAMPED artifact that
 * exists only when the compile is clean.
 *
 * `markdown` stays a plain string because callers legitimately want the draft
 * even when it is wrong — `adoptDiff` diffs "what the spec WOULD produce"
 * against the file on disk, and a stale ref must not stop that. `artifact` is
 * what a writer needs, and it is `null` the moment there is an error, so the
 * write cannot happen without narrowing.
 */
export function seal(
  body: string,
  errors: readonly CompileError[],
  specFile: string,
): { markdown: string; artifact: StampedMarkdown | null } {
  const stamped = addHash(body, specFile);
  return { markdown: stamped, artifact: errors.length === 0 ? stamped : null };
}

/** @internal Check if a file's hash matches its content. Returns null if no hash found. */
export function verifyHash(
  content: string,
): { valid: boolean; specFile: string } | null {
  const found = findIntegrityHeader(content);
  if (!found) return null;
  const actualHash = sha256short(found.withoutHeader);
  return { valid: actualHash === found.hash, specFile: found.specFile };
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
    | "spec-name-mismatch"
    | "unknown-tool"
    | "invalid-railway"
    | "purity-violation"
    | "output-without-fork"
    | "effect-in-skill"
    | "inline-code-too-long";
  message: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Reference validation
// ---------------------------------------------------------------------------

export function validateFileRef(
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

export function validateCommandRef(
  command: string,
  basePath: string,
): CompileError | null {
  const npmRunMatch = command.match(/^npm\s+run\s+(\S+)/);
  const npmMatch = command.match(/^npm\s+(test|start|build|pretest)\b/);
  const scriptName = npmRunMatch?.[1] ?? npmMatch?.[1];
  if (scriptName) {
    const scripts = readPackageScripts(basePath);
    if (scripts && !scripts[scriptName]) {
      return {
        type: "stale-command",
        message: `Script "${scriptName}" not found in package.json`,
        path: command,
      };
    }
    return null;
  }

  // Script-runner commands (python/node/bash/ruby/…): verify the referenced
  // script file exists. Module forms (`python -m pkg`) are skipped — no path.
  const scriptFile = command.match(
    /^(?:python3?|node|bash|sh|ruby|deno run)\s+([^\s-]\S*\.[A-Za-z0-9]+)/,
  )?.[1];
  if (scriptFile && !existsSync(resolve(basePath, scriptFile))) {
    return {
      type: "stale-command",
      message: `Script "${scriptFile}" not found`,
      path: command,
    };
  }
  return null;
}

export function validateSymbolRef(
  file: string,
  name: string,
  basePath: string,
): CompileError | null {
  const full = resolve(basePath, file);
  if (!existsSync(full)) {
    return {
      type: "stale-file",
      message: `File not found: "${file}"`,
      path: file,
    };
  }
  if (langForFile(file) === null) {
    return {
      type: "stale-ref",
      message: `Unsupported language for symbol check: "${file}"`,
      path: file,
    };
  }
  if (!fileDefinesSymbol(full, name)) {
    return {
      type: "stale-ref",
      message: `"${name}" is not defined in ${file}`,
      path: `${file}#${name}`,
    };
  }
  return null;
}

export function validateDirRef(
  dirPath: string,
  basePath: string,
): CompileError | null {
  const resolved = resolve(basePath, dirPath);
  if (!existsSync(resolved)) {
    return {
      type: "stale-file",
      message: `Directory not found: "${dirPath}"`,
      path: dirPath,
    };
  }
  if (!statSync(resolved).isDirectory()) {
    return {
      type: "stale-ref",
      message: `Not a directory: "${dirPath}"`,
      path: dirPath,
    };
  }
  return null;
}

export function validateGlobRef(
  pattern: string,
  basePath: string,
): CompileError | null {
  // ≥1 match = the pattern resolves to something real. `dot` so a dotfile path
  // (e.g. `.claude/**`) isn't silently a no-match.
  const matches = globSync(pattern, { cwd: basePath, dot: true });
  if (matches.length === 0) {
    return {
      type: "stale-ref",
      message: `Glob matched no files: "${pattern}"`,
      path: pattern,
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
    if (typeof fragment !== "string") {
      errors.push(...validateOneRef(fragment, basePath));
    }
  }
  return errors;
}

const wrap = (e: CompileError | null): CompileError[] => (e ? [e] : []);

/** Validate a single non-string fragment (a `Ref` or `EffectRegion`). */
function validateOneRef(
  r: Exclude<InstructionFragment, string>,
  basePath: string,
): CompileError[] {
  switch (r._ref) {
    case "file":
      return wrap(validateFileRef(r.path, basePath));
    case "cmd":
      return wrap(validateCommandRef(r.command, basePath));
    case "skill":
      return validateFileRef(r.path, basePath)
        ? [
            {
              type: "stale-ref",
              message: `Skill not found: "${r.path}"`,
              path: r.path,
            },
          ]
        : [];
    case "symbol":
      return wrap(validateSymbolRef(r.file, r.symbol, basePath));
    case "dir":
      return wrap(validateDirRef(r.path, basePath));
    case "glob":
      return wrap(validateGlobRef(r.pattern, basePath));
    case "effect":
      return validateRefs(r.body, basePath);
  }
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
    case "symbol":
      return `\`vigiles:symbol ${fragment.file}#${fragment.symbol}\``;
    case "dir":
      return `\`${fragment.path}\``;
    case "glob":
      return `\`${fragment.pattern}\``;
    case "effect": {
      const inner = fragment.body.map(renderFragment).join("").trim();
      return `\n<!-- vigiles:effect -->\n\n${inner}\n\n<!-- /vigiles:effect -->\n`;
    }
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
  /** Injected harness dialect; its instructionTargets[0] is the default target. */
  dialect?: HarnessDialect;
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

// A generous default cap on a single named prose section. TypeScript types
// cannot bound a string's length (template-literal-type recursion caps out ~463
// chars; TS #52243 unresolved), so a helper's content is guarded at COMPILE time
// instead — the ESLint-max-len / Prettier-printWidth precedent. Deliberately
// generous (don't-cry-wolf): real prose sections are short, so this only trips on
// an egregious dump (a whole essay pasted into one section / prose``).
// Override per spec with `maxSectionLines`; `maxTokens` is the global backstop.
const DEFAULT_MAX_SECTION_LINES = 200;

// A key-files entry is a POINTER, not an essay: the prose about why a file is
// shaped the way it is belongs in that file's own header, where it is read when
// the file is opened. Calibrated against this repo on 2026-09-08 — 285 entries,
// median 371 chars, longest 4782 — so 800 names the paragraphs without firing
// on an ordinary one-line description.
const DEFAULT_MAX_KEYFILE_CHARS = 800;

function validateSectionContent(
  name: string,
  text: string,
  maxSectionLines?: number,
): CompileError[] {
  const errors: CompileError[] = [];
  const contentLines = text.split("\n");

  // Reject markdown headers inside sections — sections compile to ## headings,
  // so raw # headers break document structure and signal pasted-in content.
  // Skip lines inside fenced code blocks (via the shared fence oracle).
  const fenced = fencedLineFlags(text);
  for (let i = 0; i < contentLines.length; i++) {
    if (fenced[i]) continue;
    if (/^ {0,3}#{1,2}\s/.test(contentLines[i])) {
      errors.push({
        type: "section-has-header",
        message: `Section "${name}" contains a markdown header ("${contentLines[i].trim().slice(0, 60)}"). Break into separate named sections instead.`,
      });
      break;
    }
  }

  const max = maxSectionLines ?? DEFAULT_MAX_SECTION_LINES;
  if (contentLines.length > max) {
    errors.push({
      type: "section-too-long",
      message: `Section "${name}" is ${String(contentLines.length)} lines (max ${String(max)}). Split into smaller named sections, move detail into a file() reference, or raise maxSectionLines if it's intentional.`,
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
    if (desc.length > DEFAULT_MAX_KEYFILE_CHARS) {
      errors.push({
        type: "section-too-long",
        message: `Key file "${filePath}" has a ${String(desc.length)}-character description (max ${String(DEFAULT_MAX_KEYFILE_CHARS)}). A key-files entry is a pointer; move the reasoning into that file's own header comment, where a reader meets it on opening the file.`,
      });
    }
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
// The instruction-file renderer is format-neutral: it emits plain markdown (h1
// from the dialect's instructionTargets, prose/Key-Files/Commands/Rules sections,
// and the trailing integrity-hash comment). That is exactly the AGENTS.md shape
// (no frontmatter), so Codex/OpenCode reuse it unchanged — only the h1 target
// differs, which already comes from the injected dialect. Nothing here is
// CC-only, so there is no per-dialect branch to gate.
export function compileClaude(
  spec: ClaudeSpec,
  options: CompileClaudeOptions = {},
): CompileClaudeResult {
  const targets =
    spec.target ?? options.dialect?.instructionTargets[0] ?? DEFAULT_TARGET;
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

/** Derive the `argument-hint` frontmatter value from typed inputs. */
function renderArgumentHint(inputs: readonly SkillInput[]): string {
  return inputs
    .map((i) => (i.required === false ? `[<${i.name}>]` : `<${i.name}>`))
    .join(" ");
}

/** Render the `## Arguments` section from typed inputs. */
function renderArguments(inputs: readonly SkillInput[]): string {
  const lines = ["## Arguments", ""];
  inputs.forEach((i, idx) => {
    const opt = i.required === false ? " _(optional)_" : "";
    lines.push(`- \`$${String(idx + 1)}\` **${i.name}**${opt} — ${i.hint}`);
  });
  return lines.join("\n");
}

/** The human prose + machine-readable marker for a gate. */
function renderGate(
  gate: Gate,
  retry?: number,
): { prose: string; marker: string } {
  if (gate._ref === "cmd") {
    const r = retry && retry > 1 ? ` retry:${String(retry)}` : "";
    const proseR = retry && retry > 1 ? ` (retry up to ${String(retry)}×)` : "";
    return {
      prose: `**Gate** — run \`${gate.command}\`${proseR}; do not proceed until it passes.`,
      marker: `<!-- vigiles:gate "${gate.command}"${r} -->`,
    };
  }
  if (gate._ref === "role") {
    const proseR = retry && retry > 1 ? ` (retry up to ${String(retry)}×)` : "";
    const r = retry && retry > 1 ? ` retry:${String(retry)}` : "";
    return {
      prose: `**Gate** — run the project's ${gate.role} command${proseR}; do not proceed until it passes.`,
      marker: `<!-- vigiles:gate role:${gate.role}${r} -->`,
    };
  }
  return {
    prose: `**Gate** — \`${gate.path}\` must exist before proceeding.`,
    marker: `<!-- vigiles:gate file:${gate.path} -->`,
  };
}

/** Render the `## Steps` checklist with a gate per step. */
function renderSteps(steps: readonly SkillStep[]): string {
  const out = ["## Steps", ""];
  steps.forEach((s, idx) => {
    out.push(`### Step ${String(idx + 1)}`, "");
    out.push(renderBody(s.do).trim(), "");
    if (s.gate) {
      const g = renderGate(s.gate, s.retry);
      out.push(g.prose, "", g.marker, "");
    }
  });
  return out.join("\n").trimEnd();
}

/** Render the `## Result` postcondition gate. */
function renderResult(result: Gate): string {
  let target: string;
  let marker: string;
  if (result._ref === "cmd") {
    target = `\`${result.command}\` passes`;
    marker = `<!-- vigiles:result "${result.command}" -->`;
  } else if (result._ref === "role") {
    target = `the project's ${result.role} command passes`;
    marker = `<!-- vigiles:result role:${result.role} -->`;
  } else {
    target = `\`${result.path}\` exists`;
    marker = `<!-- vigiles:result file:${result.path} -->`;
  }
  return [
    "## Result",
    "",
    `This skill is complete when ${target}.`,
    "",
    marker,
  ].join("\n");
}

/** Gather every reference a skill carries that needs author-time verification. */
function collectSkillRefs(spec: SkillSpec): InstructionFragment[] {
  const refs: InstructionFragment[] = [];
  if (Array.isArray(spec.body)) refs.push(...spec.body);
  for (const s of spec.steps ?? []) {
    if (Array.isArray(s.do)) refs.push(...s.do);
    // Role gates resolve per host project at run time — nothing to verify here.
    if (s.gate && s.gate._ref !== "role") refs.push(s.gate);
  }
  if (spec.postcondition && spec.postcondition._ref !== "role")
    refs.push(spec.postcondition);
  return refs;
}

/**
 * Build the SKILL.md YAML frontmatter block under the harness's frontmatter
 * profile. The `"minimal"` profile (Codex/OpenCode) emits ONLY name +
 * description; `"claude-code"` adds the CC-only keys (disable-model-invocation,
 * argument-hint, tools). Default is `"claude-code"` so callers that pass no
 * dialect get byte-identical output to before.
 */
/**
 * A frontmatter scalar, quoted only when leaving it bare would not survive YAML.
 *
 * 🔴 WHY THIS EXISTS. `description: ${spec.description}` interpolated the value
 * raw, so a description containing a colon-space — `"…измеряет, где замер врёт:
 * неаналоги в выборке"` — emitted frontmatter that is not valid YAML. Measured
 * 2026-08-19 on two real skills: right after `vigiles compile`, `skillContract()`
 * reported `malformed: true` and `declared: []`. The file LOOKS like it declares
 * `allowed-tools`; a strict parser reads nothing, so the skill silently inherits
 * every tool the session grants.
 *
 * That is the exact defect `frontmatter-valid` exists to report — i.e. the
 * blessed path produced the thing the product hunts for. Worse, it PUNISHED the
 * fix: a human who quoted the value by hand got a hash mismatch on the next lint
 * ("manually edited after compilation"), and recompiling silently reverted them.
 *
 * The test is a ROUND TRIP rather than a list of dangerous characters: emit it,
 * read it back with the same loader the linter uses, and quote only if what comes
 * back is not the string that went in. Consequences of that choice:
 *   - a value that was already safe is emitted byte-identically, so no existing
 *     compiled file churns and no integrity hash moves;
 *   - the set of "dangerous" inputs never has to be enumerated or maintained —
 *     YAML itself decides, so `#`, `[`, `&`, `*`, leading/trailing space, `yes`,
 *     `null` and everything else are covered without being listed.
 */
function yamlScalar(value: string): string {
  try {
    const parsed = yaml.load(`v: ${value}`);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).v === value
    ) {
      return value;
    }
  } catch {
    // Did not parse at all — definitively needs quoting.
  }
  // A JSON string IS a YAML double-quoted scalar, escaping included.
  return JSON.stringify(value);
}

function renderSkillFrontmatter(
  spec: SkillSpec,
  profile: SkillFrontmatterProfile = "claude-code",
): string {
  const fm = [
    "---",
    `name: ${yamlScalar(spec.name)}`,
    `description: ${yamlScalar(spec.description)}`,
  ];
  // The CC-only keys below are inert in a minimal (Codex/OpenCode) SKILL.md, so
  // they're omitted entirely under that profile.
  if (profile === "claude-code") {
    if (spec.disableModelInvocation !== undefined) {
      fm.push(
        `disable-model-invocation: ${String(spec.disableModelInvocation)}`,
      );
    }
    if (spec.context !== undefined) fm.push(`context: ${spec.context}`);
    const argHint =
      spec.inputs && spec.inputs.length > 0
        ? renderArgumentHint(spec.inputs)
        : spec.argumentHint;
    if (argHint) fm.push(`argument-hint: ${yamlScalar(argHint)}`);
    if (spec.tools && spec.tools.length > 0) {
      // A Claude Code SKILL declares its tool contract under `allowed-tools`
      // (NOT `tools:` — that's the SUBAGENT key), as a real YAML sequence. Flow
      // style keeps it one line while parsing as a list, not a single comma
      // scalar. Previously this emitted `tools: a, b` — the wrong key AND an
      // ambiguous scalar, so the restriction was lost on the CC round-trip. (#107)
      fm.push(`allowed-tools: [${spec.tools.join(", ")}]`);
    }
    if (spec.disallowedTools && spec.disallowedTools.length > 0) {
      // 🔴 `disallowed-tools`, HYPHENATED — that is a skill's fence. A subagent's
      // key is `disallowedTools:` (camelCase) and a different reader parses it, so
      // writing the agent spelling here emits a key nothing looks at: inert, and
      // inert in the direction that reads as protection. Same class as the #107
      // defect two lines up, where `tools:` on a skill silently lost the contract.
      fm.push(`disallowed-tools: [${spec.disallowedTools.join(", ")}]`);
    }
  }
  fm.push("---");
  return fm.join("\n");
}

/**
 * Compose the body: Arguments, then the knowledge body (reference prose), then
 * the gated Steps, then the Result. body + steps compose — a skill can carry
 * both a rich reference body and a verified procedure.
 */
function renderSkillSections(spec: SkillSpec): string {
  const sections: string[] = [];
  if (spec.inputs && spec.inputs.length > 0) {
    sections.push(renderArguments(spec.inputs));
  }
  if (spec.body !== undefined) sections.push(renderBody(spec.body).trim());
  if (spec.steps && spec.steps.length > 0) {
    sections.push(renderSteps(spec.steps));
  }
  if (spec.postcondition) sections.push(renderResult(spec.postcondition));
  // A forked skill (context: fork) runs as a subagent, so it may carry the SAME
  // typed Result outcome — reuse the subagent renderer (one-renderer-no-drift).
  if (spec.output) sections.push(renderOutputContract(spec.output));
  return sections.join("\n\n");
}

const DEFAULT_MAX_INLINE_CODE_LINES = 20;

/**
 * Flag inline fenced code blocks longer than `max` lines (0 = disabled). These
 * are WARNINGS, not errors: a big inline code block is an authoring smell worth
 * surfacing ("extract it to a file"), but it never breaks the harness — and a
 * faithful adoption of an existing skill/subagent (`init`) must still compile.
 * Callers route the result into a result's `warnings` channel, never `errors`.
 */
function checkInlineCode(markdown: string, max: number): CompileError[] {
  if (max <= 0) return [];
  const warns: CompileError[] = [];
  const lines = markdown.split("\n");
  let start = -1;
  let lang = "";
  for (let i = 0; i < lines.length; i++) {
    const m = /^```(\w*)/.exec(lines[i].trim());
    if (!m) continue;
    if (start === -1) {
      start = i;
      lang = m[1];
    } else {
      const len = i - start - 1;
      if (len > max) {
        warns.push({
          type: "inline-code-too-long",
          message: `Inline ${lang || "code"} block is ${String(len)} lines (max ${String(max)}); consider extracting it to a file and referencing it with file().`,
        });
      }
      start = -1;
      lang = "";
    }
  }
  return warns;
}

export interface CompileSkillResult {
  /**
   * The stamped artifact — present ONLY when `errors` is empty. `null` is what
   * makes a failed compile unwritable: `writeArtifact` accepts nothing else.
   */
  artifact: StampedMarkdown | null;
  markdown: string;
  errors: CompileError[];
  /** Non-blocking advisories (e.g. an over-long inline code block). */
  warnings: CompileError[];
}

/**
 * Compile a SkillSpec into SKILL.md markdown with YAML frontmatter.
 */
export function compileSkill(
  spec: SkillSpec,
  options: {
    basePath?: string;
    specFile?: string;
    /** The harness dialect — selects the SKILL.md frontmatter profile. Omitting
     *  it defaults to the Claude Code profile, so existing callers are unchanged. */
    dialect?: HarnessDialect;
  } = {},
): CompileSkillResult {
  // 🔴 NORMALISE FIRST, before anything reads the spec. `compileSkill` accepts a
  // `SkillSpec` STRUCTURALLY, so a caller can hand us `{ _specType: "skill", …,
  // result: cmd(…) }` without ever touching `experimental_skill()`. Both readers
  // below (`collectSkillRefs`, `renderSkillSections`) look only at
  // `postcondition`, so without this line such a spec loses its `## Result`
  // section AND its reference verification, silently. Doing it here rather than
  // in the readers means a reader added later cannot reintroduce the gap.
  spec = foldLegacyPostcondition(spec);
  const basePath = options.basePath ?? process.cwd();
  const specFile = options.specFile ?? "SKILL.md.spec.ts";
  const profile: SkillFrontmatterProfile =
    options.dialect?.skillFrontmatter ?? "claude-code";
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

  errors.push(...validateRefs(collectSkillRefs(spec), basePath));

  // A typed `output` Result contract is valid ONLY for a forked skill: an inline
  // skill has no call→return boundary, so a typed outcome there is a category
  // error (see research/spec-syntax-and-railway-scope.md). Enforce it at compile.
  if (spec.output && spec.context !== "fork") {
    errors.push({
      type: "output-without-fork",
      message:
        'A skill `output` (result() contract) requires `context: "fork"` — an ' +
        "inline skill has no return value to type. Add context:'fork' to run it " +
        "as a subagent, or drop `output`.",
    });
  }

  // effect() is a SUBAGENT primitive. A deterministic effect REGION needs a
  // structural call→return bracket to scope it; a default skill is spliced into
  // the main conversation and has none (the dogfood that proved the model-emitted
  // boundary is fragile — research/effect-boundary-design.md). A skill bounds its
  // effects with a `purity` floor and promotes to `context:'fork'` (a subagent)
  // when it must mutate.
  if (
    collectSkillRefs(spec).some(
      (f) => typeof f !== "string" && f._ref === "effect",
    )
  ) {
    errors.push({
      type: "effect-in-skill",
      message:
        "effect() is a subagent primitive — a skill has no call→return boundary to " +
        "scope an effect region. Declare a `purity` floor on the skill and use " +
        "context:'fork' to run it as a subagent when it must mutate.",
    });
  }

  // purity floor check — the dialect is optional (callers that don't pass one
  // skip the check rather than crash; the CLI always passes it). An absent
  // tools list inherits ALL tools, so it's checked as the "*" wildcard (a
  // violation at the pure/bounded floors), never as the empty set.
  if (
    spec.purity &&
    spec.purity !== "dangerously-unrestricted" &&
    options.dialect
  ) {
    for (const v of purityViolations(
      spec.tools ?? ["*"],
      options.dialect,
      spec.purity,
    )) {
      errors.push({ type: "purity-violation", message: v.message });
    }
  }

  // A fence entry that is a close typo of a real tool blocks NOTHING while reading
  // as protection — the same high-precision check a subagent's `disallowedTools`
  // gets. Skipped without a dialect, like the purity check above, because the tool
  // catalog is what a typo is measured against.
  if (spec.disallowedTools && options.dialect) {
    for (const issue of disallowedToolIssues(
      spec.disallowedTools,
      options.dialect,
    )) {
      errors.push({ type: "unknown-tool", message: issue.message });
    }
  }

  const sections = renderSkillSections(spec);
  // Over-long inline code blocks are WARNINGS, not errors — they don't block
  // compilation (so adoption always compiles), just nudge toward file().
  const warnings = checkInlineCode(
    sections,
    spec.maxInlineCodeLines ?? DEFAULT_MAX_INLINE_CODE_LINES,
  );

  const marker = purityMarker(spec.purity);
  const content =
    renderSkillFrontmatter(spec, profile) +
    // ONE newline, not two: `placeIntegrityHeader` puts the stamp AFTER the
    // frontmatter and supplies its own blank line on each side, so a second one
    // here becomes two blank lines in the artifact — which `prettier --check`
    // rejects, and a freshly compiled artifact then cannot pass `npm run check`.
    // Fixed HERE rather than in the stamper: the hash is computed over this
    // content (compile.ts `seal`), so trimming inside `placeIntegrityHeader`
    // would hash one string and write another — measured, it broke integrity on
    // all three frontmatter-bearing artifacts.
    "\n" +
    (marker ? marker + "\n\n" : "") +
    sections.trim() +
    "\n";
  return { ...seal(content, errors, specFile), errors, warnings };
}

// ---------------------------------------------------------------------------
// Compile a subagent spec → agents/<name>.md
// ---------------------------------------------------------------------------

// The subagent tool catalog (built-in / never-available / MCP shape) is the
// harness's format-axis vocabulary — it lives in the HarnessDialect port
// (src/core/dialect.ts), injected here, never hard-coded for one harness.
//
// SCOPE: compileAgent renders vigiles's experimental_agent() — a VERIFIED TOOL CONTRACT — to
// a Claude-Code-shaped subagent markdown file. Compiling that to Codex is a
// deliberate NON-GOAL, not a missing renderer: a Codex "subagent" is an
// [agents.<name>] TOML concurrency table (max_threads / max_depth), which is a
// runtime-orchestration knob, NOT a tool contract. The two models don't map, so
// vigiles does not emit a TOML [agents] block. The Codex dialect still verifies
// an experimental_agent()'s tool contract (its built-in catalog) — only the OUTPUT renderer
// is CC-only here. See research/codex-prototype-findings.md (gaps).

/** Verify a subagent's allowed-tools contract — the rails are real tools. The
 * detection lives in the shared `verifyToolContract` detector (one-detector-no-
 * drift: compile + scan + the subagent-tool-contract lint rule call the same code). */
function validateAgentTools(
  tools: readonly string[],
  dialect: HarnessDialect,
): CompileError[] {
  // `authoringIssues` drops the `conditional` verdicts: `Agent`, `ExitPlanMode`
  // and the foreground-only built-ins are REAL tools, legitimate to declare, and
  // erroring on them is what made `tools: Agent, Read, Bash` — a worked example
  // in the vendor's own docs — fail to compile. Everything else stays an error,
  // because authoring your own spec is a closed world.
  return authoringIssues(verifyToolContract(tools, dialect)).map((issue) => ({
    type: "unknown-tool",
    message: issue.message,
  }));
}

/** Build the subagent YAML frontmatter (name / description / model / tools). */
function renderAgentFrontmatter(spec: AgentSpec): string {
  // Same round-trip quoting as the skill renderer — a subagent description is
  // written just as freely and breaks its frontmatter the same way. See
  // {@link yamlScalar}.
  const fm = [
    "---",
    `name: ${yamlScalar(spec.name)}`,
    `description: ${yamlScalar(spec.description)}`,
  ];
  if (spec.model !== undefined) fm.push(`model: ${spec.model}`);
  if (spec.color !== undefined) fm.push(`color: ${spec.color}`);
  if (spec.tools && spec.tools.length > 0) {
    fm.push(`tools: ${spec.tools.join(", ")}`);
  }
  if (spec.disallowedTools && spec.disallowedTools.length > 0) {
    fm.push(`disallowedTools: ${spec.disallowedTools.join(", ")}`);
  }
  fm.push("---");
  return fm.join("\n");
}

/**
 * The `<!-- vigiles:purity:LEVEL -->` marker the runtime PreToolUse gate reads to
 * enforce a unit's declared purity floor against live tool calls (see
 * `decidePurityGate` / `parseAgentPurity`). Returns "" when no purity is
 * declared. The loud authoring word `dangerously-unrestricted` maps to the
 * neutral report/runtime level `unrestricted` (no constraint to enforce).
 */
function purityMarker(purity: AuthoredPurity | undefined): string {
  if (!purity) return "";
  const level = purity === "dangerously-unrestricted" ? "unrestricted" : purity;
  return `<!-- vigiles:purity:${level} -->`;
}

/** Render the subagent's named `##` system-prompt sections (verified like CLAUDE.md). */
function renderAgentSections(
  sections: Record<string, string | InstructionFragment[]>,
  basePath: string,
): SectionResult {
  const lines: string[] = [];
  const errors: CompileError[] = [];
  for (const [name, content] of Object.entries(sections)) {
    if (name.toLowerCase() === "rules") {
      errors.push({
        type: "reserved-section-key",
        message: `Section key "${name}" is reserved — use the \`rules\` field instead.`,
      });
    }
    const heading = name.charAt(0).toUpperCase() + name.slice(1);
    if (typeof content === "string") {
      errors.push(...validateSectionContent(name, content));
      lines.push(`## ${heading}\n\n${content.trim()}`);
    } else {
      errors.push(...validateRefs(content, basePath));
      const rendered = content.map(renderFragment).join("");
      errors.push(...validateSectionContent(name, rendered));
      lines.push(`## ${heading}\n\n${rendered.trim()}`);
    }
  }
  return { lines, errors };
}

/** Render a result-contract track shape as a compact `{ "f": type, … }` line. */
function renderShape(shape: Readonly<Record<string, OutputFieldType>>): string {
  const fields = Object.entries(shape)
    // An enum renders as the choice itself — `"verdict": "CUT" | "MERGE" | "KEEP"` — so
    // the fenced rail shows a worker the same permitted values the tool schema shows.
    .map(
      ([k, t]) =>
        `"${k}": ${typeof t === "string" ? t : t.map((v) => JSON.stringify(v)).join(" | ")}`,
    )
    .join(", ");
  return fields ? `{ ${fields} }` : "{}";
}

/**
 * Render the subagent's typed result contract — the `## Output contract` section
 * that turns a flat worker into a railway step: it must end its turn with a
 * `vigiles:ok` / `vigiles:err` block matching one of these shapes, so its
 * outcome is parseable (`parseAgentResult`) and testable (`assertAgentOk`).
 */
function renderOutputContract(contract: OutputContract): string {
  return [
    "## Output contract",
    "",
    "Finish your turn with exactly one fenced block — success or error — matching one of these shapes.",
    "",
    "On success:",
    "",
    "```vigiles:ok",
    renderShape(contract.ok),
    "```",
    "",
    "On error:",
    "",
    "```vigiles:err",
    renderShape(contract.err),
    "```",
  ].join("\n");
}

/** Render the rules a subagent must follow as a `## Rules` section. */
function renderAgentRules(rules: Record<string, Rule>): string {
  const parts = ["## Rules", ""];
  for (const [id, rule] of Object.entries(rules)) {
    parts.push(compileRule(id, rule), "");
  }
  return parts.join("\n").trim();
}

export interface CompileAgentResult {
  /**
   * The stamped artifact — present ONLY when `errors` is empty. `null` is what
   * makes a failed compile unwritable: `writeArtifact` accepts nothing else.
   */
  artifact: StampedMarkdown | null;
  markdown: string;
  errors: CompileError[];
  /** Non-blocking advisories (e.g. an over-long inline code block). */
  warnings: CompileError[];
}

/**
 * Compile an AgentSpec into a subagent markdown file with YAML frontmatter.
 * Verifies the tool contract and the body's references; the marks the body
 * carries (`vigiles:symbol`, file/cmd refs) are the same ones `lint` re-checks.
 */
export function compileAgent(
  spec: AgentSpec,
  options: {
    basePath?: string;
    specFile?: string;
    /** The harness dialect to verify the tool contract against (required — the
     *  core defines no default dialect; the adapter/composition root injects it). */
    dialect: HarnessDialect;
  },
): CompileAgentResult {
  const basePath = options.basePath ?? process.cwd();
  const specFile = options.specFile ?? "agent.md.spec.ts";
  const dialect = options.dialect;
  const errors: CompileError[] = [];

  if (!specFile.endsWith(".spec.ts")) {
    errors.push({
      type: "spec-name-mismatch",
      message: `Spec file "${specFile}" must end with .spec.ts`,
    });
  } else if (!/\.md$/i.test(basename(specFile, ".spec.ts"))) {
    errors.push({
      type: "spec-name-mismatch",
      message: `Spec file "${specFile}" should be named <output>.spec.ts (e.g., agents/reviewer.md.spec.ts)`,
    });
  }

  if (spec.tools) errors.push(...validateAgentTools(spec.tools, dialect));
  if (spec.disallowedTools) {
    // A disallowedTools entry that's a close typo of a real tool blocks NOTHING —
    // the same high-precision detector scan + the disallowed-tools-contract rule use.
    for (const issue of disallowedToolIssues(spec.disallowedTools, dialect)) {
      errors.push({ type: "unknown-tool", message: issue.message });
    }
  }
  if (spec.purity && spec.purity !== "dangerously-unrestricted") {
    // Enforce the declared purity floor against the tool contract. An absent
    // tools list inherits ALL tools, so it's checked as the "*" wildcard (a
    // violation at the pure/bounded floors), never as the empty set.
    for (const v of purityViolations(
      spec.tools ?? ["*"],
      dialect,
      spec.purity,
    )) {
      errors.push({ type: "purity-violation", message: v.message });
    }
  }
  if (Array.isArray(spec.body)) {
    errors.push(...validateRefs(spec.body, basePath));
  }

  const sections: string[] = [];
  if (spec.body !== undefined) sections.push(renderBody(spec.body).trim());
  if (spec.sections) {
    const result = renderAgentSections(spec.sections, basePath);
    sections.push(...result.lines);
    errors.push(...result.errors);
  }
  if (spec.rules && Object.keys(spec.rules).length > 0) {
    sections.push(renderAgentRules(spec.rules));
  }
  if (spec.output) sections.push(renderOutputContract(spec.output));
  const body = sections.join("\n\n");
  // Over-long inline code blocks are WARNINGS, not errors (see checkInlineCode).
  const warnings = checkInlineCode(body, DEFAULT_MAX_INLINE_CODE_LINES);

  const marker = purityMarker(spec.purity);
  const content =
    renderAgentFrontmatter(spec) +
    // ONE newline, not two: `placeIntegrityHeader` puts the stamp AFTER the
    // frontmatter and supplies its own blank line on each side, so a second one
    // here becomes two blank lines in the artifact — which `prettier --check`
    // rejects, and a freshly compiled artifact then cannot pass `npm run check`.
    // Fixed HERE rather than in the stamper: the hash is computed over this
    // content (compile.ts `seal`), so trimming inside `placeIntegrityHeader`
    // would hash one string and write another — measured, it broke integrity on
    // all three frontmatter-bearing artifacts.
    "\n" +
    (marker ? marker + "\n\n" : "") +
    body.trim() +
    "\n";
  return { ...seal(content, errors, specFile), errors, warnings };
}

// ---------------------------------------------------------------------------
// Compile a railway → an orchestrator command
//
// A railway composes flat subagents on a success/error track. It compiles to an
// orchestrator command the lead agent reads — NOT a runtime engine (vigiles
// verifies + emits; the agent executes; the per-step rails enforce). Every
// delegate target is resolved against the known agent set (stale-ref), the
// step list must be non-empty, and recovery must be bounded — the finite,
// sub-Turing guarantees that make the whole flow checkable.
// ---------------------------------------------------------------------------

export interface CompileRailwayOptions {
  /** Names of compiled agents, to resolve `delegate` targets. Skipped if omitted. */
  knownAgents?: readonly string[];
  specFile?: string;
}

export interface CompileRailwayResult {
  /**
   * The stamped artifact — present ONLY when `errors` is empty. `null` is what
   * makes a failed compile unwritable: `writeArtifact` accepts nothing else.
   */
  artifact: StampedMarkdown | null;
  markdown: string;
  errors: CompileError[];
}

/** Verify a railway: non-empty, bounded recovery, every delegate target real. */
export function validateRailway(
  rw: Railway,
  knownAgents?: readonly string[],
): CompileError[] {
  const errors: CompileError[] = [];
  if (rw.steps.length === 0) {
    errors.push({
      type: "invalid-railway",
      message: `Railway "${rw.name}" has no steps.`,
    });
  }
  if (rw.recover && rw.recover.max < 1) {
    errors.push({
      type: "invalid-railway",
      message: `Railway "${rw.name}" recover.max must be ≥ 1 (got ${String(rw.recover.max)}).`,
    });
  }
  if (knownAgents) {
    const known = new Set(knownAgents);
    const refs: RailwayStep[] = [...rw.steps];
    if (rw.onError) refs.push(rw.onError);
    if (rw.recover) refs.push(rw.recover.step);
    for (const s of refs) {
      if (!known.has(s.agent)) {
        errors.push({
          type: "stale-ref",
          message: `Railway "${rw.name}" delegates to unknown agent "${s.agent}".`,
          path: s.agent,
        });
      }
    }
  }
  return errors;
}

/** Render the orchestrator command markdown for a railway. */
function renderRailwayMarkdown(rw: Railway): string {
  const lines = [
    `# Railway: ${rw.name}`,
    "",
    "Dispatch these subagents on the **success track**, in order. Each returns a " +
      "result block (`vigiles:ok` / `vigiles:err`). If a step returns an error, " +
      "stop the success track and run the error handler with that error payload.",
    "",
    "## Success track",
    "",
  ];
  rw.steps.forEach((s, i) => {
    const task = s.task ? ` — ${s.task}` : "";
    lines.push(`${String(i + 1)}. **${s.agent}**${task}`);
  });
  if (rw.recover) {
    lines.push(
      "",
      "## Recovery",
      "",
      `If a step errors, retry it via **${rw.recover.step.agent}** up to ${String(rw.recover.max)}× before falling to the error track.`,
    );
  }
  if (rw.onError) {
    lines.push(
      "",
      "## On error",
      "",
      `Run **${rw.onError.agent}** with the failing step's error payload.`,
    );
  }
  return lines.join("\n");
}

/**
 * Compile a railway into an orchestrator command markdown (with integrity hash),
 * resolving every delegate target against `knownAgents` when provided.
 */
export function compileRailway(
  rw: Railway,
  options: CompileRailwayOptions = {},
): CompileRailwayResult {
  const errors = validateRailway(rw, options.knownAgents);
  const specFile = options.specFile ?? `${rw.name}.railway.spec.ts`;
  const content = renderRailwayMarkdown(rw) + "\n";
  return { ...seal(content, errors, specFile), errors };
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
  spec: ClaudeSpec | SkillSpec | AgentSpec,
  basePath: string,
  dialect: HarnessDialect,
): AdoptResult {
  const fullPath = resolve(basePath, filePath);
  const currentContent = existsSync(fullPath)
    ? readFileSync(fullPath, "utf-8")
    : "";

  const hashResult = verifyHash(currentContent);

  // Compile the spec to get what it WOULD produce
  let compiledContent: string | null = null;
  if (spec._specType === "claude") {
    const { markdown } = compileClaude(spec, {
      basePath,
      specFile: filePath,
      dialect,
    });
    compiledContent = markdown;
  } else if (spec._specType === "skill") {
    const { markdown } = compileSkill(spec, { basePath, specFile: filePath });
    compiledContent = markdown;
  } else if (spec._specType === "agent") {
    const { markdown } = compileAgent(spec, {
      basePath,
      specFile: filePath,
      dialect,
    });
    compiledContent = markdown;
  }

  // Simple line-based diff
  const currentLines = (
    findIntegrityHeader(currentContent)?.withoutHeader ?? currentContent
  ).split("\n");
  const compiledLines = (() => {
    const c = compiledContent ?? "";
    return (findIntegrityHeader(c)?.withoutHeader ?? c).split("\n");
  })();

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
