/**
 * Corpus gate: every `*.eval.*` file in this repository is a DESCRIPTION.
 *
 * 🔴 STATIC ONLY — nothing here imports or runs an eval file. That import is the
 * defect under repair; the property is checked from the parsed source instead,
 * with TypeScript's own parser rather than a regex, because "is this `await` at
 * the top level or inside a function?" is a question about the syntax tree and a
 * regex has no way to ask it.
 *
 * Three properties, and each would have FAILED on every one of these files
 * before this change:
 *
 *   1. no `await` in the module body — the five paid runners all return
 *      promises, so a module that awaits nothing cannot have run one;
 *   2. no import of a paid runner at all — after the migration the paid subpath
 *      is not part of an eval file's vocabulary;
 *   3. a `defineEval({…})` default export declaring EXACTLY ONE measurement.
 *
 * None is the whole property alone. (1) without (2) would pass a file that
 * called a runner and dropped the promise; (2) without (1) would pass a file
 * that awaited some other expensive thing; and (3) catches a typo'd key at test
 * time rather than at the moment somebody is trying to spend money.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { globSync } from "glob";
import ts from "typescript";

import { EVAL_KINDS } from "./eval-define.js";

/** The runners that spend. An eval file must not name any of them. */
const PAID = [
  "runEval",
  "measure",
  "measureArms",
  "measureTriggerRate",
  "measureSelectionMatrix",
  "judge",
] as const;

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
}

/** `await` reached without crossing into a function body. Pure, exported shape. */
export function topLevelAwaits(sf: ts.SourceFile): string[] {
  const found: string[] = [];
  const walk = (n: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isClassDeclaration(n)
    )
      return; // a promise created in there is created when IT is called
    if (ts.isAwaitExpression(n))
      found.push(n.getText().split("\n")[0]?.slice(0, 60) ?? "");
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return found;
}

/** Names imported from anywhere, as written. Pure. */
export function importedNames(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamedImports(b))
      for (const e of b.elements) out.push(e.propertyName?.text ?? e.name.text);
  }
  return out;
}

/** The `defineEval(…)` argument object of a default export, if there is one. */
function defineEvalArg(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const s of sf.statements) {
    if (
      ts.isExportAssignment(s) &&
      s.isExportEquals !== true &&
      ts.isCallExpression(s.expression) &&
      s.expression.expression.getText() === "defineEval"
    ) {
      const a = s.expression.arguments[0];
      return a && ts.isObjectLiteralExpression(a) ? a : null;
    }
    // `.cjs` files say `module.exports = defineEval({…})`.
    if (
      ts.isExpressionStatement(s) &&
      ts.isBinaryExpression(s.expression) &&
      ts.isCallExpression(s.expression.right) &&
      s.expression.right.expression.getText() === "defineEval"
    ) {
      const a = s.expression.right.arguments[0];
      return a && ts.isObjectLiteralExpression(a) ? a : null;
    }
  }
  return null;
}

/** Does the module default-export a `defineEval(…)` call? Pure. */
export function defaultExportsDefineEval(sf: ts.SourceFile): boolean {
  return defineEvalArg(sf) !== null;
}

/**
 * The measurement keys a `defineEval({…})` literal declares. Pure.
 *
 * Catching "exactly one" HERE and not only at run time is the point: a typo'd
 * `measureTrigerRate:` is a file the runner would call "declares nothing" — a
 * correct verdict, delivered at the moment somebody is trying to spend money.
 */
