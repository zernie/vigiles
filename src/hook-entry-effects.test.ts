/**
 * `vigiles/hook` is the ONLY import a compiled hook may have (`checkHookImports`),
 * so whatever that entry can reach, every compiled hook can reach — past the
 * capability check and outside the stamp. This test holds the entry to the
 * promise the check makes: nothing reachable from `src/entries/hook.ts` can read a file,
 * spawn a process, open a socket or load a module it was not built with.
 *
 * It broke once, which is why it exists: `experimental_loadHook` was moved onto
 * this entry beside the vocabulary it tests, and a hook could then load any local
 * module with no capability check and no stamp (Codex P1 on #510). The loader and
 * the assertions now live on `vigiles/hook/testing`.
 *
 * HOW: the TypeScript parser walks the entry's SOURCE graph — every relative
 * import, followed — and checks each module's AST. A static scan cannot see a
 * value smuggled in at run time, so the graph is held to three closed lists
 * rather than a deny-list of known-bad modules:
 *   - a non-relative import (static or `export … from`) is one of
 *     `STATIC_MODULES`;
 *   - a dynamic load — `import(…)` or `require(…)` — names a string literal from
 *     `LAZY_PACKAGES` (the two lazy parsers the hot path defers);
 *   - the package is ES modules, so a lazy `require` is made, never received:
 *     `node:module` may be imported only as `{ createRequire }`, and that may
 *     appear only as `const require = createRequire(import.meta.url)` — so every
 *     load still goes through a `require("…")` the rule above checks, and a
 *     direct `createRequire(x)("anything")` is a finding;
 *   - no module touches `process`, `globalThis`, `eval` or `Function`, the
 *     ambient doors to the loader and the OS.
 * Type-only imports are skipped: they are erased and load nothing.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// Vitest runs this file from src/, so __dirname is src/.
const SRC = import.meta.dirname;
const ENTRY = resolve(SRC, "entries", "hook.ts");

/** The non-relative modules the entry's graph may import statically. */
const STATIC_MODULES: ReadonlySet<string> = new Set(["node:crypto"]);
/** The packages the graph may load lazily, each by a literal specifier. */
const LAZY_PACKAGES: ReadonlySet<string> = new Set(["mvdan-sh", "@iarna/toml"]);
/** Globals that reach the loader or the OS without an import. */
const AMBIENT: ReadonlySet<string> = new Set([
  "process",
  "globalThis",
  "eval",
  "Function",
]);

interface Finding {
  readonly file: string;
  readonly what: string;
}

const isTypeOnly = (node: ts.ImportDeclaration | ts.ExportDeclaration) =>
  ts.isImportDeclaration(node)
    ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    : node.isTypeOnly;

/** Parents under which an identifier is a NAME (a key, a member, a type), not a read. */
const NAME_POSITIONS: readonly ((n: ts.Node) => boolean)[] = [
  ts.isPropertySignature,
  ts.isPropertyDeclaration,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isQualifiedName,
  ts.isTypeReferenceNode,
  ts.isImportSpecifier,
  ts.isExportSpecifier,
];

/** Whether `id` is read as a value here (not a property name, key or type). */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  const isMemberName =
    (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) &&
    p.name === id;
  return !isMemberName && !NAME_POSITIONS.some((is) => is(p));
}

function relativeTarget(from: string, spec: string): string | undefined {
  const target = resolve(dirname(from), spec.replace(/\.js$/, ".ts"));
  return existsSync(target) ? target : undefined;
}

function checkCall(
  node: ts.CallExpression,
  file: string,
  out: Finding[],
): void {
  const isDynamic =
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require");
  if (!isDynamic) return;
  const [arg] = node.arguments;
  if (
    arg === undefined ||
    !ts.isStringLiteral(arg) ||
    !LAZY_PACKAGES.has(arg.text)
  ) {
    out.push({ file, what: `dynamic load: ${node.getText()}` });
  }
}

