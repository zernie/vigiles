/**
 * What each public entry exports — read from the SOURCE with the TypeScript
 * checker, not by importing the modules.
 *
 * The three export gates (one name one door, a function budget per door, the
 * STABILITY.md table) all need the same facts: the entries are the keys of
 * package.json `exports`, each entry's source is the file its `dist` path was
 * compiled from, and an export is a VALUE (it exists at runtime) or a TYPE
 * (it does not). The checker answers all of that, `export *` and re-exports
 * included, and loading no module means a matcher entry's side effects
 * (`expect.extend`) never run in a test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Object exports whose MEMBERS are the functions a budget counts. Only `check`:
 * it is the root's one callable verb object (`check.tool`, `check.skill`, ...),
 * each member a separate way to say a thing about a run. Data and config objects
 * (an adapter, a matcher table) are one export each.
 */
const EXPANDED = new Set(["check"]);

/** The source file an `exports` value was compiled from. */
function sourceOf(root, value) {
  const target =
    typeof value === "string" ? value : (value.types ?? value.default);
  return path.join(
    root,
    target
      .replace(/^\.\/dist\//, "src/")
      .replace(/\.d\.mts$|\.mjs$/, ".mts")
      .replace(/\.d\.ts$|\.js$/, ".ts"),
  );
}

/**
 * Every entry in package.json `exports`.
 * @returns {Map<string, {values: Map<string, "function"|"const"|"class"|"enum">, types: Set<string>, members: Map<string, string[]>}>}
 *   keyed by the subpath (`"."`, `"./hook"`, …). `members` maps a value export
 *   that is an object with members (the root's `check`) to those member names,
 *   because a member is a door as much as a top-level name is.
 */
export function entryExports(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const files = Object.entries(pkg.exports).map(([key, v]) => [
    key,
    sourceOf(root, v),
  ]);
  const cfgPath = path.join(root, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const program = ts.createProgram(
    files.map(([, f]) => f),
    { ...parsed.options, noEmit: true },
  );
  const checker = program.getTypeChecker();
  const out = new Map();
  for (const [key, file] of files) {
    const sf = program.getSourceFile(file);
    const moduleSym = sf && checker.getSymbolAtLocation(sf);
    const values = new Map();
    const types = new Set();
    const members = new Map();
    for (const sym of moduleSym ? checker.getExportsOfModule(moduleSym) : []) {
      const target =
        sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const name = sym.getName();
      if (name === "default") continue;
      if (target.flags & ts.SymbolFlags.Function) values.set(name, "function");
      else if (target.flags & ts.SymbolFlags.Class) values.set(name, "class");
      else if (target.flags & ts.SymbolFlags.Enum) values.set(name, "enum");
      else if (target.flags & ts.SymbolFlags.Variable) {
        values.set(name, "const");
        const decl = target.valueDeclaration ?? target.declarations?.[0];
        const props =
          decl && EXPANDED.has(name)
            ? checker
                .getTypeOfSymbolAtLocation(target, decl)
                .getProperties()
                .map((p) => p.getName())
            : [];
        if (props.length > 0) members.set(name, props.sort());
      }
      // A name that is a value AND a type (an interface merged with a const)
      // is both: it must be unique as a type too.
      if (
        target.flags &
        (ts.SymbolFlags.Type |
          ts.SymbolFlags.TypeAlias |
          ts.SymbolFlags.Interface)
      )
        types.add(name);
      else if (!(target.flags & ts.SymbolFlags.Value)) types.add(name);
    }
    out.set(key, { values, types, members });
  }
  return out;
}

/**
 * The names an entry's budget counts: every runtime export, with the members of
 * an object export spelled `object.member` and counted INSTEAD of the object
 * (the object is only the door; the members are the functions).
 */
export function budgetNames(entry) {
  const names = [];
  for (const name of entry.values.keys()) {
    const m = entry.members.get(name);
    if (m) for (const member of m) names.push(`${name}.${member}`);
    else names.push(name);
  }
  return names.sort();
}
