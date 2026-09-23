/**
 * vigiles — Validate vigiles-builder calls in markdown code blocks.
 *
 * Mirror of inline mode but inverted: inline mode skips fenced code blocks
 * (so `<!-- vigiles:enforce -->` in prose doesn't accidentally match an
 * example). This module enters fenced code blocks (ts/typescript/js/
 * javascript) and validates the vigiles builder calls inside —
 * `enforce("...")`, `file("...")`, `cmd("...")`, `ref("...")` — using the
 * same engines that validate them in spec.ts.
 *
 * Default: validate every ref. Illustrative blocks opt out via
 * `<!-- vigiles:ignore -->` immediately before the fence. Whole files
 * opt out via `<!-- vigiles:ignore-file -->` anywhere in the file
 * (intended for research/design docs that quote hypothetical refs).
 *
 * Scope: ONLY vigiles builder calls. Generic TS syntax / type checking
 * in markdown is explicitly out of scope — use eslint-plugin-markdown or
 * twoslash for that.
 */

import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { resolve } from "node:path";
import { globSync } from "glob";

import { withIgnored, type GlobIgnore } from "./glob-ignore.js";

import { checkLinterRule } from "./linters.js";
import { readPackageScripts } from "./compile.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocRefKind = "enforce" | "file" | "cmd" | "ref";

export interface DocRef {
  readonly file: string;
  readonly line: number;
  readonly kind: DocRefKind;
  readonly value: string;
}

export interface DocRefError extends DocRef {
  readonly message: string;
}

export interface DocRefReport {
  readonly filesScanned: number;
  readonly filesIgnored: number;
  readonly blocksIgnored: number;
  readonly refs: readonly DocRef[];
  readonly errors: readonly DocRefError[];
  /** Refs that couldn't be verified because the underlying tool isn't available in this env. */
  readonly unverified: number;
  /** Refs that contained placeholder syntax (e.g. <linter>/<rule>) and were skipped. */
  readonly placeholders: number;
}

