/**
 * The ESLint kit: the plugin a rule id names, the flat config written for one
 * reading, the report read back, and the install plan it hands the steps.
 */
import { describe, expect, it } from "vitest";
import {
  eslintConfigModule,
  eslintKit,
  parseEslintReport,
  pluginOf,
} from "./eslint.js";

const scope = { files: ["src/**/*.js"], ignores: ["src/vendor/**"] };

describe("pluginOf", () => {
  it("a core rule needs no plugin", () => {
    expect(pluginOf("no-console")).toBeNull();
  });
  it("names the package by ESLint's naming convention", () => {
    expect(pluginOf("react/jsx-key")).toEqual({
      prefix: "react",
      pkg: "eslint-plugin-react",
    });
    expect(pluginOf("@typescript-eslint/no-explicit-any")).toEqual({
      prefix: "@typescript-eslint",
      pkg: "@typescript-eslint/eslint-plugin",
    });
    expect(pluginOf("@stylistic/js/indent")).toEqual({
      prefix: "@stylistic/js",
      pkg: "@stylistic/eslint-plugin-js",
    });
  });
});

describe("eslintConfigModule", () => {
  it("a core rule: global ignores, then one block with the rule only", () => {
    expect(
      eslintConfigModule({
        linter: "eslint",
        rule: "max-len",
        options: [{ code: 100 }],
        scope,
      }),
    ).toBe(
      [
        "export default [",
        '  { ignores: ["src/vendor/**"] },',
        '  { files: ["src/**/*.js"], linterOptions: { reportUnusedDisableDirectives: "off" }, rules: { "max-len": ["error",{"code":100}] } },',
        "];",
        "",
      ].join("\n"),
    );
  });
  it("a plugin rule imports its plugin, and a parser when the reading names one", () => {
    expect(
      eslintConfigModule({
        linter: "eslint",
        rule: "@typescript-eslint/no-explicit-any",
        options: [],
        parser: "@typescript-eslint/parser",
        scope: { files: ["**/*.ts"], ignores: [] },
      }),
    ).toBe(
      [
        'import plugin from "@typescript-eslint/eslint-plugin";',
        'import parser from "@typescript-eslint/parser";',
        "export default [",
        "  { ignores: [] },",
        '  { files: ["**/*.ts"], linterOptions: { reportUnusedDisableDirectives: "off" }, plugins: { "@typescript-eslint": plugin }, languageOptions: { parser }, rules: { "@typescript-eslint/no-explicit-any": ["error"] } },',
        "];",
        "",
      ].join("\n"),
    );
  });
});

describe("parseEslintReport", () => {
  const dir = "/repo";
  const out = JSON.stringify([
    {
      filePath: "/repo/src/a.js",
      messages: [
        { ruleId: "no-console", message: "x" },
        { ruleId: "no-console", message: "y" },
      ],
    },
    { filePath: "/repo/src/b.js", messages: [] },
    {
      filePath: "/repo/src/c.js",
      messages: [{ ruleId: null, fatal: true, message: "Parsing error: z" }],
    },
    {
      filePath: "/repo/node_modules/d.js",
      messages: [
        {
          ruleId: null,
          message: "File ignored because of a matching ignore pattern.",
        },
      ],
    },
  ]);
  it("one report per file: hits of the rule, parse errors, ignored", () => {
    expect(parseEslintReport(out, dir, "no-console")).toEqual({
      kind: "parsed",
      files: [
        { path: "src/a.js", kind: "linted", hits: 2 },
        { path: "src/b.js", kind: "linted", hits: 0 },
        { path: "src/c.js", kind: "parse-error", message: "Parsing error: z" },
        { path: "node_modules/d.js", kind: "ignored" },
      ],
    });
  });
  it("skips banner lines a plugin printed before the JSON", () => {
    expect(
      parseEslintReport(`banner\n${out}`, dir, "no-console"),
    ).toMatchObject({ kind: "parsed" });
  });
  it("output that is not the report is unreadable, never an empty list", () => {
    expect(parseEslintReport("Oops!", dir, "no-console")).toEqual({
      kind: "unreadable",
      reason: "no JSON report in the linter's output: Oops!",
    });
    expect(parseEslintReport("[{}]", dir, "no-console")).toMatchObject({
      kind: "unreadable",
    });
    expect(parseEslintReport("[ not json", dir, "no-console")).toMatchObject({
      kind: "unreadable",
    });
  });
});

describe("eslintKit", () => {
  const root = (files: Readonly<Record<string, string>>) => ({
    names: Object.keys(files),
    read: (name: string) => files[name] ?? null,
  });
  it("plans the lockfile's install, runs node_modules/.bin/eslint, reads its version", () => {
    const plan = eslintKit.plan(root({ "package-lock.json": "{}" }));
    if (plan.kind !== "plan") throw new Error(plan.reason);
    expect(plan.install).toEqual([
      "npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(plan.command("/r")).toEqual(["/r/node_modules/.bin/eslint"]);
    expect(
      plan.version((p) =>
        p === "node_modules/eslint/package.json" ? '{"version":"9.1.0"}' : null,
      ),
    ).toBe("9.1.0");
    expect(plan.version(() => null)).toBeNull();
  });
  it("no lockfile: no-lockfile", () => {
    expect(eslintKit.plan(root({}))).toMatchObject({
      kind: "none",
      stage: "no-lockfile",
    });
  });
  it("the config sits in the repository; exit 1 still carries a report", () => {
    const reading = {
      linter: "eslint" as const,
      rule: "no-console",
      options: [],
      scope,
    };
    expect(
      eslintKit.invocation(reading, ["src/a.js"], {
        dir: "/r",
        cacheDir: "/c",
      }),
    ).toMatchObject({
      configPath: "/r/.vigiles-rule-proof.config.mjs",
      args: [
        "--config",
        "/r/.vigiles-rule-proof.config.mjs",
        "--format",
        "json",
        "src/a.js",
      ],
    });
    expect(eslintKit.reportCodes).toEqual([0, 1]);
    expect(eslintKit.env("/c")).toMatchObject({
      npm_config_cache: "/c/npm",
      ESLINT_USE_FLAT_CONFIG: "true",
    });
  });
});
