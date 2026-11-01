/**
 * Claude Code's listing budget, as read from the pinned 2.1.187 binary:
 * floor(200,000 × 3 × fraction), fraction 0.01 unless the committed settings
 * set `skillListingBudgetFraction` to a value the CLI accepts (0 < f ≤ 1).
 */
import { describe, expect, it } from "vitest";

import {
  claudeCodeListingBudget,
  claudeCodeSkillListing,
} from "./skill-listing.js";

describe("the Claude Code listing budget", () => {
  it("is 6,000 chars by default — the floor over models and windows", () => {
    expect(claudeCodeListingBudget.limit({})).toEqual({ limit: 6000 });
    expect(claudeCodeSkillListing.budget).toBe(claudeCodeListingBudget);
  });

  it("a committed skillListingBudgetFraction moves it, and is named", () => {
    expect(
      claudeCodeListingBudget.limit({ skillListingBudgetFraction: 0.02 }),
    ).toEqual({ limit: 12000, setBy: "skillListingBudgetFraction" });
  });

  it("a value the CLI would reject keeps the default", () => {
    [0, -1, 1.5, "0.02", null].forEach((v) => {
      expect(
        claudeCodeListingBudget.limit({ skillListingBudgetFraction: v }),
      ).toEqual({ limit: 6000 });
    });
  });

  it("never goes below 1, as the CLI's Math.max(1, …)", () => {
    expect(
      claudeCodeListingBudget.limit({ skillListingBudgetFraction: 1e-9 }).limit,
    ).toBe(1);
  });
});
