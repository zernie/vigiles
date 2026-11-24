import { describe, it, expect } from "vitest";
import { budgetShrinkViolations } from "./budget-shrink.mjs";

/**
 * The shrink-only rule of `api-surface/budget.json`, judged against the base
 * branch's copy. Each case has both halves: the planted growth fails, and the
 * legitimate change next to it passes.
 */

const base = {
  entries: {
    ".": { ceiling: 33, grandfathered: ["a", "b"] },
    "./eval": { ceiling: 12, grandfathered: [] },
  },
};

describe("budgetShrinkViolations", () => {
  it("fails when a PR adds an export AND grandfathers it (the count alone cannot see this)", () => {
    const head = {
      entries: {
        ...base.entries,
        ".": { ceiling: 33, grandfathered: ["a", "b", "c"] },
      },
    };
    expect(budgetShrinkViolations(base, head)).toEqual([
      ".: grandfathered may only shrink, but c was added",
    ]);
  });

  it("passes when a grandfathered name is removed", () => {
    const head = {
      entries: { ...base.entries, ".": { ceiling: 33, grandfathered: ["a"] } },
    };
    expect(budgetShrinkViolations(base, head)).toEqual([]);
  });

  it("fails when a ceiling rises, passes when it falls", () => {
    const up = {
      entries: {
        ...base.entries,
        "./eval": { ceiling: 13, grandfathered: [] },
      },
    };
    const down = {
      entries: {
        ...base.entries,
        "./eval": { ceiling: 11, grandfathered: [] },
      },
    };
    expect(budgetShrinkViolations(base, up)).toEqual([
      "./eval: ceiling may only fall, but it rose from 12 to 13",
    ]);
    expect(budgetShrinkViolations(base, down)).toEqual([]);
  });

  it("lets a new entry in only with an empty grandfather list", () => {
    const clean = {
      entries: { ...base.entries, "./new": { ceiling: 2, grandfathered: [] } },
    };
    const indebted = {
      entries: {
        ...base.entries,
        "./new": { ceiling: 2, grandfathered: ["x"] },
      },
    };
    expect(budgetShrinkViolations(base, clean)).toEqual([]);
    expect(budgetShrinkViolations(base, indebted)).toEqual([
      "./new: a new entry starts with no grandfathered names (got x)",
    ]);
  });

  it("is silent when nothing changed", () => {
    expect(budgetShrinkViolations(base, base)).toEqual([]);
  });

  describe("renamed entries (v51)", () => {
    const renamedBase = {
      entries: {
        "./claude-code": { ceiling: 10, grandfathered: ["a", "b"] },
        "./adapter": { ceiling: 8, grandfathered: [] },
      },
    };

    it("compares a renamed entry against its old row, so its grandfathered names carry over", () => {
      const head = {
        entries: {
          "./harness/claude-code": { ceiling: 10, grandfathered: ["a", "b"] },
          "./harness/kit": { ceiling: 8, grandfathered: [] },
        },
      };
      expect(budgetShrinkViolations(renamedBase, head)).toEqual([]);
    });

    it("still fails a renamed entry that adds a grandfathered name or raises its ceiling", () => {
      const head = {
        entries: {
          "./harness/claude-code": {
            ceiling: 11,
            grandfathered: ["a", "b", "c"],
          },
        },
      };
      expect(budgetShrinkViolations(renamedBase, head)).toEqual([
        "./harness/claude-code: grandfathered may only shrink, but c was added",
        "./harness/claude-code: ceiling may only fall, but it rose from 10 to 11",
      ]);
    });

    it("still fails a brand-new entry with grandfathered names (only listed renames are mapped)", () => {
      const head = {
        entries: {
          "./hook/testing": { ceiling: 13, grandfathered: ["x"] },
        },
      };
      expect(budgetShrinkViolations(renamedBase, head)).toEqual([
        "./hook/testing: a new entry starts with no grandfathered names (got x)",
      ]);
    });
  });
});
