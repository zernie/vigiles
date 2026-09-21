/**
 * vigiles — file-qualified symbol reference verification (variant A).
 *
 * A reference names both the file and the symbol, as an inline code span:
 *
 *     See `src/config.ts#parseConfig` for the loader.
 *     Render with `app/models/user.rb#full_name`.
 *
 * We parse *that one named file* and check it defines the symbol. No
 * project-wide index, no cross-file resolution, no autoloader chasing, no
 * ambiguity (the file disambiguates). Because the `path.ext#symbol` shape is
 * unmistakable and deliberately written, it is a *declared* reference — like
 * `vigiles:file` / `vigiles:cmd` — so a broken one is an **error**, not an
 * inferred-prose warning. The author names the file; vigiles proves the symbol.
 *
 * R1 (cross-compat): only inline code spans are read. Fenced code blocks are
 * never touched, so rustdoc doctests / typescript-docs-verifier keep working.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { langForFile, fileDefinesSymbol } from "./symbols.js";
import { fencedLineFlags } from "./markdown.js";
import type { RuleSeverity } from "./types.js";

const SPAN = /`([^`\n]+)`/g;

/** An inline code span with its 1-based source line. */
export interface Span {
  readonly text: string;
  readonly line: number;
}

/**
 * Extract inline code spans, skipping fenced code blocks (R1). Returns each
 * span's trimmed text and 1-based line.
 */
export function inlineSpans(markdown: string): Span[] {
  const spans: Span[] = [];
  const lines = markdown.split("\n");
  const fenced = fencedLineFlags(markdown);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    for (const m of lines[i].matchAll(SPAN)) {
      spans.push({ text: m[1].trim(), line: i + 1 });
    }
  }
  return spans;
}

