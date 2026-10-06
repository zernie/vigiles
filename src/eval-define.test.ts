/**
 * `defineEval` — the description an eval file exports.
 *
 * 🔴 NOTHING HERE IMPORTS A `*.eval.*` FILE. That import is the defect under
 * repair, and doing it to check the repair would be paying to ask. The runtime
 * cases use INERT STAND-IN modules written into a temp dir: same shape, and the
 * "spend" is a marker file instead of a model.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  declaredEval,
  defineEval,
  isEvalDefinition,
  moduleDefault,
  ranAsEntry,
  ranAsEntryRefusal,
  EVAL_KINDS,
} from "./eval-define.js";

const DIST = resolve("dist");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vigiles-define-"));
}

// --- the value ---------------------------------------------------------------

test("a definition is a plain branded value — building one starts nothing", () => {
  const def = defineEval({ measure: { task: "t", checks: [] } });
  assert.ok(isEvalDefinition(def));
  const d = declaredEval(def);
  assert.deepEqual(d, {
    ok: true,
    kind: "measure",
    spec: { task: "t", checks: [] },
  });
});

test("a runner can answer WHAT a file declares without running it — the reason this is data and not a callback", () => {
  // Under `defineEval({ run: async ({measure}) => … })` every case below is
  // undecidable without executing the callback, and the loud report on an
  // unmigrated file — the whole discovery path — becomes impossible.
  assert.deepEqual(declaredEval(defineEval({})), {
    ok: false,
    why: "declares-nothing",
  });
  assert.deepEqual(declaredEval(undefined), {
    ok: false,
    why: "not-a-definition",
  });
  assert.deepEqual(declaredEval({ measure: { task: "t", checks: [] } }), {
    ok: false,
    why: "not-a-definition", // a bare object is not a declaration
  });
  const several = declaredEval(
    defineEval({
      measure: { task: "t", checks: [] },
      measureArms: { arms: {}, task: "t", checks: [] },
    } as never),
  );
  assert.equal(
    !several.ok && several.why === "declares-several"
      ? several.kinds.join(",")
      : "(not the declares-several case)",
    "measure,measureArms",
  );
});

test("moduleDefault reaches through CJS interop — the three shapes an eval file can compile to", () => {
  const def = defineEval({ measure: { task: "t", checks: [] } });
  // real ESM: `mod.default` is the definition
  assert.equal(moduleDefault({ default: def }), def);
  // `module.exports = defineEval(…)` in a .cjs: import() puts it at `.default`
  assert.equal(moduleDefault({ default: def, __esModule: undefined }), def);
  // `export default …` in a .ts transpiled to CJS: one level deeper
  assert.equal(
    moduleDefault({ default: { __esModule: true, default: def } }),
    def,
  );
  // The quiet half — it must not invent a definition, and must not skip PAST a
  // real one that happens to carry its own `default` field.
  assert.equal(moduleDefault({ default: 42 }), 42);
  assert.equal(moduleDefault({}), undefined);
  assert.equal(moduleDefault(undefined), undefined);
  const withOwnDefault = defineEval({
    measure: { task: "t", checks: [] },
    // a field named `default` on the definition itself
  }) as unknown as { default?: unknown };
  withOwnDefault.default = "not a definition";
  assert.equal(moduleDefault({ default: withOwnDefault }), withOwnDefault);
});

test("every declarable measurement is in EVAL_KINDS", () => {
  // The one list. A key added to the type but not here is a measurement the
  // runner would silently ignore — declared, never run, exit 0.
  assert.deepEqual(
    [...EVAL_KINDS].sort(),
    [
      "measure",
      "measureArms",
      "measureSelectionMatrix",
      "measureTriggerRate",
      "runEval",
    ].sort(),
  );
});

// --- the entry-point refusal -------------------------------------------------

test("ranAsEntry: node pointed at an eval file, and the three ways it is not", () => {
  assert.equal(ranAsEntry("/repo/examples/x.eval.mjs"), true);
  assert.equal(ranAsEntry("/repo/x.eval.ts"), true);
  assert.equal(ranAsEntry("C:\\repo\\x.eval.mjs"), true); // windows separators
  // The quiet half — every legitimate way an eval module gets loaded:
  assert.equal(ranAsEntry("/repo/dist/eval-entry.js"), false); // vigiles eval
  assert.equal(ranAsEntry(undefined), false); // node -e 'import(…)'
  assert.equal(
    ranAsEntry("/repo/node_modules/vitest/dist/workers/forks.js"),
    false,
  );
  assert.equal(ranAsEntry("/repo/x.harness.mjs"), false); // a free harness script
  // `.eval.` has to be the LAST segment before the extension — a loose pattern
  // would send a deterministic test to the paid runner's refusal.
  assert.equal(ranAsEntry("/repo/x.eval.test.ts"), false);
  assert.equal(ranAsEntry("/repo/x.eval.d.ts"), false);
  assert.equal(ranAsEntry("/repo/eval.mjs"), false);
  assert.equal(ranAsEntry("/repo/x.eval.mjs.json"), false);
});

test("the refusal names the file, the command to run and the free syntax check", () => {
  const m = ranAsEntryRefusal("/repo/examples/x.eval.mjs");
  assert.match(m, /node x\.eval\.mjs/); // what you typed
  assert.match(m, /vigiles eval \/repo\/examples\/x\.eval\.mjs/); // what to type
  assert.match(m, /node --check/); // how to check syntax for free
});

// --- the runtime property, on inert stand-ins --------------------------------

/** A stand-in whose "spend" writes a marker file. Never a real eval file. */
function standin(dir: string, name: string, body: string): string {
  const f = join(dir, name);
  writeFileSync(f, body);
  return f;
}

