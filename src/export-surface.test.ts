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
import ts from "typescript";

import * as root from "./test.js";
import * as evalDoor from "./eval-surface.js";
import * as battery from "./battery.js";
import * as fixtures from "./fixtures.js";
import * as hook from "./hook.js";
import * as spec from "./entries/spec.js";
import * as adapter from "./adapter.js";

// Vitest runs this file from src/, so __dirname is src/.
const SRC = __dirname;
const ROOT = resolve(SRC, "..");

const has = (door: object, name: string): boolean => name in door;

test("package.json exports: ./battery is a door, ./linting is gone", () => {
  const raw = readFileSync(join(ROOT, "package.json"), "utf-8");
  assert.match(raw, /"\.\/battery": "\.\/dist\/battery\.js"/);
  assert.match(raw, /"\.\/fixtures": "\.\/dist\/fixtures\.js"/);
  assert.match(raw, /"\.\/spec": "\.\/dist\/entries\/spec\.js"/);
  assert.doesNotMatch(raw, /"\.\/linting"/);
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
    "compareContainment", // folded into compare(before, after)
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
  // Both families are experimental: the hook tests ride on the experimental
  // hook vocabulary, the outcome assertions on `experimental_agent`'s contract.
  for (const name of [
    "loadHook",
    "assertHookAllows",
    "assertHookDenies",
    "assertHookNotices",
    "assertHookSilent",
  ]) {
    assert.ok(
      has(hook, `experimental_${name}`),
      `vigiles/hook exports experimental_${name}`,
    );
    assert.ok(
      !has(hook, name),
      `vigiles/hook no longer exports the bare ${name}`,
    );
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
  for (const name of ["assertAgentOk", "assertAgentErr", "assertAgentResult"]) {
    assert.ok(
      has(spec, `experimental_${name}`),
      `vigiles/spec exports experimental_${name}`,
    );
    assert.ok(
      !has(spec, name),
      `vigiles/spec no longer exports the bare ${name}`,
    );
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
});

test("one form for an assertion over a run: the flat assertX and predicate forms a check.* member covers are gone", () => {
  assert.ok(has(root, "check"));
  assert.ok(has(root, "assertChecks"));
  for (const gone of [
    // predicates → check.* inside assertChecks / fired:
    "usedTool",
    "toolCount",
    "skillResolved",
    "toolUsedWith",
    "outputContains",
    "requestContains",
    "hookBlocked",
    // throwing forms → assertChecks(r, [check.*])
    "assertToolUsed",
    "assertToolNotUsed",
    "assertSkillResolved",
    "assertToolUsedWith",
    "assertOutputContains",
    "assertRequestContains",
    "assertHookFired",
    "assertToolCount",
    "assertToolSequence",
    "assertToolCalls",
    "assertCreated",
    "assertNotCreated",
    "assertHookBlocked",
    "assertHookAllowed",
    // experimental_startServices + await using / finally covers it
    "experimental_withServices",
  ]) {
    assert.ok(!has(root, gone), `the root no longer exports ${gone}`);
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
});

test("shape C: the root is verbs plus one callable check — no flat check function", () => {
  for (const gone of [
    "tool",
    "toolWith",
    "notTool",
    "onlyTools",
    "skill",
    "output",
    "received",
    "hookFired",
    "blocked",
    "allowed",
    "wrote",
    "didNotWrite",
    "mcp",
    "subagent",
    "turns",
    "tokens",
    "inputTokens",
    "outputTokens",
    "cacheTokens",
    "cost",
    "latency",
    "skillContract",
    "fileToolEvents",
    // the last throwing assertions over a run are checks now
    "assertDelivered",
    "assertEgressOnly",
    "assertNoWrite",
    "assertWroteOnly",
  ]) {
    assert.ok(!has(root, gone), `the root no longer exports ${gone}`);
  }
  for (const member of [
    "tool",
    "skill",
    "blocked",
    "delivered",
    "egressOnly",
    "noWrite",
    "wroteOnly",
    "skillContract",
    "tokens",
  ]) {
    assert.ok(member in root.check, `check.${member} is a member`);
  }
});

test("test infrastructure lives on vigiles/fixtures; eval arms on vigiles/eval", () => {
  for (const name of [
    "experimental_stub",
    "experimental_startServices",
    "experimental_dockerRuntime",
  ]) {
    assert.ok(has(fixtures, name), `vigiles/fixtures exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
  assert.ok(has(evalDoor, "experimental_outputStyleArms"));
  assert.ok(!has(root, "experimental_outputStyleArms"));
});

test("the root's runtime exports are exactly the test-author verbs", () => {
  assert.deepEqual(Object.keys(root).sort(), [
    "assertChecks",
    "check",
    "cleanupTmpDir",
    "defineEval",
    "experimental_assertEmittedOk",
    "experimental_eachReply",
    "experimental_emitTool",
    "experimental_parseEmitted",
    "experimental_replyCount",
    "makeTmpDir",
    "recordCheck",
    "runHarnessTest",
    "runHook",
    "runScript",
    "sandboxAvailable",
    "skip",
    "vigilesMatchers",
  ]);
});

test("the adapter registry is the CLI's, not a public door", () => {
  for (const gone of ["ADAPTERS", "getAdapter", "detectAdapter"]) {
    assert.ok(!has(adapter, gone), `vigiles/adapter hides ${gone}`);
  }
  for (const port of ["assertAdapterConformance", "assertAdapterLoadsHooks"]) {
    assert.ok(has(adapter, port), `vigiles/adapter exports ${port}`);
  }
});

// The two harness doors are checked beside their adapters
// (src/adapters/<harness>/), where a test may spell its own harness's name.

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
