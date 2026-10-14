/**
 * `local/no-group-names`: every form of PR #387's group-named code is
 * reported, and the forms that are another concept stay silent — the
 * `experimental_` export prefix, a nudge (a hint), a GitHub Actions workflow,
 * and the eval drivers' bare `experimental` caveat (the declared hole).
 */
import { RuleTester } from "eslint";
import tsparser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

import rule from "./no-group-names.mjs";

RuleTester.describe = describe as never;
RuleTester.it = it as never;
RuleTester.itOnly = it.only as never;

const tester = new RuleTester({
  languageOptions: {
    parser: tsparser as never,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const OPTIONS = [
  { names: ["experimental", "structural"], setNames: ["workflow", "nudge"] },
];

tester.run("no-group-names", rule as never, {
  valid: [
    {
      name: "the experimental_ export prefix is the API convention, not a group",
      code: "export const experimental_defineHook = 1;",
    },
    {
      name: "a nudge is a hint",
      code: "const skillTestNudge = 1; const NUDGE_AS_CONTEXT = 2; const adoptNudge = 3;",
    },
    {
      name: "a workflow is a GitHub Actions file",
      code: "const vigilesWorkflow = 1; const workflowUsesStaleApi = 2;",
    },
    {
      name: "declared hole: the bare identifier (the drivers' caveat field)",
      code: "const caveat = report.experimental;",
    },
    {
      name: "reading the group off the rule",
      code: "const graded = groups[spec.group].graded;",
    },
    {
      name: "a sentence that contains the word",
      code: 'const s = "experimental checks";',
    },
  ].map((c) => ({ ...c, options: OPTIONS })),
  invalid: [
    ["a SCREAMING list of a group", "const EXPERIMENTAL_RULES = [];"],
    ["a Pascal type named after a group", "type ExperimentalFinding = {};"],
    ["a camelCase function", "const experimentalResults = () => [];"],
    ["an inner Pascal segment", "const isExperimentalRule = () => true;"],
    ["the other plain group", "const STRUCTURAL_RULES = [];"],
    [
      "a string literal that IS the group",
      'const g = r.group === "experimental";',
    ],
    ["in TYPE position", 'type G = "structural";'],
    ["an ambiguous name in its group sense", "const NUDGE_RULES = [];"],
    ["…camelCase", "const workflowRules = [];"],
    ["…inner Pascal", "const initWorkflowRules = [];"],
  ].map(([name, code]) => ({ name, code, options: OPTIONS, errors: 1 })),
});
