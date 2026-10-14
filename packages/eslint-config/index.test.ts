import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsparser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { layers } from "./index.mjs";

/**
 * A repo with three layers in a temp directory, so ESLint's cwd is the fixture
 * while `process.cwd()` stays the vigiles checkout: the situation #303 is about.
 */
const fixture = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "layers-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const LAYOUT = {
  domain: "src/core",
  adapters: "src/adapters/*",
  cliRoot: "src/cli.ts",
  app: "src/*.ts",
  tests: "src/**/*.test.ts",
  io: "src/adapters/*/*.io.ts",
};

const ruleIds = async (
  root: string,
  file: string,
  withRoot: boolean,
): Promise<string[]> => {
  const block = layers({ files: ["src/**/*.ts"], root, ...LAYOUT });
  const settings = { ...block.settings };
  if (!withRoot) delete settings["boundaries/root-path"];
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ["src/**/*.ts"], languageOptions: { parser: tsparser } },
      { ...block, settings },
    ],
  });
  const [result] = await eslint.lintFiles([join(root, file)]);
  return (result?.messages ?? []).map((m) => m.ruleId ?? "fatal");
};

const DOMAIN_IMPORTS_ADAPTER = {
  "src/core/plan.ts":
    'import { layout } from "../adapters/acme/index";\nexport const plan = layout;\n',
  "src/adapters/acme/index.ts": 'export const layout = "acme";\n',
  "src/cli.ts": 'export { plan } from "./core/plan";\n',
};

describe("layers()", () => {
  it("refuses the domain importing an adapter, with ESLint run from another directory", async () => {
    const root = fixture(DOMAIN_IMPORTS_ADAPTER);
    expect(await ruleIds(root, "src/core/plan.ts", true)).toContain(
      "boundaries/dependencies",
    );
  });

  it("control: without root-path the same import passes, which is why layers() pins it", async () => {
    const root = fixture(DOMAIN_IMPORTS_ADAPTER);
    expect(await ruleIds(root, "src/core/plan.ts", false)).not.toContain(
      "boundaries/dependencies",
    );
  });

  it("refuses a file that belongs to no layer, so a new folder cannot sit outside the rules", async () => {
    const root = fixture({
      ...DOMAIN_IMPORTS_ADAPTER,
      "src/lib/helper.ts": "export const helper = 1;\n",
    });
    expect(await ruleIds(root, "src/lib/helper.ts", true)).toContain(
      "boundaries/no-unknown-files",
    );
  });
});

/**
 * The rule layer (`rules` + `ruleset`): every arrow of the hexagonal skill's
 * map, planted once. A rule module may import the domain and nothing else; the
 * set files assemble the rules; only the root imports the set, never one rule;
 * the domain and app never import either. `RULES_LAYOUT` mirrors this repo's
 * own `eslint.config.mjs`.
 */
const RULES_LAYOUT = {
  ...LAYOUT,
  rules: "src/rules/*.ts",
  ruleset: "src/rules/{index,groups}.ts",
};

const RULE_TREE = {
  "src/core/rule.ts": "export type RuleSpec = { readonly id: string };\n",
  "src/core/registry.ts":
    'import { RULES } from "../rules/index";\nexport const n = RULES.length;\n',
  "src/core/one.ts":
    'import { alpha } from "../rules/alpha";\nexport const a = alpha;\n',
  "src/scan.ts":
    'import { alpha } from "./rules/alpha";\nexport const s = alpha;\n',
  "src/adapters/acme/index.ts":
    'import { alpha } from "../../rules/alpha";\nexport const x = alpha;\n',
  "src/rules/alpha.ts":
    'import type { RuleSpec } from "../core/rule";\nexport const alpha: RuleSpec = { id: "alpha" };\n',
  "src/rules/beta.ts":
    'import { alpha } from "./alpha";\nexport const beta = { id: "beta", alpha };\n',
  "src/rules/gamma.ts":
    'import { s } from "../scan";\nexport const gamma = { id: "gamma", s };\n',
  "src/rules/delta.ts":
    'import { x } from "../adapters/acme/index";\nexport const delta = { id: "delta", x };\n',
  "src/rules/epsilon.ts":
    'import { RULES } from "./index";\nexport const epsilon = { id: "e", n: RULES.length };\n',
  "src/rules/alpha.test.ts":
    'import { alpha } from "./alpha";\nimport { s } from "../scan";\nexport const t = [alpha, s];\n',
  "src/rules/groups.ts": "export const GROUPS = { a: {} };\n",
  "src/rules/index.ts":
    'import { alpha } from "./alpha";\nimport { GROUPS } from "./groups";\nexport const RULES = [alpha, GROUPS];\n',
  "src/cli.ts":
    'import { RULES } from "./rules/index";\nimport { alpha } from "./rules/alpha";\nexport const c = [RULES, alpha];\n',
};

/** `boundaries/dependencies` findings per imported specifier, for one file. */
const refusedImports = async (
  root: string,
  file: string,
): Promise<string[]> => {
  const block = layers({ files: ["src/**/*.ts"], root, ...RULES_LAYOUT });
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ["src/**/*.ts"], languageOptions: { parser: tsparser } },
      block,
    ],
  });
  const [result] = await eslint.lintFiles([join(root, file)]);
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "boundaries/dependencies")
    .map((m) => String(m.line));
};

describe("layers() — the rule layer", () => {
  const root = fixture(RULE_TREE);

  it.each([
    ["core ✗→ the rule set", "src/core/registry.ts"],
    ["core ✗→ a rule", "src/core/one.ts"],
    ["app ✗→ a rule", "src/scan.ts"],
    ["adapter ✗→ a rule", "src/adapters/acme/index.ts"],
    ["rule ✗→ another rule", "src/rules/beta.ts"],
    ["rule ✗→ app", "src/rules/gamma.ts"],
    ["rule ✗→ an adapter", "src/rules/delta.ts"],
    ["rule ✗→ the set", "src/rules/epsilon.ts"],
  ])("refuses %s", async (_arrow, file) => {
    expect(await refusedImports(root, file)).toEqual(["1"]);
  });

  it.each([
    ["rule → core (a type import is an import too)", "src/rules/alpha.ts"],
    ["the set → rules and groups", "src/rules/index.ts"],
    ["a rule's own test → its rule and app code", "src/rules/alpha.test.ts"],
  ])("allows %s", async (_arrow, file) => {
    expect(await refusedImports(root, file)).toEqual([]);
  });

  it("the root may import the set, and not one rule directly", async () => {
    expect(await refusedImports(root, "src/cli.ts")).toEqual(["2"]);
  });
});

describe("how paperlint reaches this file", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it("ships in vigiles' npm package, beside a README that says it is private", () => {
    const out = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repo, encoding: "utf8" },
    );
    const [packed]: [{ files: { path: string }[] }] = JSON.parse(out);
    expect(packed.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "packages/eslint-config/index.mjs",
        "packages/eslint-config/README.md",
      ]),
    );
  });

  it("is not part of vigiles' API: no entry in exports points at it", () => {
    const pkg: { exports: Record<string, unknown> } = JSON.parse(
      readFileSync(join(repo, "package.json"), "utf8"),
    );
    expect(JSON.stringify(pkg.exports)).not.toContain("eslint-config");
  });
});