// A file-qualified symbol reference: `<path>.<ext>` then `#`/`::` then a symbol.
// Requires a real file extension before the separator, so a bare scoped symbol
// An explicit `vigiles:symbol <path>.<ext>#<symbol>` directive inside a code
// span. The literal `vigiles:symbol` prefix means zero detection heuristic — a
// span either carries it or it does not — consistent with the rest of vigiles'
// markers. The mark is self-contained (file + symbol in one inline token), so
// it binds unambiguously even in a long line with several references.
const SYMBOL_MARK =
  /^vigiles:symbol\s+([\w@./-]+\.[A-Za-z0-9]+)(?:#|::)([A-Za-z_]\w*[?!]?)$/;

/** A parsed file-qualified reference. */
export interface SymbolRef {
  readonly file: string;
  readonly symbol: string;
  readonly line: number;
}

/** A reference that failed verification. */
export interface SymbolRefError extends SymbolRef {
  readonly reason: string;
}

/** Extract the `vigiles:symbol` references from a markdown file. */
export function symbolRefs(markdown: string): SymbolRef[] {
  const refs: SymbolRef[] = [];
  for (const span of inlineSpans(markdown)) {
    const m = SYMBOL_MARK.exec(span.text);
    if (m) refs.push({ file: m[1], symbol: m[2], line: span.line });
  }
  return refs;
}

/**
 * Verify the file-qualified symbol references in a markdown file: the named
 * file must exist and define the named symbol. `basePath` is the directory the
 * paths resolve against (the instruction file's own directory).
 */
export function verifySymbolRefs(
  markdown: string,
  basePath: string,
): SymbolRefError[] {
  const errors: SymbolRefError[] = [];
  for (const ref of symbolRefs(markdown)) {
    const full = resolve(basePath, ref.file);
    const support = langForFile(ref.file);
    if (!existsSync(full)) {
      errors.push({ ...ref, reason: `File not found: "${ref.file}"` });
    } else if (support.kind === "unsupported") {
      errors.push({
        ...ref,
        reason: `Unsupported language for symbol check: "${ref.file}"`,
      });
    } else if (support.kind === "grammar-missing") {
      // NOT "unsupported": the language is one this tool parses, the optional grammar just is
      // not installed here. Saying it the other way would report an un-run check as a verdict.
      errors.push({
        ...ref,
        reason: `Symbol not checked: the ${support.id} grammar is not installed (npm i -D ${support.pkg})`,
      });
    } else if (!fileDefinesSymbol(full, ref.symbol)) {
      errors.push({
        ...ref,
        reason: `"${ref.symbol}" is not defined in ${ref.file}`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Enforcement: force code references to carry the file-qualified mark
// ---------------------------------------------------------------------------

const HAS_EXT = /\.[A-Za-z0-9]+$/; // a file extension → a path/filename, not a rule
// A linter-rule reference: a slash-scoped `linter/rule` (optionally `@scoped`)
// with NO file extension — `eslint/no-console`, `@typescript-eslint/no-x`,
// `boundaries/dependencies`. Deliberately NOT a path (`src/x.ts`) or a bare
// identifier (`runHook`): those are excluded.
const RULE_SHAPED = /^@?[a-z][\w-]*(?:\/[\w-]+)+$/;
const IGNORE_FILE = /<!--\s*vigiles:ignore-file\s*-->/;
const IGNORE_LINE = /<!--\s*vigiles:ignore\s*-->/;

/**
 * Whether a span is a **linter-rule reference** that ought to be marked
 * (`enforce()` / inline `<!-- vigiles:enforce -->`) so the lint can verify the
 * rule exists AND is enabled. High-signal only: a slash-scoped name with no file
 * extension. A function-call form `` `foo(args)` `` is reduced to its callee.
 *
 * Deliberately NOT flagged (too noisy / undecidable): bare identifiers
 * (`runHook`, `MAX_RETRIES` — usually API prose, mark opt-in via an explicit
 * `vigiles:symbol`) and file paths (`src/x.ts`, `docs/y.md` — file refs).
 */
export function isCodeShaped(text: string): boolean {
  const callee = text.replace(/\s*\([^)]*\)\s*$/, ""); // `foo(args)` → `foo`
  return RULE_SHAPED.test(callee) && !HAS_EXT.test(callee);
}

/**
 * Unmarked linter-rule references — the spans the refs-hook nudges the agent to
 * mark with `enforce()` / `<!-- vigiles:enforce ... -->` (or opt out of with
 * `<!-- vigiles:ignore -->` / `<!-- vigiles:ignore-file -->`).
 */
export function unmarkedCodeRefs(markdown: string): Span[] {
  if (IGNORE_FILE.test(markdown)) return [];
  const lines = markdown.split("\n");
  return inlineSpans(markdown).filter((span) => {
    if (IGNORE_LINE.test(lines[span.line - 1] ?? "")) return false;
    if (SYMBOL_MARK.test(span.text)) return false; // already a vigiles:symbol mark
    return isCodeShaped(span.text);
  });
}

/**
 * The reference issues in an instruction file, as one human-readable line each:
 * a `vigiles:symbol` mark whose symbol is missing, plus every unmarked
 * code-shaped span that ought to be a mark. The shared detector behind both the
 * `vigiles refs` CLI and the PostToolUse refs-hook.
 */
export function collectRefIssues(markdown: string, basePath: string): string[] {
  const out: string[] = [];
  for (const b of verifySymbolRefs(markdown, basePath)) {
    out.push(`line ${String(b.line)}: ${b.reason}`);
  }
  for (const u of unmarkedCodeRefs(markdown)) {
    out.push(
      `line ${String(u.line)}: \`${u.text}\` is an unmarked linter-rule ` +
        `reference — mark it as \`enforce("${u.text}")\` (typed spec) or ` +
        `\`<!-- vigiles:enforce ${u.text} -->\` (markdown) so lint can verify ` +
        `it exists and is enabled, or add <!-- vigiles:ignore --> if it is prose`,
    );
  }
  return out;
}

/** What the refs-hook should do given the issue count and configured severity. */
export type RefsHookAction = "ok" | "nudge" | "block";

/**
 * Map detected issues + the `unmarked-refs` rule severity to a hook action:
 * no issues or `false` → ok, `"error"` → block (exit 2), anything else
 * (`"warn"`, the default) → a non-blocking nudge.
 */
export function refsHookAction(
  issueCount: number,
  severity: RuleSeverity,
): RefsHookAction {
  if (issueCount === 0 || severity === false) return "ok";
  return severity === "error" ? "block" : "nudge";
}
