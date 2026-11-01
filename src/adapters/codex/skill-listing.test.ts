/**
 * Codex's listing budget, as read from rust-v0.153.0: 8,000 at thread start,
 * or `[skills] max_context_tokens` (capped at 10,000) at four bytes a token.
 */
import { describe, expect, it } from "vitest";

import { codexListingBudget, codexSkillListing } from "./skill-listing.js";

describe("the Codex listing budget", () => {
  it("is 8,000 at thread start with nothing configured", () => {
    expect(codexListingBudget.limit({})).toEqual({ limit: 8000 });
    expect(codexSkillListing.budget).toBe(codexListingBudget);
  });

  it("a committed max_context_tokens replaces it, four bytes a token, named", () => {
    expect(
      codexListingBudget.limit({ skills: { max_context_tokens: 3000 } }),
    ).toEqual({ limit: 12000, setBy: "skills.max_context_tokens" });
  });

  it("is capped at 10,000 tokens", () => {
    expect(
      codexListingBudget.limit({ skills: { max_context_tokens: 50_000 } })
        .limit,
    ).toBe(40_000);
  });

  it("a value Codex would refuse keeps the thread-start budget", () => {
    [0, -1, 1.5, "100", null].forEach((v) => {
      expect(
        codexListingBudget.limit({ skills: { max_context_tokens: v } }),
      ).toEqual({ limit: 8000 });
    });
    expect(codexListingBudget.limit({ skills: [] })).toEqual({ limit: 8000 });
  });
});
