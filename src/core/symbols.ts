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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { parse, Lang } from "@ast-grep/napi";

import {
  ID_KINDS as ID_KIND_LIST,
  SCOPE_KINDS as SCOPE_KIND_LIST,
  loadWasmGrammar,
  wasmDefinedSymbols,
  type WasmLang,
} from "./tree-sitter-wasm.js";

/**
 * Python, Ruby and Rust are parsed by WebAssembly builds of their tree-sitter grammars
 * (`./tree-sitter-wasm.ts`); TypeScript, TSX, JavaScript and CSS by the grammars built into
 * `@ast-grep/napi`.
 *
 * 🔴 WHY NOT `@ast-grep/lang-*` ANY MORE (#257). Those native grammars were the only packages in
 * the tree carrying a `postinstall`, and since pnpm 10 an unapproved dependency build script
 * FAILS a consumer's install (`ERR_PNPM_IGNORED_BUILDS`) — for every `pnpm add vigiles`, whether
 * or not the project has a single `.py` file. Making them optional peers stopped the failure but
 * moved the cost onto the user: a `.py` reference then reported "grammar not installed" after an
 * upgrade. The WASM grammars are a plain dependency with no install script and no native
 * binary, so they are simply there. `src/package-install-scripts.e2e.test.ts` holds both halves
 * against the packed tarball: no install script in the tree, and a `.py` lookup that works
 * right after a default install.
 */
const WASM_LANGS: ReadonlySet<string> = new Set<WasmLang>([
  "python",
  "ruby",
  "rust",
]);

function isWasmLang(key: LangKey): key is WasmLang {
  return typeof key === "string" && WASM_LANGS.has(key);
}

/** A language key: an `@ast-grep/napi` built-in, or one of the WASM grammars. */
type LangKey = Lang | WasmLang;

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
 * 🔴 THE THREE CASES ARE SEPARATE MEMBERS BECAUSE THEY ARE SEPARATE FACTS. "Extension not in
 * the table" and "the language IS ours but its grammar failed to load in this process" must not
 * share one `null`: both callers would print the first sentence, and a check that did not run
 * would read as a verdict. With WASM grammars shipped as a regular dependency there is no
 * install or platform gap left, so `grammar-load-failed` should not happen — but if the runtime
 * genuinely cannot load, the report carries the loader's own error text, never "not defined"
 * and never an install instruction the user cannot act on.
 */
export type LangSupport =
  | { readonly kind: "ready"; readonly lang: LangKey }
  | {
      readonly kind: "grammar-load-failed";
      readonly lang: WasmLang;
      readonly error: string;
    }
  | { readonly kind: "unsupported" };

export async function langForFile(file: string): Promise<LangSupport> {
  const key = file.endsWith(".d.ts")
    ? Lang.TypeScript
    : EXT_LANG[extname(file).toLowerCase()];
  if (key === undefined) return { kind: "unsupported" };
  if (isWasmLang(key)) {
    // Lazy: the first .py/.rb/.rs reference starts the runtime; later ones hit the cache.
    const error = await loadWasmGrammar(key);
    if (error !== null)
      return { kind: "grammar-load-failed", lang: key, error };
  }
  return { kind: "ready", lang: key };
}

/** The one sentence both callers print for a symbol reference that could not be checked. */
export function notCheckedReason(
  support: Extract<LangSupport, { kind: "grammar-load-failed" }>,
): string {
  return `Symbol not checked: the ${support.lang} grammar failed to load: ${support.error}`;
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

const ID_KINDS: ReadonlySet<string> = new Set(ID_KIND_LIST);
const SCOPE_KINDS: ReadonlySet<string> = new Set(SCOPE_KIND_LIST);

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

/**
 * Extract the symbols defined in a single file's source. Async because the Python / Ruby / Rust
 * grammars are WebAssembly, whose instantiation is async; the napi languages resolve at once.
 */
export async function definedSymbols(
  code: string,
  lang: LangKey,
): Promise<SymbolDef[]> {
  if (isWasmLang(lang)) return wasmDefinedSymbols(code, lang);
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
export async function definedSymbolsInFile(file: string): Promise<SymbolDef[]> {
  const support = await langForFile(file);
  if (support.kind !== "ready") return [];
  let code: string;
  try {
    code = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  // Deliberately OUTSIDE the try: a parser failure is not an empty file. Swallowing it would
  // turn "could not parse" into "is not defined" — a check that did not run, read as a verdict.
  return definedSymbols(code, support.lang);
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
export async function fileDefinesSymbol(
  file: string,
  name: string,
): Promise<boolean> {
  if ((await definedSymbolsInFile(file)).some((d) => d.name === name))
    return true;
  const ext = extname(file);
  const decl = DECL_SIBLING[ext];
  if (decl && !file.endsWith(decl)) {
    const sibling = file.slice(0, -ext.length) + decl;
    if (
      existsSync(sibling) &&
      (await definedSymbolsInFile(sibling)).some((d) => d.name === name)
    ) {
      return true;
    }
  }
  return false;
}
