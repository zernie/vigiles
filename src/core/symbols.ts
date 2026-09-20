/**
 * vigiles — cross-language symbol index (ast-grep / tree-sitter).
 *
 * The kernel of harness-pinned reference verification. Instruction files
 * reference project symbols in prose (`parseConfig`, `User`, `create_docx.py`);
 * authors never write a verifiable `file#symbol` form (corpus: ~0%). So instead
 * of asking authors to annotate, the *harness* resolves a bare reference against
 * the live code at write time and pins it. This module is the resolver: extract
 * the symbols a file defines, and build a project-wide name → locations index.
 *
 * Boundary (see research/symbol-verification.md): we answer "does a definition
 * with this name (in this scope) exist", NOT "does this reference resolve through
 * imports / Zeitwerk / tsconfig". Resolution is per-language and architectural —
 * delegated. Ambiguity (a name defined in several files) is reported, not guessed.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";

import { parse, Lang, registerDynamicLanguage } from "@ast-grep/napi";

/**
 * The non-web grammars, as OPTIONAL packages keyed by the id ast-grep registers them under.
 *
 * 🔴 WHY OPTIONAL, AND WHY IT IS NOT A PREFERENCE. These three are the only packages in this
 * dependency tree carrying a `postinstall` (measured 2026-09-20 with `npm query
 * ":attr(scripts, [postinstall])"`). Since pnpm 10 a consumer's install FAILS on an
 * unapproved lifecycle script, so every downstream project installing vigiles with pnpm got
 * `ERR_PNPM_IGNORED_BUILDS` and a non-zero exit — for grammars most of them never use. The web
 * grammars every user does need (TypeScript, TSX, JavaScript, CSS) are built into
 * `@ast-grep/napi` and cost nothing.
 *
 * They load through `createRequire` rather than `await import()` on purpose: the packages are
 * CommonJS (`"main": "index.js"`, no `exports`), so a synchronous require works and NOTHING in
 * this module's public surface has to become async. Measured, not assumed.
 */
const OPTIONAL_GRAMMARS: Readonly<Record<string, string>> = {
  python: "@ast-grep/lang-python",
  rust: "@ast-grep/lang-rust",
  ruby: "@ast-grep/lang-ruby",
};

// Anchored on THIS module's own file, not on the consumer's project root. Under pnpm a
// consumer's root does not contain our transitive packages at all — the same addressing
// mistake that made every hook fail there — and these grammars are OUR optional dependencies,
// so they resolve from where this file lives. `__filename` rather than `import.meta.url`
// because this package compiles to CommonJS (`module: Node16`, `main: ./dist/test.js`).
const require_ = createRequire(__filename);

/** Registered grammar ids, populated on first use. `null` until then. */
let loaded: ReadonlySet<string> | null = null;

function ensureRegistered(): ReadonlySet<string> {
  if (loaded) return loaded;
  const dynamic: Parameters<typeof registerDynamicLanguage>[0] = {};
  const present = new Set<string>();
  for (const [id, pkg] of Object.entries(OPTIONAL_GRAMMARS)) {
    try {
      dynamic[id] = require_(pkg) as (typeof dynamic)[string];
      present.add(id);
    } catch {
      // Absent by design: an optional dependency the consumer did not install. The caller is
      // told WHICH id is missing (see `langForFile`), so "not checked" never reads as "clean".
    }
  }
  if (present.size > 0) registerDynamicLanguage(dynamic);
  loaded = present;
  return loaded;
}

/** Which optional grammars this process actually has. Exported so a report can say so. */
export function installedGrammars(): ReadonlySet<string> {
  return ensureRegistered();
}

/** A language key accepted by ast-grep's `parse` (core enum or registered id). */
type LangKey = Lang | string;

const EXT_LANG: Record<string, LangKey> = {
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".mts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
  ".d.ts": Lang.TypeScript,
  ".js": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".css": Lang.Css,
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".rb": "ruby",
  ".rbi": "ruby",
};

/**
 * Whether this file's language can be parsed HERE, and if not, which of the two reasons.
 *
 * 🔴 THE THREE CASES ARE SEPARATE MEMBERS BECAUSE THEY ARE SEPARATE FACTS. The previous
 * signature was `LangKey | null`, where `null` meant "extension not in the table" and callers
 * printed "Unsupported language for symbol check". Making the grammars optional would have
 * given that same `null` a second meaning — "the language IS ours, the package is simply not
 * installed" — and both callers would have kept printing the first sentence. That is the
 * failure this codebase exists to catch: a check that did not run, reported in the words of a
 * check that did. A union makes the compiler demand the distinction at every call site.
 */
