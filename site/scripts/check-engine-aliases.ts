/**
 * Every `@engine/…` the site IMPORTS must be a declared alias.
 *
 * 🔴 WHY THIS EXISTS, AND WHY IT IS A CHECK RATHER THAN MORE DERIVATION. Adding
 * an engine symbol used to cost three edits in three files nothing kept in
 * agreement: `vite.aliases.ts`, `vitest.config.ts`'s `optimizeDeps.include`,
 * and `tsconfig.json`'s `paths`. Two of the three are now DERIVED from one list
 * — `vitest.config.ts` imports it, and `tsconfig.json` carries a single
 * `"@engine/*": ["../dist/*.d.ts"]` wildcard, which is all a JSON file can do.
 *
 * THAT WILDCARD IS THE HOLE THIS CLOSES. It makes `tsc` accept any
 * `@engine/<x>` whose `.d.ts` exists under `dist/`, including one with NO
 * alias — so the forgotten entry typechecks, `npm run check` stays green, and
 * the failure arrives in the browser as "Failed to fetch dynamically imported
 * module", a message that names neither the symbol nor the file that should
 * have listed it. Before the wildcard, `tsc` caught that; the check pays that
 * back, and names both.
 *
 * ⚠️ IT RUNS SITE-SIDE ON PURPOSE (`pretest:browser`), not from the root's
 * `npm run check`. `src/ci-path-filter.test.ts` pins the invariant that nothing
 * outside `site/` depends on anything inside it — the `root` CI filter goes
 * FALSE for a site-only diff, so a root-side guard would simply not run for the
 * very change that breaks this. #219 is the incident behind that rule.
 *
 * PARSED, NOT GREPPED: a specifier is a module-specifier node, so a path
 * mentioned in a comment or inside a string is not an import, and a call split
 * across lines by the formatter is still one node. Same reason
 * `src/ci-path-filter.test.ts` gave up matching text after five missed
 * spellings in five review rounds.
 *
 * ⚠️ AND IT IS A `.ts` RUN BY `tsx`, like `gen-check-pages.ts` beside it, for a
 * reason that would otherwise have shipped green: it IMPORTS the alias list
 * rather than parsing it (a config is a module — importing it yields the real
 * array), and a `.mjs` importing a `.ts` works on the Node 22 in this container
 * and NOT on the Node 20 the `site` job pins. Measured: `node --version` here
 * is v22.22.2, `ci.yml` says `node-version: "20"` in all four setup steps.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ENGINE_ALIAS_IDS } from "../vite.aliases";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(SITE, "src");
const PREFIX = "@engine/";

/** Every `.ts`/`.tsx` under `site/src`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * Module specifiers of one file: static imports, re-exports, and dynamic
 * `import()`. All three are how an `@engine/*` id can reach the bundler.
 */
function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push((n.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

const declared = new Set(ENGINE_ALIAS_IDS);
const files = sources(SRC);
// A scan that quietly resolved to nothing would report "no findings" forever —
// the counter that counts what it ignores. Fail loudly instead.
if (files.length === 0) {
  console.error(
    "check-engine-aliases: found no .ts/.tsx under site/src — the layout moved and this guard is looking at nothing",
  );
  process.exit(1);
}

const findings: string[] = [];
let engineImports = 0;
for (const file of files) {
  for (const spec of specifiers(file)) {
    if (!spec.startsWith(PREFIX)) continue;
    engineImports += 1;
    if (!declared.has(spec)) {
      findings.push(`${relative(SITE, file)}: imports ${spec}`);
    }
  }
}

if (findings.length > 0) {
  console.error(
    `check-engine-aliases: ${String(findings.length)} import(s) of an undeclared @engine/* id.\n` +
      findings.map((f) => `  ${f}`).join("\n") +
      `\n\nAdd the module to ENGINE_MODULES in site/vite.aliases.ts — that ONE list feeds the vite alias,\n` +
      `vitest's optimizeDeps.include, and (through the "@engine/*" wildcard) tsconfig's paths.\n` +
      `Declared: ${[...declared].join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `check-engine-aliases: ${String(engineImports)} @engine/* import(s) across ${String(files.length)} file(s), all declared`,
);
