/**
 * vigiles — the Python / Ruby / Rust parsers, as WebAssembly, on the main thread.
 *
 * WHY WASM (#257). These three used to be `@ast-grep/lang-*` native grammars, the only packages
 * in our tree with a `postinstall`; since pnpm 10 an unapproved dependency build script fails a
 * consumer's install (`ERR_PNPM_IGNORED_BUILDS`). `@vscode/tree-sitter-wasm` (Microsoft, MIT)
 * ships prebuilt `.wasm` grammars plus the web-tree-sitter runtime with no dependencies and no
 * install scripts: a plain dependency, nothing for the consumer to approve or add.
 *
 * WHY ASYNC, AND WHY NO WORKER. WebAssembly instantiation is async (`Parser.init()`,
 * `Language.load()`). The first cut kept the symbol check synchronous behind a worker thread
 * and `Atomics.wait`, because `compileClaude` & co. were public and synchronous. They are no
 * longer public (same major), so the check is async end to end and this module simply awaits.
 *
 * LAZY. Nothing loads at import: the runtime is `import()`ed on the first `.py` / `.rb` / `.rs`
 * reference, and each grammar is loaded once per process.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The grammars this module parses, keyed by the id used in `tree-sitter-<id>.wasm`. */
export type WasmLang = "python" | "ruby" | "rust";

/** A definition found by the walk — the same shape `symbols.ts` exports as `SymbolDef`. */
export interface WasmSymbolDef {
  readonly name: string;
  readonly kind: string;
  readonly scope: string;
  readonly line: number;
}

/**
 * Node kinds that open a scope (their `name` becomes the `scope` of everything inside), and the
 * kinds a `left` field must have to count as an assignment-style definition. ONE list for both
 * walkers — the napi one in `symbols.ts` and the one below — so they cannot drift apart.
 */
export const SCOPE_KINDS: readonly string[] = [
  "class_declaration",
  "class_definition",
  "class",
  "module",
  "interface_declaration",
  "enum_declaration",
];
export const ID_KINDS: readonly string[] = [
  "identifier",
  "constant",
  "type_identifier",
];

/** The slice of the web-tree-sitter API the walk uses. */
interface TsNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { readonly row: number };
  readonly children: readonly TsNode[];
  childForFieldName(name: string): TsNode | null;
}
interface TsParser {
  setLanguage(lang: TsLanguage): void;
  parse(code: string): { rootNode: TsNode; delete(): void } | null;
}
type TsLanguage = object;
interface TsRuntime {
  Parser: { init(): Promise<void>; new (): TsParser };
  Language: { load(bytes: Uint8Array): Promise<TsLanguage> };
}

// Anchored on THIS file, like every other resolution in the package: under pnpm the consumer's
// root does not contain our dependencies. `__filename` because the package compiles to CommonJS.
const require_ = createRequire(__filename);
const PKG = "@vscode/tree-sitter-wasm";

let runtime: Promise<{ rt: TsRuntime; dir: string; parser: TsParser }> | null =
  null;
const languages = new Map<WasmLang, Promise<TsLanguage>>();

async function startRuntime(): Promise<{
  rt: TsRuntime;
  dir: string;
  parser: TsParser;
}> {
  const entry = require_.resolve(PKG);
  // The runtime is a UMD/CommonJS module: `import()` exposes it as `default`.
  const mod = (await import(PKG)) as { default?: TsRuntime } & TsRuntime;
  const rt = mod.default ?? mod;
  await rt.Parser.init();
  return { rt, dir: dirname(entry), parser: new rt.Parser() };
}

async function language(id: WasmLang): Promise<TsLanguage> {
  runtime ??= startRuntime();
  const { rt, dir } = await runtime;
  let lang = languages.get(id);
  if (lang === undefined) {
    lang = readFile(join(dir, `tree-sitter-${id}.wasm`)).then((bytes) =>
      rt.Language.load(bytes),
    );
    languages.set(id, lang);
  }
  return lang;
}

/** First line only: Node appends a multi-line "Require stack:" that would split one finding. */
function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n")[0];
}

const loadResult = new Map<WasmLang, Promise<string | null>>();

/**
 * Load `lang`'s grammar once per process. Resolves to `null` on success, or the load error's own
 * text — the caller reports it verbatim as "not checked", never as a missing symbol.
 */
export function loadWasmGrammar(lang: WasmLang): Promise<string | null> {
  let result = loadResult.get(lang);
  if (result === undefined) {
    result = language(lang).then(
      () => null,
      (e: unknown) => firstLine(e),
    );
    loadResult.set(lang, result);
  }
  return result;
}

/**
 * THE PREVIOUS WALK, NOT A QUERY: every node with a `name` field (its text), plus every node whose
 * `left` field is a bare identifier / constant / type_identifier, with the nearest enclosing
 * class/module name as `scope`. The native-grammar code had no per-language patterns to
 * translate; a tags.scm-style query would be a DIFFERENT, narrower definition of "defined".
 */
function extract(root: TsNode): WasmSymbolDef[] {
  const scopeKinds = new Set(SCOPE_KINDS);
  const idKinds = new Set(ID_KINDS);
  const out: WasmSymbolDef[] = [];
  const walk = (node: TsNode, scope: string): void => {
    const line = node.startPosition.row + 1;
    const name = node.childForFieldName("name");
    if (name) out.push({ name: name.text, kind: node.type, scope, line });
    const left = node.childForFieldName("left");
    if (left && idKinds.has(left.type))
      out.push({ name: left.text, kind: node.type, scope, line });
    const next = scopeKinds.has(node.type) && name ? name.text : scope;
    for (const child of node.children) walk(child, next);
  };
  walk(root, "");
  return out;
}

/** Parse `code` and return its definitions. Rejects on a parse failure — never resolves []. */
export async function wasmDefinedSymbols(
  code: string,
  lang: WasmLang,
): Promise<WasmSymbolDef[]> {
  const grammar = await language(lang);
  // `runtime` is set by `language()`; one parser, re-pointed per call. Safe without a lock:
  // setLanguage → parse → walk runs to completion with no `await` in between.
  const { parser } = await (runtime as NonNullable<typeof runtime>);
  parser.setLanguage(grammar);
  const tree = parser.parse(code);
  if (!tree) throw new Error(`tree-sitter (${lang}) returned no syntax tree`);
  try {
    return extract(tree.rootNode);
  } finally {
    tree.delete();
  }
}