export type LangSupport =
  | { readonly kind: "ready"; readonly lang: LangKey }
  | {
      readonly kind: "grammar-missing";
      readonly id: string;
      readonly pkg: string;
    }
  | { readonly kind: "unsupported" };

export function langForFile(file: string): LangSupport {
  const key = file.endsWith(".d.ts")
    ? Lang.TypeScript
    : EXT_LANG[extname(file).toLowerCase()];
  if (key === undefined) return { kind: "unsupported" };
  // A string key is one of the dynamically registered grammars; the enum members are built in.
  if (typeof key === "string" && key in OPTIONAL_GRAMMARS) {
    if (!ensureRegistered().has(key))
      return { kind: "grammar-missing", id: key, pkg: OPTIONAL_GRAMMARS[key] };
  }
  return { kind: "ready", lang: key };
}

/** A symbol definition found in a file. */
export interface SymbolDef {
  /** The defined identifier, e.g. "parseConfig". */
  readonly name: string;
  /** The tree-sitter node kind, e.g. "function_declaration" (raw, per-grammar). */
  readonly kind: string;
  /** Enclosing class/module name, or "" at top level. */
  readonly scope: string;
  /** 1-based line of the definition. */
  readonly line: number;
}

const ID_KINDS = new Set(["identifier", "constant", "type_identifier"]);
const SCOPE_KINDS = new Set([
  "class_declaration",
  "class_definition",
  "class",
  "module",
  "interface_declaration",
  "enum_declaration",
]);

interface RawNode {
  kind(): string;
  text(): string;
  field(name: string): RawNode | null;
  children(): RawNode[];
  range(): { start: { line: number } };
}

function recordNode(node: RawNode, scope: string, out: SymbolDef[]): void {
  const line = node.range().start.line + 1;
  const nameNode = node.field("name");
  if (nameNode) {
    out.push({ name: nameNode.text(), kind: node.kind(), scope, line });
  }
  // Assignment-style constants (Python/Ruby `X = ...`): the identifier is the
  // `left` field, not `name`.
  const left = node.field("left");
  if (left && ID_KINDS.has(left.kind())) {
    out.push({ name: left.text(), kind: node.kind(), scope, line });
  }
}

/** Extract the symbols defined in a single file's source. */
export function definedSymbols(code: string, lang: LangKey): SymbolDef[] {
  ensureRegistered();
  const out: SymbolDef[] = [];
  const walk = (node: RawNode, scope: string): void => {
    recordNode(node, scope, out);
    const nameNode = node.field("name");
    const nextScope =
      SCOPE_KINDS.has(node.kind()) && nameNode ? nameNode.text() : scope;
    for (const child of node.children()) walk(child, nextScope);
  };
  walk(parse(lang, code).root() as unknown as RawNode, "");
  return out;
}

/** Defined symbols for a file on disk, or [] if unreadable/unsupported. */
export function definedSymbolsInFile(file: string): SymbolDef[] {
  const support = langForFile(file);
  if (support.kind !== "ready") return [];
  const lang = support.lang;
  try {
    return definedSymbols(readFileSync(file, "utf-8"), lang);
  } catch {
    return [];
  }
}

// A co-located declaration file that may declare symbols the source defines
// dynamically (Sorbet `.rbi`, TypeScript `.d.ts`) — checked as a fallback so a
// metaprogrammed `define_method` / ambient declaration still resolves.
const DECL_SIBLING: Record<string, string> = {
  ".ts": ".d.ts",
  ".tsx": ".d.ts",
  ".js": ".d.ts",
  ".jsx": ".d.ts",
  ".mjs": ".d.ts",
  ".rb": ".rbi",
};

/**
 * Whether `file` defines a top-level (or scoped) symbol named `name`. This is
 * the whole check for a file-qualified reference (`path#symbol`): we parse the
 * one named file — no project-wide index, no resolution across files. As a
 * fallback we also consult a co-located declaration file (`.rbi` / `.d.ts`), so
 * typed dynamic symbols resolve without running Sorbet / the TS compiler.
 */
export function fileDefinesSymbol(file: string, name: string): boolean {
  if (definedSymbolsInFile(file).some((d) => d.name === name)) return true;
  const ext = extname(file);
  const decl = DECL_SIBLING[ext];
  if (decl && !file.endsWith(decl)) {
    const sibling = file.slice(0, -ext.length) + decl;
    if (
      existsSync(sibling) &&
      definedSymbolsInFile(sibling).some((d) => d.name === name)
    ) {
      return true;
    }
  }
  return false;
}
