/**
 * Reads `keyFiles` out of an instruction spec's SOURCE, without running it.
 *
 * `lint` and `audit` both report the deprecated field (`deprecated-key-files`),
 * and neither may import a spec: `audit` is a side-effect-free read, and a spec
 * is the user's program. So the source is PARSED (TypeScript syntax tree) and
 * the field is read off the tree — a `keyFiles` inside a comment or a string is
 * not usage, and a text search could not tell the difference.
 *
 * Pure: the file walk that feeds it is `src/deprecated-key-files.ts`.
 */
import ts from "typescript";

import { measureKeyFiles, type KeyFilesUsage } from "./keyfiles.js";

/** Field used, size not knowable from the syntax alone. */
const UNMEASURED = (entries: number): KeyFilesUsage => ({
  entries,
  chars: 0,
  measured: false,
});

/** A literal key or value: `"a"`, `'a'`, `` `a` `` (and, for a key only, `a`). */
function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

/** One `path: "description"` pair, or `undefined` when either side is not literal. */
function literalEntry(
  prop: Readonly<ts.ObjectLiteralElementLike>,
): readonly [string, string] | undefined {
  if (!ts.isPropertyAssignment(prop)) return undefined;
  const key = ts.isIdentifier(prop.name)
    ? prop.name.text
    : literalText(prop.name);
  const value = literalText(prop.initializer);
  return key === undefined || value === undefined ? undefined : [key, value];
}

/**
 * Read a `{ path: "description" }` object literal. A computed key or value, or a
 * spread, makes the map unmeasurable: its pairs are still counted (each one
 * compiles to a line), its size is not guessed.
 */
function measureLiteral(
  obj: Readonly<ts.ObjectLiteralExpression>,
): KeyFilesUsage {
  const pairs = obj.properties.filter(ts.isPropertyAssignment);
  const literal = obj.properties
    .map(literalEntry)
    .filter((e): e is readonly [string, string] => e !== undefined);
  return literal.length === obj.properties.length
    ? measureKeyFiles(Object.fromEntries(literal))
    : UNMEASURED(pairs.length);
}

/** The usage a node declares, if it is a `keyFiles` property. */
function usageAt(node: ts.Node): KeyFilesUsage | undefined {
  if (ts.isShorthandPropertyAssignment(node))
    return node.name.text === "keyFiles" ? UNMEASURED(0) : undefined;
  if (!ts.isPropertyAssignment(node)) return undefined;
  const name = ts.isIdentifier(node.name)
    ? node.name.text
    : literalText(node.name);
  if (name !== "keyFiles") return undefined;
  return ts.isObjectLiteralExpression(node.initializer)
    ? measureLiteral(node.initializer)
    : UNMEASURED(0);
}

/** Depth-first: the first `keyFiles` property under `node`. */
function firstUsage(node: ts.Node): KeyFilesUsage | undefined {
  return (
    usageAt(node) ??
    ts.forEachChild(node, (child) => firstUsage(child)) ??
    undefined
  );
}

/**
 * The `keyFiles` usage in one spec's source, or `null` when the spec does not
 * use the field. The first `keyFiles:` property in any object literal counts —
 * an instruction spec has one builder call, and nothing else in a spec is
 * called that.
 */
export function findKeyFilesInSpecSource(source: string): KeyFilesUsage | null {
  const sf = ts.createSourceFile(
    "spec.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  return firstUsage(sf) ?? null;
}
