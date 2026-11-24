/**
 * The package's doors: which subpaths exist, and which door a name lives behind.
 *
 * One home per name: a name moved to the entry of the reader who uses it, and the
 * old door no longer answers for it. These are runtime checks over the source
 * barrels (types have no runtime presence; the API reports in `api-surface/`
 * cover them).
 *
 * The structural rule is the last test: no module imports the root barrel
 * (`src/entries/index.ts`). An entry that re-exported the root would make every name the
 * root holds reachable from two doors again, and an internal module that
 * imported it would pull the whole testing surface into whatever loads it.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

import * as root from "./entries/index.js";
import * as evalDoor from "./entries/eval.js";
import * as fixtures from "./entries/fixtures.js";
import * as hook from "./entries/hook.js";
import * as hookTesting from "./entries/hook/testing.js";
import * as spec from "./entries/spec.js";
import * as adapter from "./entries/harness/kit.js";

// Vitest runs this file from src/, so __dirname is src/.
const SRC = __dirname;
const ROOT = resolve(SRC, "..");

const has = (door: object, name: string): boolean => name in door;

test("package.json exports: every entry module mirrors its export path under src/entries", () => {
  const pkg: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf-8"),
  );
  assert.ok(typeof pkg === "object" && pkg !== null && "exports" in pkg);
  const map = pkg.exports;
  assert.ok(typeof map === "object" && map !== null);
  const MATCHER_ENTRIES = new Set(["./vitest", "./jest"]);
  for (const [key, value] of Object.entries(map)) {
    if (MATCHER_ENTRIES.has(key)) continue;
    const mirrored = key === "." ? "index" : key.slice(2);
    assert.equal(value, `./dist/entries/${mirrored}.js`, key);
  }
  // v51 moved these; a flat spelling of any of them would be an alias.
  for (const gone of ["linting", "battery", "hook-test", "adapter"]) {
    assert.ok(!(`./${gone}` in map), `./${gone} is gone (v51: no aliases)`);
  }
  const nested = Object.keys(map).filter((k) => k.startsWith("./harness/"));
  assert.equal(nested.length, 3, "the harness family lives under ./harness/");
  assert.ok(
    Object.keys(map).every((k) => k.split("/").length <= 3),
    "at most two path levels",
  );
});

test("the guard battery lives on vigiles/hook/testing, not the root", () => {
  for (const name of [
    "runGuardrail",
    "guardrailHolds",
    "disasters",
    "experimental_crossRepo",
    "DISASTER_CATALOG",
    "experimental_hookState",
    "experimental_verifyPluginGuards",
  ]) {
    assert.ok(has(hookTesting, name), `vigiles/hook/testing exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
});

test("v53: one guardrail runner and a check; the parsers left vigiles/hook", () => {
  // The battery's "result + throw" pair became a runner and a check, and the
  // two generators became fields of the disaster-set value (`disasters()`).
  for (const gone of [
    "verifyGuardrail",
    "assertGuardrail",
    "experimental_alternateSpellings",
    "experimental_harmlessTwins",
  ])
    for (const door of [root, hook, hookTesting])
      assert.ok(!has(door, gone), `${gone} is gone`);
  // #518: internal now; a hook reads the parsed `e.command` / `e.path`.
  for (const gone of [
    "parseShellCommand",
    "parseFilePath",
    "leafCommandsNormalized",
  ])
    for (const door of [root, hook, hookTesting])
      assert.ok(!has(door, gone), `${gone} is internal`);
});

test("the eval-report readers live on vigiles/eval, folded", () => {
  for (const name of [
    "compare",
    "assertRates",
    "assertImproves",
    "assertNoRegression",
  ]) {
    assert.ok(has(evalDoor, name), `vigiles/eval exports ${name}`);
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
  // folded in v52: a trigger-rate report gates through assertRates, and the
  // baseline file is assertNoRegression's `baseline` option
  for (const gone of ["assertTriggerRate", "readBaseline", "writeBaseline"]) {
    assert.ok(!has(evalDoor, gone), `vigiles/eval no longer exports ${gone}`);
    assert.ok(!has(root, gone), `the root does not export ${gone}`);
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

test("compiled-hook tests live on vigiles/hook/testing, never on vigiles/hook; subagent outcomes on vigiles/spec", () => {
  // Both families are experimental: the hook tests ride on the experimental
  // hook vocabulary, the outcome assertions on `experimental_agent`'s contract.
  // The hook tests are OFF `vigiles/hook` because that entry is a compiled hook's
  // only import: a loader there is a loader inside every hook (Codex P1, #510).
  for (const name of [
    "experimental_loadHook",
    "experimental_assertHookAllows",
    "experimental_assertHookDenies",
    "experimental_assertHookNotices",
    "experimental_assertHookSilent",
    "runHookProgram",
  ]) {
    assert.ok(has(hookTesting, name), `vigiles/hook/testing exports ${name}`);
    assert.ok(!has(hook, name), `vigiles/hook does not export ${name}`);
    assert.ok(!has(root, name), `the root does not export ${name}`);
  }
  // only the throwing form that narrows stays an assertion; the error track
  // and the predicate are `check.experimental_agentResult` (v52)
  assert.ok(has(spec, "experimental_assertAgentOk"));
  for (const name of ["assertAgentOk", "assertAgentErr", "assertAgentResult"]) {
    assert.ok(
      !has(spec, name),
      `vigiles/spec no longer exports the bare ${name}`,
    );
    assert.ok(!has(root, name), `the root no longer exports ${name}`);
  }
  for (const name of [
    "experimental_assertAgentErr",
    "experimental_assertAgentResult",
  ]) {
    assert.ok(!has(spec, name), `vigiles/spec no longer exports ${name}`);
    assert.ok(!has(root, name), `the root does not export ${name}`);
  }
  assert.ok("experimental_agentResult" in root.check);
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
    // experimental reply checks folded into members (v52)
    "experimental_eachReply",
    "experimental_replyCount",
  ]) {
    assert.ok(!has(root, gone), `the root no longer exports ${gone}`);
  }
  for (const member of [
    "tool",
    "skill",
    "hookFired",
    "delivered",
    "egressOnly",
    "writes",
    "skillContract",
    "tokens",
  ]) {
    assert.ok(member in root.check, `check.${member} is a member`);
  }
  // a member takes options instead of spawning a sibling (v52, #518)
  for (const folded of [
    "toolWith",
    "notTool",
    "blocked",
    "allowed",
    "wrote",
    "didNotWrite",
    "noWrite",
    "wroteOnly",
  ]) {
    assert.ok(!(folded in root.check), `check.${folded} is folded away`);
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
    "experimental_emitTool",
    "experimental_parseEmitted",
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
    assert.ok(!has(adapter, gone), `vigiles/harness/kit hides ${gone}`);
  }
  for (const port of ["assertAdapterConformance", "assertAdapterLoadsHooks"]) {
    assert.ok(has(adapter, port), `vigiles/harness/kit exports ${port}`);
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

test("no module imports the root barrel (src/entries/index.ts)", () => {
  const rootBarrel = join(SRC, "entries", "index.ts");
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