export interface FindDocRefsOptions {
  readonly basePath?: string;
  /** The repo exclude (`ExcludeSet.globIgnore`), or patterns relative to `basePath`. */
  readonly ignore?: GlobIgnore;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE = [
  "node_modules/**",
  "dist/**",
  ".vigiles/**",
  ".git/**",
] as const;

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const TS_LANGS = new Set(["ts", "typescript", "js", "javascript"]);

// Ignore markers must appear as standalone lines (whole line is the
// comment, modulo whitespace) so an inline-code mention like
// `` `<!-- vigiles:ignore-file -->` `` in prose documenting the syntax
// doesn't accidentally disable validation.
const IGNORE_BLOCK_RE = /^\s{0,3}<!--\s*vigiles:ignore\s*-->\s*$/;
const IGNORE_FILE_RE = /^\s{0,3}<!--\s*vigiles:ignore-file\s*-->\s*$/m;

const KINDS = new Set(["enforce", "file", "cmd", "ref"]);

const PLACEHOLDER_RE = /[<>]/;

/**
 * Error-message patterns that mean "tool not available in this env" rather
 * than "ref is actually broken." We can't decide between valid and invalid
 * when the underlying linter or CLI isn't installed, so count these
 * separately from real errors.
 */
const UNVERIFIABLE_PATTERNS: readonly RegExp[] = [
  /Unknown linter:/i,
  /not found on PATH/i,
  /No Cedar policies found/i,
];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface ExtractResult {
  refs: DocRef[];
  blocksIgnored: number;
}

/**
 * The builder calls in one fenced block, found by PARSING it rather than by
 * matching text.
 *
 * 🔴 WHY THIS IS NOT A REGEX ANY MORE. The previous form was
 * `/\b(enforce|file|cmd|ref)\(\s*["']([^"'\n]+)["']/g`, and four of these six
 * inputs were classified wrongly (measured 2026-08-19):
 *
 *   ctx.file("OUT")          → matched, though it is a method on some other
 *                              object. A live instance of this sat in a real
 *                              repository's notes and was reported as a broken
 *                              ref for weeks.
 *   obj.cmd("npm test")      → matched, same reason
 *   // cmd("npm test")       → matched, though it is a comment
 *   const s = 'cmd("x")'     → matched, though it is a string
 *   myFile("x")              → correctly skipped
 *   cmd("npm test")          → correctly matched
 *
 * `\b` sits happily after a `.`, so every member call read as a builder call,
 * and a regex has no notion of comments or string literals at all. Parsing makes
 * all four INEXPRESSIBLE rather than individually patched: the AST only offers a
 * call whose callee is a bare identifier, and comments and string bodies are not
 * call expressions in the first place.
 *
 * `typescript` is already a runtime dependency of this package, so this costs no
 * new install — the parser was in the box the whole time.
 */
function callsIn(
  blockLines: readonly { lineNo: number; text: string }[],
  file: string,
): DocRef[] {
  if (blockLines.length === 0) return [];
  const src = blockLines.map((b) => b.text).join("\n");
  const firstLine = blockLines[0].lineNo;
  const sf = ts.createSourceFile(
    "block.ts",
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const out: DocRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const kind = node.expression.text;
      if (KINDS.has(kind)) {
        const arg = node.arguments[0];
        // Only a plain string literal is a ref we can resolve. A template with
        // substitutions, a variable, or a computed value is not something this
        // pass can check, and guessing at it is how false reports start.
        if (
          arg &&
          (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push({
            file,
            line: firstLine + line,
            kind: kind as DocRefKind,
            value: arg.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** @internal */ export function extractDocRefs(
  content: string,
  file: string,
): ExtractResult {
  const lines = content.split("\n");
  const refs: DocRef[] = [];
  let blocksIgnored = 0;

  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let fenceLang = "";
  let blockLines: { lineNo: number; text: string }[] = [];
  let nextBlockIgnored = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_RE.exec(line);

    if (fm) {
      const marker = fm[2];
      const ch = marker[0] as "`" | "~";
      const len = marker.length;
      const info = fm[3].trim();

      if (fenceChar === null) {
        fenceChar = ch;
        fenceLen = len;
        fenceLang = info.split(/\s+/)[0].toLowerCase();
        blockLines = [];
        continue;
      } else if (ch === fenceChar && len >= fenceLen && info === "") {
        // Closing fence
        if (TS_LANGS.has(fenceLang)) {
          if (nextBlockIgnored) {
            blocksIgnored++;
          } else {
            refs.push(...callsIn(blockLines, file));
          }
        }
        fenceChar = null;
        fenceLen = 0;
        fenceLang = "";
        nextBlockIgnored = false;
        blockLines = [];
        continue;
      }
    }

    if (fenceChar !== null) {
      blockLines.push({ lineNo: i + 1, text: line });
      continue;
    }

    if (IGNORE_BLOCK_RE.test(line)) {
      nextBlockIgnored = true;
    }
  }

  return { refs, blocksIgnored };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationOutcome {
  errors: DocRefError[];
  unverified: number;
  placeholders: number;
}

function isUnverifiable(message: string): boolean {
  return UNVERIFIABLE_PATTERNS.some((p) => p.test(message));
}

function validateRefs(
  refs: readonly DocRef[],
  basePath: string,
): ValidationOutcome {
  const errors: DocRefError[] = [];
  let unverified = 0;
  let placeholders = 0;
  const scripts = readPackageScripts(basePath) ?? {};

  for (const r of refs) {
    // Skip obvious placeholders like enforce("<linter>/<rule>") that
    // appear in skill format documentation. They aren't typos — they're
    // syntax templates. Real refs don't contain < or >.
    if (PLACEHOLDER_RE.test(r.value)) {
      placeholders++;
      continue;
    }

    switch (r.kind) {
      case "enforce": {
        const result = checkLinterRule(r.value, basePath, {
          catalogOnly: true,
        });
        if (!result.exists) {
          const msg = result.error ?? `Rule "${r.value}" not found`;
          if (isUnverifiable(msg)) {
            unverified++;
          } else {
            errors.push({ ...r, message: msg });
          }
        }
        break;
      }
      case "file":
      case "ref": {
        if (!existsSync(resolve(basePath, r.value))) {
          errors.push({ ...r, message: `File not found: "${r.value}"` });
        }
        break;
      }
      case "cmd": {
        const npmRun = r.value.match(/^npm\s+run\s+(\S+)/);
        const npmDirect = r.value.match(/^npm\s+(test|start|build|pretest)\b/);
        const scriptName = npmRun?.[1] ?? npmDirect?.[1];
        if (scriptName && !scripts[scriptName]) {
          errors.push({
            ...r,
            message: `Script "${scriptName}" not found in package.json`,
          });
        }
        break;
      }
    }
  }

  return { errors, unverified, placeholders };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk every `.md` under `basePath`, extract vigiles builder calls from
 * fenced TS/JS code blocks, validate against the same engines used for
 * spec.ts. Honors `<!-- vigiles:ignore-file -->` (skip the whole file)
 * and `<!-- vigiles:ignore -->` (skip the next code block).
 */
export function findDocRefs(options: FindDocRefsOptions = {}): DocRefReport {
  const basePath = options.basePath ?? process.cwd();
  const ignore = withIgnored(DEFAULT_IGNORE, options.ignore);
  const files = globSync("**/*.md", { cwd: basePath, ignore });

  const allRefs: DocRef[] = [];
  let filesIgnored = 0;
  let blocksIgnored = 0;

  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(resolve(basePath, f), "utf-8");
    } catch {
      continue;
    }
    if (IGNORE_FILE_RE.test(content)) {
      filesIgnored++;
      continue;
    }
    const r = extractDocRefs(content, f);
    allRefs.push(...r.refs);
    blocksIgnored += r.blocksIgnored;
  }

  const outcome = validateRefs(allRefs, basePath);

  return {
    filesScanned: files.length,
    filesIgnored,
    blocksIgnored,
    refs: allRefs,
    errors: outcome.errors,
    unverified: outcome.unverified,
    placeholders: outcome.placeholders,
  };
}

/** Format a DocRefReport as human-readable text. */
export function formatDocRefReport(
  report: DocRefReport,
  /**
   * The severity `doc-refs` is configured at. A `✗` next to an exit code of 0
   * reads as a gate that failed to gate, so the marker follows the severity the
   * user actually set rather than always claiming the hard tier.
   */
  severity: "error" | "warn" = "error",
): string {
  const lines: string[] = [];
  const meta: string[] = [];
  if (report.filesIgnored > 0)
    meta.push(`${String(report.filesIgnored)} via vigiles:ignore-file`);
  if (report.blocksIgnored > 0)
    meta.push(`${String(report.blocksIgnored)} blocks via vigiles:ignore`);
  if (report.placeholders > 0)
    meta.push(`${String(report.placeholders)} placeholders skipped`);
  if (report.unverified > 0)
    meta.push(`${String(report.unverified)} unverified (tool unavailable)`);
  const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";

  lines.push(`scanned ${String(report.filesScanned)} files${metaStr}`);
  lines.push(
    `${String(report.refs.length)} vigiles refs in code blocks${report.errors.length === 0 ? " — all valid" : ""}`,
  );

  if (report.errors.length === 0) return lines.join("\n");

  lines.push(
    `${severity === "error" ? "✗" : "ℹ"} ${String(report.errors.length)} broken ref(s):`,
  );
  for (const e of report.errors.slice(0, 12)) {
    const trunc =
      e.message.length > 80 ? `${e.message.slice(0, 80)}…` : e.message;
    lines.push(
      `    ${e.file}:${String(e.line)} ${e.kind}("${e.value}") — ${trunc}`,
    );
  }
  if (report.errors.length > 12) {
    lines.push(`    ... +${String(report.errors.length - 12)} more`);
  }
  return lines.join("\n");
}
