/**
 * Description-overlap detector suite (vitest): fires on a copy-paste near-dup, stays quiet on a parallel-but-distinct pair (the create-issue/create-pr shape at NCD ~0.25), the calibrated cutoff sits below 0.25, and a single/empty surface yields no pairs
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  findDescriptionOverlaps,
  OVERLAP_NCD_CUTOFF,
} from "./description-overlap.js";

test("flags a copy-paste near-duplicate pair", () => {
  const overlaps = findDescriptionOverlaps([
    {
      name: "review-backend",
      description:
        "Use this skill to review backend code for security issues and suggest concrete fixes before merging.",
    },
    {
      name: "review-frontend",
      description:
        "Use this skill to review frontend code for security issues and suggest concrete fixes before merging.",
    },
  ]);
  assert.equal(overlaps.length, 1);
  assert.ok(overlaps[0].similarity > 0.8);
  assert.match(overlaps[0].message, /near-identical/);
});

test("stays quiet on parallel-but-distinct descriptions", () => {
  // The shape that sits at NCD ~0.25 in the real sweep (create-issue/create-pr) —
  // distinct skills the model CAN tell apart, must NOT be flagged.
  const overlaps = findDescriptionOverlaps([
    {
      name: "create-issue",
      description:
        "Create a GitHub issue from a title and body, applying labels and assignees.",
    },
    {
      name: "create-pr",
      description:
        "Open a GitHub pull request from the current branch, filling the template and requesting reviewers.",
    },
  ]);
  assert.deepEqual(overlaps, []);
});

test("the calibrated cutoff sits below the sweep's most-similar distinct pair (0.25)", () => {
  assert.ok(OVERLAP_NCD_CUTOFF < 0.25);
});

test("a single surface (or none) yields no pairs", () => {
  assert.deepEqual(
    findDescriptionOverlaps([{ name: "only", description: "the one skill" }]),
    [],
  );
  assert.deepEqual(findDescriptionOverlaps([]), []);
});
