/**
 * `applyRules` — the one place a scan meets the resolved config. Fixture rules,
 * not shipped ones: what is under test is the machinery, and a test of generic
 * code that names a real rule is a test of that rule.
 */
import { describe, expect, it } from "vitest";

import { applyRules } from "./apply-rules.js";
import { defineRule } from "./rule.js";

const listed = defineRule({
  id: "fixture-listed",
  group: "g",
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
  group: "g",
  bucket: "structural-closed",
  surface: ["hook"],
  defaultSeverity: "warn",
  cure: "edit",
  summary: "a rule that declares no scan field",
  detector: "fixture",
});
const RULES = [listed, scored];
const SCAN = { items: ["a", "b"], graded: ["x"], count: 2 };
const switchOf = (on: readonly string[]) => ({
  mayFire: (id: string) => on.includes(id),
});

describe("applyRules", () => {
  it("empties the scan field an OFF rule declares", () => {
    const out = applyRules(RULES, switchOf([]), SCAN);
    expect(out.items).toEqual([]);
  });

  it("keeps it when the rule can fire anywhere", () => {
    const out = applyRules(RULES, switchOf([listed.id]), SCAN);
    expect(out.items).toEqual(["a", "b"]);
  });

  it("never touches a field no rule declares (a graded field stays as scanned)", () => {
    const out = applyRules(RULES, switchOf([]), SCAN);
    expect(out.graded).toEqual(["x"]);
    expect(out.count).toBe(2);
  });

  it("leaves a declared field that is not a list alone", () => {
    const odd = { items: "not a list" };
    expect(applyRules(RULES, switchOf([]), odd).items).toBe("not a list");
  });

  it("does not mutate the scan it was handed", () => {
    applyRules(RULES, switchOf([]), SCAN);
    expect(SCAN.items).toEqual(["a", "b"]);
  });
});
