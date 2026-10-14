/**
 * `applyRules` — the one place a scan meets the resolved config. Fixture rules
 * and groups, not shipped ones: what is under test is the machinery, and a test
 * of generic code that names a real rule is a test of that rule.
 */
import { describe, expect, it } from "vitest";

import { applyRules, gradedView } from "./apply-rules.js";
import { defineRule, type RuleGroups, type ScanInput } from "./rule.js";

const listed = defineRule({
  id: "fixture-listed",
  group: "graded",
  bucket: "heuristic-behavioral",
  surface: ["hook"],
  defaultSeverity: "off",
  cure: "edit",
  summary: "a rule whose findings sit in a scan list",
  detector: "fixture",
  legacy: { scanField: "items" },
});
const scored = defineRule({
  id: "fixture-scored",
  group: "graded",
  bucket: "structural-closed",
  surface: ["hook"],
  defaultSeverity: "warn",
  cure: "edit",
  summary: "a rule that declares no scan field",
  detector: "fixture",
});
const module = defineRule({
  id: "fixture-module",
  group: "shown",
  bucket: "external-decidable",
  surface: ["skill"],
  defaultSeverity: "off",
  cure: "edit",
  summary: "a rule module in an ungraded group",
  detector: "fixture",
  findings: (scan: ScanInput) =>
    scan.skills.map((s) => ({
      kind: "finding" as const,
      path: s.path,
      subject: s.name,
      message: "found",
    })),
});
const RULES = [listed, scored, module];
const GROUPS: RuleGroups = {
  graded: { graded: true, label: "Graded" },
  shown: { graded: false, label: "Shown — not graded", blurb: "Never scored." },
};
const SCAN = {
  skills: [
    { name: "alpha", path: "skills/alpha/SKILL.md", resourceIssues: [] },
  ],
  items: ["a", "b"],
  graded: ["x"],
  count: 2,
};
const switchOf = (on: readonly string[]) => ({
  mayFire: (id: string) => on.includes(id),
});

describe("applyRules — an off rule's scan field", () => {
  it("is emptied when the rule cannot fire", () => {
    expect(applyRules(RULES, GROUPS, switchOf([]), SCAN).items).toEqual([]);
  });

  it("is kept when the rule can fire anywhere", () => {
    const out = applyRules(RULES, GROUPS, switchOf([listed.id]), SCAN);
    expect(out.items).toEqual(["a", "b"]);
  });

  it("a field no rule declares stays as scanned (a graded field never moves)", () => {
    const out = applyRules(RULES, GROUPS, switchOf([]), SCAN);
    expect(out.graded).toEqual(["x"]);
    expect(out.count).toBe(2);
  });

  it("a declared field that is not a list is left alone", () => {
    const odd = { ...SCAN, items: "not a list" };
    expect(applyRules(RULES, GROUPS, switchOf([]), odd).items).toBe(
      "not a list",
    );
  });

  it("the scan it was handed is not mutated", () => {
    applyRules(RULES, GROUPS, switchOf([]), SCAN);
    expect(SCAN.items).toEqual(["a", "b"]);
  });
});

describe("applyRules — ungraded groups", () => {
  it("an ungraded group's rule that is on reports in its group's block, under the group's label", () => {
    const out = applyRules(RULES, GROUPS, switchOf([module.id]), SCAN);
    expect(out.ungraded).toEqual([
      {
        group: "shown",
        label: "Shown — not graded",
        blurb: "Never scored.",
        rules: [
          {
            rule: module.id,
            findings: [
              {
                kind: "finding",
                path: "skills/alpha/SKILL.md",
                subject: "alpha",
                message: "found",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("a rule that is on and found nothing is still listed, so the reader sees it ran", () => {
    const empty = { ...SCAN, skills: [] };
    const out = applyRules(RULES, GROUPS, switchOf([module.id]), empty);
    expect(out.ungraded).toEqual([
      expect.objectContaining({ rules: [{ rule: module.id, findings: [] }] }),
    ]);
  });

  it("no block at all when no rule of an ungraded group is on", () => {
    const out = applyRules(RULES, GROUPS, switchOf([scored.id]), SCAN);
    expect(out.ungraded).toEqual([]);
  });

  it("the graded view a scorer takes carries no ungraded findings", () => {
    const out = applyRules(RULES, GROUPS, switchOf([module.id]), SCAN);
    expect("ungraded" in gradedView(out)).toBe(false);
    expect(gradedView(out).graded).toEqual(["x"]);
  });
});