export function declaredKeys(sf: ts.SourceFile): string[] {
  const arg = defineEvalArg(sf);
  if (arg === null) return [];
  return arg.properties
    .map((pr) => pr.name?.getText().replace(/^["']|["']$/g, "") ?? "")
    .filter((n) => (KINDS as readonly string[]).includes(n));
}

/** The five measurements, mirrored from `EVAL_KINDS` (asserted below). */
const KINDS = [
  "runEval",
  "measure",
  "measureArms",
  "measureTriggerRate",
  "measureSelectionMatrix",
] as const;

const FILES = globSync("**/*.eval.{mjs,cjs,js,mts,cts,ts}", {
  ignore: ["node_modules/**", "dist/**"],
  dot: true,
}).sort();

describe("every eval file in this repo describes its eval", () => {
  test("there are eval files to check", () => {
    // A glob that silently matches nothing turns this whole gate green.
    assert.ok(FILES.length >= 19, `only found ${String(FILES.length)}`);
  });

  test.each(FILES)("%s", (f) => {
    const src = readFileSync(f, "utf8");
    const sf = parse(f, src);
    assert.ok(
      defaultExportsDefineEval(sf),
      `${f}: must \`export default defineEval({…})\``,
    );
    assert.deepEqual(
      topLevelAwaits(sf),
      [],
      `${f}: the module body awaits — importing this file does work`,
    );
    assert.deepEqual(
      declaredKeys(sf).length,
      1,
      `${f}: must declare EXACTLY one measurement (found ${JSON.stringify(declaredKeys(sf))})`,
    );
    const paid = importedNames(sf).filter((n) =>
      (PAID as readonly string[]).includes(n),
    );
    assert.deepEqual(
      paid,
      [],
      `${f}: imports a paid runner (${paid.join(", ")})`,
    );
    // Free, and the thing people should reach for instead of `import()`.
    execFileSync("node", ["--check", f], { stdio: "pipe" });
  });
});

// --- fires on a planted defect ------------------------------------------------
//
// "Silent on a clean corpus" alone is indistinguishable from dead code. These
// plant each half of the old shape and assert the checks catch it.

describe("the gate fires on the shape it replaced", () => {
  test("a top-level await is caught, and one inside a function is NOT", () => {
    const bad = parse(
      "x.eval.mjs",
      `import { measure } from "vigiles/eval";\nconst report = await measure({});\n`,
    );
    assert.equal(topLevelAwaits(bad).length, 1);

    // The quiet half: `assert` and `skipIf` are allowed to be async — that is
    // the entire point of moving the work into them.
    const good = parse(
      "x.eval.mjs",
      `export default defineEval({ measure: {}, assert: async (r) => { await check(r); } });\n`,
    );
    assert.deepEqual(topLevelAwaits(good), []);
  });

  test("a paid import is caught, and the free ones are not", () => {
    assert.deepEqual(
      importedNames(
        parse(
          "x.eval.mjs",
          `import { measureTriggerRate, formatTriggerRateReport } from "../../dist/eval.js";\n`,
        ),
      ).filter((n) => (PAID as readonly string[]).includes(n)),
      ["measureTriggerRate"],
    );
    assert.deepEqual(
      importedNames(
        parse(
          "x.eval.mjs",
          `import { defineEval, skillResolved } from "vigiles";\nimport { assertRates } from "vigiles/eval";\n`,
        ),
      ).filter((n) => (PAID as readonly string[]).includes(n)),
      [],
    );
  });

  test("a file that runs its eval at top level fails the default-export check too", () => {
    assert.equal(
      defaultExportsDefineEval(
        parse(
          "x.eval.mjs",
          `const r = await measure({});\nexport default r;\n`,
        ),
      ),
      false,
    );
    assert.equal(
      defaultExportsDefineEval(
        parse("x.eval.mjs", `export default defineEval({ measure: {} });\n`),
      ),
      true,
    );
  });
});

test("the key list here mirrors the one the runner reads", () => {
  // Two lists of the same five names is how a sixth measurement gets declared,
  // shipped, and silently never checked.
  assert.deepEqual([...KINDS].sort(), [...EVAL_KINDS].sort());
});

test("the exactly-one check fires on a typo and on a double declaration", () => {
  const one = parse(
    "x.eval.mjs",
    `export default defineEval({ measure: {} });\n`,
  );
  assert.deepEqual(declaredKeys(one), ["measure"]);
  // A typo is not a measurement — the file would declare nothing.
  const typo = parse(
    "x.eval.mjs",
    `export default defineEval({ measureTrigerRate: {} });\n`,
  );
  assert.deepEqual(declaredKeys(typo), []);
  const two = parse(
    "x.eval.mjs",
    `export default defineEval({ measure: {}, runEval: {} });\n`,
  );
  assert.deepEqual(declaredKeys(two), ["measure", "runEval"]);
  // `module.exports = defineEval({…})` — the .cjs spelling — is seen too.
  const cjs = parse(
    "x.eval.cjs",
    `module.exports = defineEval({ measureTriggerRate: {} });\n`,
  );
  assert.deepEqual(declaredKeys(cjs), ["measureTriggerRate"]);
});
