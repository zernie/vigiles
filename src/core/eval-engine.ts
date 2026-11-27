/**
 * The eval ENGINE's fingerprint (vigiles#416): which of vigiles' own modules a
 * run reaches, so a regression case's lock goes stale when the code that
 * scores it changes, not only when the case does.
 *
 * The reachable set is READ, not listed: `ts.createSourceFile` parses each
 * module, and the walk follows every `import … from`, `export … from` and
 * `import("…")` whose specifier is a string literal. A relative specifier is
 * followed; a bare one (`zod`, `effect`) is a dependency and is not hashed,
 * so a dependency bump with no vigiles change is not detected. An `import()`
 * whose specifier is computed cannot be followed: the walk returns its place,
 * and a test asserts the set of such places, so a new one fails a test.
 *
 * Pure: the caller reads the files (`scripts/build-eval-engine.mjs` over
 * `dist/`, the test over `src/`). The runtime reads only the JSON the build
 * writes (`src/host/eval-engine.io.ts`), so `typescript` is never loaded by a run.
 */
import { createHash } from "node:crypto";
import type TS from "typescript";
import { ts } from "./typescript-lazy.js";

/** What one module refers to. */
export interface ModuleRefs {
  /** Every string-literal specifier, as written. */
  readonly literal: readonly string[];
  /** The 1-based line of each `import()` with a computed specifier. */
  readonly dynamic: readonly number[];
}

type Ref =
  | { readonly kind: "literal"; readonly spec: string }
  | { readonly kind: "dynamic"; readonly line: number };

/** The module references of one file's text. */
export function moduleRefs(fileName: string, text: string): ModuleRefs {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const refs = refsUnder(sf, sf);
  return {
    literal: refs.flatMap((r) => (r.kind === "literal" ? [r.spec] : [])),
    dynamic: refs.flatMap((r) => (r.kind === "dynamic" ? [r.line] : [])),
  };
}

function refsUnder(
  node: Readonly<TS.Node>,
  sf: Readonly<TS.SourceFile>,
): readonly Ref[] {
  return [
    ...refOf(node, sf),
    ...node.getChildren(sf).flatMap((c) => refsUnder(c, sf)),
  ];
}

function refOf(
  node: Readonly<TS.Node>,
  sf: Readonly<TS.SourceFile>,
): readonly Ref[] {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    return typeOnly(node) ? [] : literal(node.moduleSpecifier);
  return isImportCall(node) ? dynamicImport(node, sf) : [];
}

/** `import type …` / `export type … from`: erased at emit, so not part of the engine. */
const typeOnly = (node: Readonly<TS.Node>): boolean =>
  (ts.isImportDeclaration(node) &&
    node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) ||
  (ts.isExportDeclaration(node) && node.isTypeOnly);

const isImportCall = (node: Readonly<TS.Node>): node is TS.CallExpression =>
  ts.isCallExpression(node) &&
  node.expression.kind === ts.SyntaxKind.ImportKeyword;

function literal(spec: Readonly<TS.Expression> | undefined): readonly Ref[] {
  return spec !== undefined && ts.isStringLiteralLike(spec)
    ? [{ kind: "literal", spec: spec.text }]
    : [];
}

function dynamicImport(
  node: Readonly<TS.CallExpression>,
  sf: Readonly<TS.SourceFile>,
): readonly Ref[] {
  const found = literal(node.arguments.at(0));
  if (found.length > 0) return found;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return [{ kind: "dynamic", line: line + 1 }];
}

/** How the walk reads a module and resolves a specifier from it. */
export interface WalkIo {
  read(path: string): string;
  /** The module a relative specifier names from `from`; undefined for a bare one. */
  resolve(from: string, spec: string): string | undefined;
}

/** A computed `import()`: the file and line. */
export interface DynamicSite {
  readonly file: string;
  readonly line: number;
}

/** What the walk found from its roots. */
export interface EngineWalk {
  /** Every module reached, sorted. */
  readonly files: readonly string[];
  readonly dynamic: readonly DynamicSite[];
}

/** Walk every module reachable from `roots`. */
export function walkEngine(roots: readonly string[], io: WalkIo): EngineWalk {
  const seen = visit(roots, new Map(), io);
  const files = [...seen.keys()].sort((a, b) => a.localeCompare(b));
  return {
    files,
    dynamic: files.flatMap((file) =>
      (seen.get(file)?.dynamic ?? []).map((line) => ({ file, line })),
    ),
  };
}

function visit(
  pending: readonly string[],
  seen: ReadonlyMap<string, ModuleRefs>,
  io: WalkIo,
): ReadonlyMap<string, ModuleRefs> {
  const next = pending.at(0);
  if (next === undefined) return seen;
  const rest = pending.slice(1);
  if (seen.has(next)) return visit(rest, seen, io);
  const refs = moduleRefs(next, io.read(next));
  const deps = refs.literal.flatMap((s) => {
    const r = io.resolve(next, s);
    return r === undefined || seen.has(r) ? [] : [r];
  });
  return visit([...rest, ...deps], new Map([...seen, [next, refs]]), io);
}

/** The fingerprint of the reached modules: sha256 over each path and its bytes, in order. */
export function engineHash(
  modules: readonly { readonly path: string; readonly text: string }[],
): string {
  const h = createHash("sha256");
  modules.forEach((m) => {
    h.update(`${m.path}\0${m.text}\0`);
  });
  return h.digest("hex");
}
