/**
 * The `deprecated-key-files` detector — finds `keyFiles` in instruction specs
 * WITHOUT running them.
 *
 * `lint` and `audit` both report it from this one function. Neither may import a
 * spec: `audit` is a side-effect-free read, and a spec is the user's program.
 * So the spec is PARSED (TypeScript AST) and the field is read off the syntax
 * tree — a `keyFiles` in a comment or inside a string is not usage, and a
 * text search could not tell the difference.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";
import ts from "typescript";

import { measureKeyFiles, type KeyFilesUsage } from "./keyfiles.js";
import { withIgnored, type GlobIgnore } from "./glob-ignore.js";

/** A literal key or value: `"a"`, `'a'`, `` `a` `` or a bare identifier key. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}

/**
 * Read a `{ path: "description" }` object literal. A computed key or value, or a
 * spread, makes the map unmeasurable: its entries are still counted (each one
 * is a pointer that compiles), its size is not guessed.
 */
function measureLiteral(obj: ts.ObjectLiteralExpression): KeyFilesUsage {
  const map: Record<string, string> = {};
  let measured = true;
  let entries = 0;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      measured = false;
      continue;
    }
    entries++;
    const key = literalText(prop.name);
    const value = ts.isIdentifier(prop.initializer)
      ? undefined
      : literalText(prop.initializer);
    if (key === undefined || value === undefined) measured = false;
    else map[key] = value;
  }
  return measured
    ? measureKeyFiles(map)
    : { entries, chars: 0, measured: false };
}

/** Is this property named `keyFiles` (bare or quoted)? */
function isKeyFilesName(name: ts.PropertyName): boolean {
  return (
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    name.text === "keyFiles"
  );
}

/**
 * The `keyFiles` usage in one spec's source, or `null` when the spec does not
 * use the field. The first `keyFiles:` property in any object literal counts —
 * an instruction spec has one builder call, and the field name is not used for
 * anything else in a spec.
 */
export function findKeyFilesInSpecSource(source: string): KeyFilesUsage | null {
  const sf = ts.createSourceFile(
    "spec.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  let found: KeyFilesUsage | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "keyFiles")
      found = { entries: 0, chars: 0, measured: false };
    else if (ts.isPropertyAssignment(node) && isKeyFilesName(node.name))
      found = ts.isObjectLiteralExpression(node.initializer)
        ? measureLiteral(node.initializer)
        : { entries: 0, chars: 0, measured: false };
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** One spec still using `keyFiles`, relative to the directory searched. */
export interface DeprecatedKeyFilesFinding extends KeyFilesUsage {
  readonly path: string;
}

/**
 * Every instruction spec (`**\/*.md.spec.ts`, the same glob `compile` uses)
 * under `root` that still uses `keyFiles`, sorted by path. `node_modules` is
 * never read — someone else's spec is not this repository's to migrate — and
 * `ignore` carries the repository's own `exclude`.
 */
export function findDeprecatedKeyFiles(
  root: string,
  ignore?: GlobIgnore,
): DeprecatedKeyFilesFinding[] {
  const specs = globSync("**/*.md.spec.ts", {
    cwd: root,
    dot: true,
    nodir: true,
    ignore: withIgnored(["**/node_modules/**"], ignore),
    posix: true,
  });
  const out: DeprecatedKeyFilesFinding[] = [];
  for (const rel of [...specs].sort()) {
    const usage = findKeyFilesInSpecSource(
      readFileSync(join(root, rel), "utf-8"),
    );
    if (usage !== null) out.push({ path: rel, ...usage });
  }
  return out;
}
