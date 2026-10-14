/**
 * The rule-layer fences, run through the REAL `eslint.config.mjs` over planted
 * files — the proof that the config wires each fence onto the paths it claims,
 * which a RuleTester case (the rule with options handed to it) cannot show.
 *
 * Each case plants one file at a path and asserts which fence fires. The
 * planted code never exists on disk: `lintText` with a `filePath` classifies it
 * by path, the type-aware parser service is switched off (no fence needs types)
 * and `ruleFilter` keeps only the fences, so the suite runs in seconds rather
 * than the full lint's minutes. The IMPORT fence (`boundaries`) needs the files
 * it resolves to exist, so its planted matrix lives with `layers()` in
 * `packages/eslint-config/index.test.ts`; the last case here checks that this
 * repo's config hands `layers()` the rule layer at all.
 */
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const FENCES = new Set(["local/no-rule-ids", "local/no-group-names"]);

const eslint = new ESLint({
  overrideConfig: [
    {
      files: ["src/**/*.ts"],
      languageOptions: {
        parserOptions: { projectService: false, project: null },
      },
    },
  ],
  ruleFilter: ({ ruleId }) => FENCES.has(ruleId),
});

/** The fence findings a planted file at `path` gets, as `rule: name` lines. */
async function fired(path: string, code: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath: path });
  return (result?.messages ?? []).map(
    (m) => `${m.ruleId ?? "fatal"}: ${m.message.split('"')[1] ?? m.message}`,
  );
}

const SPELLS_ID = 'export const on = (id: string) => id === "hook-events";\n';
const OWN_ID = 'export const id = "skill-resource-resolves";\n';
const GROUP_TYPE =
  "export interface ExperimentalRuleResult { readonly n: number }\n";

describe("local/no-rule-ids — where an id may be spelled", () => {
  it.each([
    ["the domain", "src/core/planted.ts"],
    ["an app file", "src/planted.ts"],
    ["the composition root (roots are not exempt)", "src/cli-main.ts"],
    ["a test of generic code (tests are not exempt)", "src/planted.test.ts"],
    ["another rule's module", "src/rules/skill-resource-resolves.ts"],
    ["the group record", "src/rules/groups.ts"],
  ])("refused in %s", async (_where, path) => {
    expect(await fired(path, SPELLS_ID)).toContain(
      "local/no-rule-ids: hook-events",
    );
  });

  it.each([
    ["the rule's own module", "src/rules/skill-resource-resolves.ts"],
    [
      "the rule's own colocated test",
      "src/rules/skill-resource-resolves.test.ts",
    ],
    ["the set, which still holds the unmigrated rows", "src/rules/index.ts"],
  ])("allowed in %s", async (_where, path) => {
    expect(await fired(path, OWN_ID)).toEqual([]);
  });

  it("an identifier named after a rule is refused in a contract file", async () => {
    expect(
      await fired("src/scan.ts", "export const skillResourceResolvesN = 1;\n"),
    ).toContain("local/no-rule-ids: skill-resource-resolves");
  });

  it("…and left to review in a domain detector, which is named after what it detects", async () => {
    expect(
      await fired(
        "src/core/planted.ts",
        "export const lethalTrifectaIssues = 1;\n",
      ),
    ).toEqual([]);
  });

  it("an English-word id is left out of the string half", async () => {
    expect(
      await fired("src/core/planted.ts", 'export const s = "coverage";\n'),
    ).toEqual([]);
  });
});

describe("local/no-group-names — generic code never names a group", () => {
  it.each([
    ["the domain", "src/core/planted.ts"],
    ["an app file (the PR #387 shape)", "src/audit-report.ts"],
    ["the composition root", "src/cli-main.ts"],
  ])("refused in %s", async (_where, path) => {
    expect(await fired(path, GROUP_TYPE)).toContain(
      "local/no-group-names: ExperimentalRuleResult",
    );
  });

  it.each([
    ["the rule layer, where groups are data", "src/rules/groups.ts"],
    ["a test", "src/planted.test.ts"],
  ])("allowed in %s", async (_where, path) => {
    expect(await fired(path, GROUP_TYPE)).toEqual([]);
  });
});

describe("boundaries — this repo's config declares the rule layer", () => {
  it("a file in src/rules/ is in the `rule` category, and the set files in `ruleset`", async () => {
    const config = (await eslint.calculateConfigForFile(
      "src/rules/index.ts",
    )) as { settings: Record<string, unknown> };
    expect(config.settings["boundaries/files"]).toContainEqual(
      expect.objectContaining({ category: "rule", pattern: "src/rules/*.ts" }),
    );
    expect(config.settings["boundaries/files"]).toContainEqual(
      expect.objectContaining({
        category: "ruleset",
        pattern: "src/rules/{index,groups}.ts",
      }),
    );
  });
});