/** The specifier a (non-type-only) static import or re-export loads, if any. */
function loadedSpecifier(node: ts.Node): string | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
    return undefined;
  }
  const m = node.moduleSpecifier;
  if (m === undefined || !ts.isStringLiteral(m) || isTypeOnly(node)) {
    return undefined;
  }
  return m.text;
}

/** `import { createRequire } from "node:module"`, exactly: no other binding. */
function isCreateRequireImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  const bindings = clause?.namedBindings;
  const names =
    bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map((e) => e.getText())
      : [];
  return clause?.name === undefined && names.join() === "createRequire";
}

/** `const require = createRequire(import.meta.url)`, exactly. */
function isRequireMaker(node: ts.Identifier): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.expression !== node) return false;
  const decl = call.parent;
  return (
    ts.isVariableDeclaration(decl) &&
    decl.name.getText() === "require" &&
    call.arguments.map((a) => a.getText()).join() === "import.meta.url"
  );
}

function checkCreateRequire(node: ts.Node, file: string, out: Finding[]): void {
  if (!ts.isIdentifier(node) || node.text !== "createRequire") return;
  if (ts.isImportSpecifier(node.parent) || isRequireMaker(node)) return;
  out.push({ file, what: `createRequire use: ${node.parent.getText()}` });
}

function checkSpecifier(
  spec: string,
  file: string,
  next: string[],
  out: Finding[],
): void {
  if (spec.startsWith(".")) {
    const target = relativeTarget(file, spec);
    if (target !== undefined) next.push(target);
  } else if (!STATIC_MODULES.has(spec)) {
    out.push({ file, what: `import of ${spec}` });
  }
}

/** A static import or re-export: `node:module` only as `{ createRequire }`. */
function checkLoad(
  node: ts.Node,
  at: {
    readonly file: string;
    readonly next: string[];
    readonly out: Finding[];
  },
): void {
  const { file, next, out } = at;
  const spec = loadedSpecifier(node);
  if (spec === undefined) return;
  if (spec !== "node:module") {
    checkSpecifier(spec, file, next, out);
  } else if (!ts.isImportDeclaration(node) || !isCreateRequireImport(node)) {
    out.push({ file, what: `import of node:module: ${node.getText()}` });
  }
}

/** Check one module; return the relative modules it imports. */
function checkModule(file: string, out: Finding[]): string[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const next: string[] = [];
  const visit = (node: ts.Node): void => {
    checkLoad(node, { file, next, out });
    checkCreateRequire(node, file, out);
    if (ts.isCallExpression(node)) checkCall(node, file, out);
    if (
      ts.isIdentifier(node) &&
      AMBIENT.has(node.text) &&
      isValueReference(node)
    ) {
      out.push({ file, what: `ambient ${node.text}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return next;
}

function sweep(entry: string): {
  readonly modules: readonly string[];
  readonly findings: readonly Finding[];
} {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...checkModule(file, findings));
  }
  return { modules: [...seen], findings };
}

test("nothing reachable from vigiles/hook can read a file, spawn, or load a module", () => {
  const { modules, findings } = sweep(ENTRY);
  // The walk really followed the graph (a broken resolver would pass vacuously).
  assert.ok(
    modules.some((m) => m.endsWith("core/hook-program.ts")),
    "the sweep did not reach core/hook-program.ts",
  );
  assert.deepEqual(
    findings.map((f) => `${relative(SRC, f.file)}: ${f.what}`),
    [],
  );
});

test("the sweep fires: the hook/testing entry's loader is caught", () => {
  // Both directions, because an "is absent" check that can only pass is worth
  // nothing: the same walk over vigiles/hook/testing finds the dynamic import.
  const { findings } = sweep(resolve(SRC, "entries", "hook", "testing.ts"));
  assert.ok(
    findings.some((f) => f.what.startsWith("dynamic load: import(")),
    `expected the loader's dynamic import, got ${JSON.stringify(findings)}`,
  );
});
