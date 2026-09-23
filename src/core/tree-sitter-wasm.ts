/**
 * vigiles — the Python / Ruby / Rust parsers, as WebAssembly, behind a SYNCHRONOUS call.
 *
 * WHY WASM (#257). These three used to be `@ast-grep/lang-*` native grammars, the only packages
 * in our tree with a `postinstall`, and since pnpm 10 an unapproved dependency build script
 * fails a consumer's install (`ERR_PNPM_IGNORED_BUILDS`). `@vscode/tree-sitter-wasm` (Microsoft,
 * MIT) ships prebuilt `.wasm` grammars plus the `web-tree-sitter` runtime in one package with
 * no dependencies and no install scripts, so it is an ordinary dependency: installed by default,
 * nothing for the consumer to approve or add, and no per-platform native binary to be missing.
 *
 * WHY A WORKER. web-tree-sitter's `Parser.init()` and `Language.load()` are async (WebAssembly
 * instantiation is), while every caller of the symbol check — `verifySymbolRefs`, the refs-hook,
 * `compileClaude` — is synchronous public surface. So the runtime lives in one lazily started
 * worker thread and the main thread blocks on `Atomics.wait` until it answers: the async work
 * stays async, the API stays sync. The worker is `unref()`ed, so it never keeps a process alive.
 *
 * LAZY. Nothing here runs at import. The worker, the runtime and a grammar are loaded the first
 * time a `.py` / `.rb` / `.rs` reference is actually checked, and each grammar once per process.
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} from "node:worker_threads";

/** The grammars this module parses, keyed by the id used in `tree-sitter-<id>.wasm`. */
export type WasmLang = "python" | "ruby" | "rust";

/** A definition found by the walk — the same shape `symbols.ts` exports as `SymbolDef`. */
export interface WasmSymbolDef {
  readonly name: string;
  readonly kind: string;
  readonly scope: string;
  readonly line: number;
}

type Request =
  | { readonly op: "load"; readonly lang: WasmLang }
  | { readonly op: "parse"; readonly lang: WasmLang; readonly code: string };

type Reply =
  | { readonly ok: true; readonly defs?: WasmSymbolDef[] }
  | { readonly ok: false; readonly error: string };

/**
 * Node kinds that open a scope (their `name` becomes the `scope` of everything inside), and the
 * kinds a `left` field must have to count as an assignment-style definition. ONE list for both
 * walkers — the napi one in `symbols.ts` and the worker below — so they cannot drift apart.
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

/**
 * The worker's source. Plain CommonJS on purpose: an `eval` worker has no path, so it cannot
 * be a compiled sibling file that moves between `src/` (tests) and `dist/` (consumers).
 *
 * 🔴 THE WALK IS THE PREVIOUS ONE, NOT A QUERY. The native-grammar code recorded every node that
 * has a `name` field (its text), plus every node whose `left` field is a bare identifier /
 * constant / type_identifier (assignment-style constants), carrying the name of the nearest
 * enclosing class/module as `scope`. It had no per-language patterns to translate; a
 * tags.scm-style query would have been a DIFFERENT, narrower definition of "defined". The same
 * walk over the same grammar gives the same answer — measured, see `symbols.test.ts`.
 */
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const SCOPE_KINDS = new Set(${JSON.stringify(SCOPE_KINDS)});
const ID_KINDS = new Set(${JSON.stringify(ID_KINDS)});
let ts = null;
let parser = null;
const languages = new Map();
async function language(id) {
  if (ts === null) {
    const runtime = require(join(workerData.dir, "tree-sitter.js"));
    await runtime.Parser.init();
    parser = new runtime.Parser();
    ts = runtime;
  }
  let lang = languages.get(id);
  if (lang === undefined) {
    lang = await ts.Language.load(readFileSync(join(workerData.dir, "tree-sitter-" + id + ".wasm")));
    languages.set(id, lang);
  }
  return lang;
}
function extract(root) {
  const out = [];
  const walk = (node, scope) => {
    const line = node.startPosition.row + 1;
    const name = node.childForFieldName("name");
    if (name) out.push({ name: name.text, kind: node.type, scope, line });
    const left = node.childForFieldName("left");
    if (left && ID_KINDS.has(left.type)) out.push({ name: left.text, kind: node.type, scope, line });
    const next = SCOPE_KINDS.has(node.type) && name ? name.text : scope;
    for (const child of node.children) walk(child, next);
  };
  walk(root, "");
  return out;
}
parentPort.on("message", async ({ req, port, flag }) => {
  let reply;
  try {
    const lang = await language(req.lang);
    if (req.op === "load") {
      reply = { ok: true };
    } else {
      parser.setLanguage(lang);
      const tree = parser.parse(req.code);
      if (!tree) throw new Error("tree-sitter returned no syntax tree");
      try {
        reply = { ok: true, defs: extract(tree.rootNode) };
      } finally {
        tree.delete();
      }
    }
  } catch (e) {
    reply = { ok: false, error: e && e.message ? String(e.message) : String(e) };
  }
  port.postMessage(reply);
  port.close();
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

/** How long one call may block before the worker is declared dead. Parses take milliseconds. */
const ANSWER_TIMEOUT_MS = 120_000;

// Anchored on THIS file (as `symbols.ts` anchors napi): under pnpm the consumer's root does not
// contain our dependencies, our own package's `node_modules` does. `__filename` because this
// package compiles to CommonJS.
const require_ = createRequire(__filename);

let worker: Worker | null = null;

function spawnWorker(): Worker {
  // Resolve in the main thread so a missing package surfaces as this call's error text.
  const dir = dirname(require_.resolve("@vscode/tree-sitter-wasm"));
  const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { dir } });
  w.unref();
  return w;
}

function call(req: Request): Reply {
  try {
    worker ??= spawnWorker();
  } catch (e) {
    // First line only: Node appends a multi-line "Require stack:" that would split one finding
    // across several lines of lint output.
    const text = e instanceof Error ? e.message : String(e);
    return { ok: false, error: text.split("\n")[0] };
  }
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ req, port: port2, flag }, [port2]);
  const waited = Atomics.wait(flag, 0, 0, ANSWER_TIMEOUT_MS);
  const msg = receiveMessageOnPort(port1);
  port1.close();
  if (msg === undefined) {
    // Dead or wedged: drop it so the next call starts a fresh one instead of waiting again.
    void worker.terminate();
    worker = null;
    return {
      ok: false,
      error: `the tree-sitter worker did not answer (${waited}) within ${String(ANSWER_TIMEOUT_MS)} ms`,
    };
  }
  return msg.message as Reply;
}

const loadResult = new Map<WasmLang, string | null>();

/**
 * Load `lang`'s grammar once per process. Returns `null` on success, or the load error's own
 * text — the caller reports it verbatim as "not checked", never as a missing symbol.
 */
export function loadWasmGrammar(lang: WasmLang): string | null {
  const cached = loadResult.get(lang);
  if (cached !== undefined) return cached;
  const reply = call({ op: "load", lang });
  const result = reply.ok ? null : reply.error;
  loadResult.set(lang, result);
  return result;
}

/** Parse `code` and return its definitions. Throws on a parse failure — never returns []. */
export function wasmDefinedSymbols(
  code: string,
  lang: WasmLang,
): WasmSymbolDef[] {
  const reply = call({ op: "parse", lang, code });
  if (!reply.ok) throw new Error(`tree-sitter (${lang}): ${reply.error}`);
  return reply.defs ?? [];
}
