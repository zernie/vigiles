/**
 * The ESLint inventory is the ONE place vigiles asks ESLint which rules exist
 * and which are on. These tests pin the two things that went wrong when three
 * callers asked three different ways (#351, #352, #371):
 *
 *   - a config that fails to load is a reported failure, never an empty list;
 *   - `generate types`, `enforce()` verification and the routing catalog see
 *     the SAME rule set for the same repo.
 *
 * The integration cases run the real installed ESLint against tmp projects (no
 * mock); the wire parser is tested pure.
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseEslintInventory } from "./eslint-inventory.js";
import { checkLinterRule, eslintInventory } from "./linters.js";
import { generateTypes } from "./generate-types.js";
import { enumerateEslintCatalog } from "./rule-catalog.js";
import { makeEslintProject, makeTmpDir, cleanupTmpDir } from "./test-utils.js";

describe("parseEslintInventory (pure)", () => {
  it("reads each answer the probe can give", () => {
    assert.deepEqual(parseEslintInventory('{"kind":"not-installed"}'), {
      kind: "not-installed",
    });
    assert.deepEqual(parseEslintInventory('{"kind":"no-config"}'), {
      kind: "no-config",
    });
    assert.deepEqual(
      parseEslintInventory('{"kind":"failed","error":"boom"}\n'),
      { kind: "failed", error: "boom" },
    );
  });

  it("separates a config that switches nothing on from one with rules", () => {
    const wire = (rules: Record<string, string>) =>
      JSON.stringify({
        kind: "loaded",
        core: ["no-console"],
        plugins: {},
        rules,
        mentioned: Object.keys(rules),
        complete: true,
      });
    assert.equal(
      parseEslintInventory(wire({ "no-console": "off" })).kind,
      "failed",
      "an off severity is not on the wire: only enabled/disabled are",
    );
    assert.equal(
      parseEslintInventory(wire({ "no-console": "disabled" })).kind,
      "empty",
    );
    assert.equal(
      parseEslintInventory(wire({ "no-console": "enabled" })).kind,
      "loaded",
    );
  });

  it("reads only the last line (a config may print on import)", () => {
    assert.equal(
      parseEslintInventory('hello from the config\n{"kind":"no-config"}').kind,
      "no-config",
    );
  });

  it("turns an unreadable answer into a failure that quotes it", () => {
    const inv = parseEslintInventory("{ not json");
    assert.equal(inv.kind, "failed");
    assert.match(inv.kind === "failed" ? inv.error : "", /\{ not json/);
    assert.equal(parseEslintInventory('{"kind":"loaded"}').kind, "failed");
  });
});

const dirs: string[] = [];
const project = (config: string): string => {
  const dir = makeEslintProject(config);
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  dirs.forEach((d) => {
    cleanupTmpDir(d);
  });
});

describe("eslintInventory: what loaded and what did not", () => {
  it("reports a config that throws on import, and generate types says so", () => {
    const dir = project(
      'throw new Error("config needs dist/, which is not built");\n',
    );
    const inv = eslintInventory(dir);
    assert.equal(inv.kind, "failed");
    assert.match(inv.kind === "failed" ? inv.error : "", /not built/);

    const types = generateTypes({ basePath: dir, fileGlobs: [] });
    assert.equal(
      types.linters.find((l) => l.linter === "eslint"),
      undefined,
    );
    assert.deepEqual(
      types.unreadable.map((u) => u.linter),
      ["eslint"],
    );
    assert.match(types.unreadable[0]?.reason ?? "", /not built/);
    // A failed load is not "set nowhere": verification cannot know.
    assert.equal(checkLinterRule("eslint/no-console", dir).enabled, "unknown");
  });

  it("reads a config that switches nothing on as empty, not as a failure", () => {
    const dir = project(
      'export default [{ rules: { "no-console": "off" } }];\n',
    );
    assert.equal(eslintInventory(dir).kind, "empty");
    const types = generateTypes({ basePath: dir, fileGlobs: [] });
    assert.deepEqual(types.unreadable, []);
    assert.equal(
      types.linters.find((l) => l.linter === "eslint"),
      undefined,
    );
  });

  it("tells a project without ESLint from one without a config", () => {
    const bare = makeTmpDir("eslint-bare");
    dirs.push(bare);
    assert.equal(eslintInventory(bare).kind, "not-installed");

    const dir = project("export default [];\n");
    rmSync(join(dir, "eslint.config.mjs"));
    assert.equal(eslintInventory(dir).kind, "no-config");
    // No config: ESLint runs the rule nowhere.
    assert.equal(
      checkLinterRule("eslint/no-console", dir).enabled,
      "unconfigured",
    );
    assert.deepEqual(
      generateTypes({ basePath: dir, fileGlobs: [] }).unreadable,
      [],
    );
  });
});

describe("eslintInventory: one rule set for every caller", () => {
  it("gives generate types, enforce() verification and the catalog the same enabled set", () => {
    const rule = 'meta: { type: "problem" }, create() { return {}; }';
    const dir = project(`
const kb = { rules: { "real-rule": { ${rule} } } };
export default [
  { rules: { "no-console": "error", "no-debugger": "off" } },
  { files: ["src/**/*.ts"], plugins: { kb }, rules: { "kb/real-rule": "error", eqeqeq: "error" } },
  { files: ["docs/**/*.md"], rules: { "no-eval": "warn" } },
];
`);
    const fromTypes = new Set(
      generateTypes({ basePath: dir, fileGlobs: [] }).linters.find(
        (l) => l.linter === "eslint",
      )?.rules,
    );
    assert.deepEqual([...fromTypes].sort(), [
      "eqeqeq",
      "kb/real-rule",
      "no-console",
      "no-eval",
    ]);
    fromTypes.forEach((id) => {
      assert.equal(
        checkLinterRule(`eslint/${id}`, dir).enabled,
        "enabled",
        `${id}: generate types lists it, so verification must see it on`,
      );
    });
    const catalog = enumerateEslintCatalog(dir);
    assert.deepEqual(
      new Set(catalog?.rules.filter((r) => r.enabled).map((r) => r.id)),
      fromTypes,
    );
    // And a rule outside the set is not "enabled" for any of them.
    assert.equal(
      checkLinterRule("eslint/no-debugger", dir).enabled,
      "disabled",
    );
    assert.equal(checkLinterRule("eslint/kb/no-such-rule", dir).exists, false);
  });

  it("reaches a block whose glob it cannot synthesize through a real file", () => {
    // `[!_]` excludes `_`, and the glob synthesis picks `_`: only the project's
    // own `src/a.ts`, probed as the representative of (src, .ts), reaches it.
    const dir = project(
      'export default [{ files: ["src/[!_]*.ts"], rules: { eqeqeq: "error" } }];\n',
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    assert.equal(checkLinterRule("eslint/eqeqeq", dir).enabled, "enabled");
  });
});