const PAY = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "fake-pay.mjs");
  writeFileSync(
    f,
    `import { writeFileSync } from "node:fs";\n` +
      `import { join, dirname } from "node:path";\n` +
      `import { fileURLToPath } from "node:url";\n` +
      `export function pay() {\n` +
      `  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "SPENT"), "spent");\n` +
      `  return { n: 1 };\n` +
      `}\n`,
  );
  return f;
};

test("THE CENTRAL CLAIM: importing the new shape spends nothing; importing the old shape spends", () => {
  // This is the test that FAILS on the old shape, and it fails by SPENDING —
  // which is why the stand-in's spend is a file write. Reproduced 2026-08-18
  // against the real guard: under `node -e` there is no process.argv[1], so
  // `foreignRunner(undefined)` is null and `refuseUnderForeignRunner` is silent.
  const dir = tmp();
  PAY(dir);

  // The OLD shape: the work is the module body.
  standin(
    dir,
    "old.standin.mjs",
    `import { pay } from "./fake-pay.mjs";\nconst report = await pay();\nexport default report;\n`,
  );
  execFileSync("node", [
    "-e",
    `await import("${join(dir, "old.standin.mjs")}")`,
  ]);
  assert.equal(
    existsSync(join(dir, "SPENT")),
    true,
    "the old shape spends on import",
  );

  // The NEW shape: the work is DESCRIBED, and the description names the same
  // payment as data. Importing it must produce a value and nothing else.
  const dir2 = tmp();
  PAY(dir2);
  standin(
    dir2,
    "new.standin.mjs",
    `import { pay } from "./fake-pay.mjs";\n` +
      `import { defineEval } from "${DIST}/test.js";\n` +
      `export default defineEval({ measure: { task: String(typeof pay), checks: [] } });\n`,
  );
  const out = execFileSync("node", [
    "-e",
    `const m = await import("${join(dir2, "new.standin.mjs")}");` +
      `const { declaredEval } = await import("${DIST}/eval-define.js");` +
      `console.log(JSON.stringify(declaredEval(m.default)));`,
  ]);
  assert.equal(
    existsSync(join(dir2, "SPENT")),
    false,
    "importing a description must spend nothing",
  );
  const declared = JSON.parse(out.toString()) as { kind?: string };
  assert.equal(declared.kind, "measure");
});

test("`node x.eval.mjs` fails LOUDLY instead of doing nothing", () => {
  // The silent no-op would be the same class of defect in a new place: every
  // old file documented itself as `node <file>`, and that habit outlives the
  // migration.
  const dir = tmp();
  const f = standin(
    dir,
    "silent.eval.mjs",
    `import { defineEval } from "${DIST}/test.js";\n` +
      `export default defineEval({ measure: { task: "t", checks: [] } });\n`,
  );
  const r = spawnSync("node", [f], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "a no-op exit 0 is the defect this prevents");
  assert.match(r.stderr, /no longer runs this eval/);
  assert.match(r.stderr, /vigiles eval/);

  // …and the free syntax check people SHOULD be using still works on it.
  assert.equal(spawnSync("node", ["--check", f]).status, 0);
});
