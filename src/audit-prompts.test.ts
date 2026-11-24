/**
 * Auto-prompt generator suite (vitest, no model): topic extraction caps + strips
 * lead-ins, the recall set CLEARS the diversity gate it ships with (the
 * load-bearing property — a too-similar set would crash the tier per skill), and
 * autoTriggerPrompts builds the right TriggerPromptSet shape.
 */
import { describe, it, expect } from "vitest";
import {
  topicOf,
  recallPrompts,
  autoTriggerPrompts,
  AUTO_RECALL_COUNT,
  AUTO_MIN_DISTANCE,
  type PromptSkill,
} from "./audit-prompts.js";
import { checkPromptDiversity } from "./core/prompt-diversity.js";

describe("topicOf", () => {
  it("strips a boilerplate lead-in and lowercases", () => {
    expect(topicOf("A skill that reviews code changes for correctness")).toBe(
      "reviews code changes for correctness",
    );
    expect(topicOf("Use this skill to scan dependencies for CVEs")).toBe(
      "scan dependencies for cves",
    );
  });

  it("caps at 8 words (long descriptions can't collapse the frames)", () => {
    const long =
      "Generate comprehensive end to end test suites for react components including edge cases";
    expect(topicOf(long).split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  it("takes only the first clause", () => {
    expect(topicOf("Lints CSS, fixes formatting, and reports errors")).toBe(
      "lints css",
    );
  });

  it("falls back to the raw description when stripping leaves nothing", () => {
    expect(topicOf("Use this skill to").length).toBeGreaterThan(0);
  });
});

describe("recallPrompts diversity (the load-bearing property)", () => {
  // The generated recall set must clear the gate it ships with, or every skill's
  // trigger probe would throw the diversity error and report unmeasured.
  const cases = [
    "Greets the user warmly with a personalised message",
    "Reviews code changes for correctness and style across the whole repo",
    "Generate comprehensive end-to-end test suites for react components including edge cases and accessibility checks",
    "A tool that scans dependencies for vulnerabilities",
  ];
  for (const desc of cases) {
    it(`clears the AUTO gate for: "${desc.slice(0, 32)}…"`, () => {
      const prompts = recallPrompts(desc);
      expect(prompts.length).toBe(AUTO_RECALL_COUNT);
      const issues = checkPromptDiversity(prompts, {
        minPrompts: AUTO_RECALL_COUNT,
        minDistance: AUTO_MIN_DISTANCE,
      });
      expect(issues).toEqual([]);
    });
  }
});

describe("autoTriggerPrompts", () => {
  const skills: PromptSkill[] = [
    { name: "review", description: "Reviews code changes for correctness" },
    { name: "empty", description: "   " },
  ];

  it("builds a TriggerPromptSet keyed by skill name with recall + irrelevant", () => {
    const set = autoTriggerPrompts(skills);
    expect(Object.keys(set)).toEqual(["review"]); // empty-description skill skipped
    expect(set.review.prompts.length).toBe(AUTO_RECALL_COUNT);
    expect(set.review.irrelevant?.length).toBeGreaterThan(0);
  });

  it("the irrelevant arm is distinct from the recall arm", () => {
    const set = autoTriggerPrompts(skills);
    const overlap = set.review.prompts.filter((p) =>
      set.review.irrelevant?.includes(p),
    );
    expect(overlap).toEqual([]);
  });

  it("the irrelevant arm ALSO clears the AUTO diversity floor (both arms gated)", () => {
    // Regression: the trigger tier applies `minPrompts: AUTO_RECALL_COUNT` to BOTH
    // arms. A short irrelevant bank fails preflight ("need at least N") and every
    // skill reports unmeasured instead of running. The bank must meet the floor.
    const set = autoTriggerPrompts(skills);
    const issues = checkPromptDiversity(set.review.irrelevant ?? [], {
      minPrompts: AUTO_RECALL_COUNT,
      minDistance: AUTO_MIN_DISTANCE,
      label: "irrelevantPrompts",
    });
    expect(issues).toEqual([]);
  });
});
