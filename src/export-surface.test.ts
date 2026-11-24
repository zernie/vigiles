/**
 * The package's doors: which subpaths exist, and which door a name lives behind.
 *
 * One home per name: a name moved to the entry of the reader who uses it, and the
 * old door no longer answers for it. These are runtime checks over the source
 * barrels (types have no runtime presence; the API reports in `api-surface/`
 * cover them).
 *
 * The structural rule is the last test: no module imports the root barrel
 * (`src/test.ts`). An entry that re-exported the root would make every name the
 * root holds reachable from two doors again, and an internal module that
 * imported it would pull the whole testing surface into whatever loads it.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import * as root from "./test.js";
import * as evalDoor from "./eval-surface.js";
import * as battery from "./battery.js";
import * as hook from "./hook.js";
import * as spec from "./entries/spec.js";
import * as claudeCode from "./claude-code.js";
import * as codex from "./codex.js";
import * as adapter from "./adapter.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SRC, "..");

const has = (door: object, name: string): boolean => name in door;

test("package.json exports: ./battery is a door, ./linting is gone", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    exports: Record<string, unknown>;
  };
  assert.equal(pkg.exports["./battery"], "./dist/battery.js");
  assert.equal(pkg.exports["./spec"], "./dist/entries/spec.js");
  assert.equal("./linting" in pkg.exports, false);
});

test("the guard battery lives on vigiles/battery, not the root", () => {
  for (const name of [
    "assertGuardrail",
    "verifyGuardrail",
    "DISASTER_CATALOG",
    "experimental_alternateSpellings",
    "experimental_harmlessTwins",
    "experimental_hookState",
    "experimental_verifyPluginGuards",
  ]) {
    assert.ok(has(battery, name), `vigiles/battery exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
});

test("the eval-report readers live on vigiles/eval, folded", () => {
  for (const name of [
    "compare",
    "assertRates",
    "assertTriggerRate",
    "assertImproves",
    "assertNoRegression",
    "readBaseline",
    "writeBaseline",
  ]) {
    assert.ok(has(evalDoor, name), `vigiles/eval exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
  for (const gone of [
    "compareArms",
    "diffReports",
    "compareContainment",
    "improvement",
    "significantlyBeats",
    "reliable",
    "assertReliable",
    "assertSignificant",
    "experimental_verdict",
  ]) {
    assert.ok(!has(root, gone), `the root no longer exports ${gone}`);
    assert.ok(!has(evalDoor, gone), `vigiles/eval does not export ${gone}`);
  }
});

test("compiled-hook tests live on vigiles/hook; subagent outcomes on vigiles/spec", () => {
  for (const name of [
    "loadHook",
    "assertHookAllows",
    "assertHookDenies",
    "assertHookNotices",
    "assertHookSilent",
  ]) {
    assert.ok(has(hook, name), `vigiles/hook exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
  for (const name of ["assertAgentOk", "assertAgentErr", "assertAgentResult"]) {
    assert.ok(has(spec, name), `vigiles/spec exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
});

test("one runHarnessTest; the removed and hidden names are gone from the root", () => {
  assert.ok(has(root, "runHarnessTest"));
  for (const gone of [
    "runHarness",
    "withHarness",
    "assertNoEgress",
    "propertyHook",
    "checkPromptDiversity",
    "assertPromptDiversity",
    "parseToolCalls",
    "parseClaudeRun",
    "formatEvalReport",
    "formatTriggerRateReport",
    "formatContainment",
    "experimental_formatPluginGuardReport",
    "checkReportToJUnit",
    "diffToJUnit",
    "formatCheckReport",
    "formatGuardrailReport",
  ]) {
    assert.ok(!has(root, gone), `the root no longer exports ${gone}`);
  }
  assert.ok(has(claudeCode, "parseToolCalls"));
  assert.ok(!has(claudeCode, "formatSelectionReport"));
});

test("Claude Code constants are fields of claudeCodeAdapter, the ports reached through adapters", () => {
  for (const gone of [
    "claudeCodeBuiltinAgentTools",
    "claudeCodeSideEffectingTools",
    "claudeCodeLayout",
    "claudeCodeDriver",
  ]) {
    assert.ok(!has(claudeCode, gone), `vigiles/claude-code hides ${gone}`);
  }
  for (const gone of ["codexLayout", "codexDriver", "codexDialect"]) {
    assert.ok(!has(codex, gone), `vigiles/codex hides ${gone}`);
  }
  for (const gone of ["ADAPTERS", "getAdapter", "detectAdapter"]) {
    assert.ok(!has(adapter, gone), `vigiles/adapter hides ${gone}`);
  }
});

/** Every non-test `.ts`/`.mts` file under `src/`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.m?ts$/.test(name) && !/\.test\.m?ts$/.test(name) ? [p] : [];
  });
}

/** The module specifiers a file imports or re-exports. */
function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
  );
  return sf.statements.flatMap((s) =>
    (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
    s.moduleSpecifier !== undefined &&
    ts.isStringLiteral(s.moduleSpecifier)
      ? [s.moduleSpecifier.text]
      : [],
  );
}

test("no module imports the root barrel (src/test.ts)", () => {
  const rootBarrel = join(SRC, "test.ts");
  const offenders = sourceFiles(SRC).filter((file) =>
    specifiers(file).some(
      (s) =>
        s.startsWith(".") &&
        resolve(dirname(file), s.replace(/\.js$/, ".ts")) === rootBarrel,
    ),
  );
  assert.deepEqual(
    offenders.map((f) => relative(ROOT, f)),
    [],
    "import from the module that declares the name, not from the root barrel",
  );
});
