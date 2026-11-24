#!/usr/bin/env node
/**
 * The function budget's grandfather lists may only shrink and its ceilings may
 * only fall — checked against the base branch's `api-surface/budget.json`,
 * because the file cannot vouch for itself (see `scripts/lib/budget-shrink.mjs`).
 *
 * Base: `GITHUB_BASE_REF` in CI (the `check` job checks out full history),
 * `origin/main` locally; the comparison point is the merge-base with HEAD.
 * A base without the file (the PR that introduces the budget) is a LOUD skip.
 * A missing git or base ref fails rather than passes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { budgetShrinkViolations } from "./lib/budget-shrink.mjs";

const FILE = "api-surface/budget.json";
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const ref = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : "origin/main";

let mergeBase;
try {
  mergeBase = git("merge-base", "HEAD", ref);
} catch (error) {
  console.error(
    `✗ budget-shrink: cannot find the merge-base of HEAD and ${ref} (${String(error).split("\n")[0]}). ` +
      `Fetch the base branch (CI: actions/checkout with fetch-depth: 0).`,
  );
  process.exit(1);
}

let baseText;
try {
  baseText = git("show", `${mergeBase}:${FILE}`);
} catch {
  console.log(
    `⚠ budget-shrink: SKIPPED — ${FILE} does not exist at the base (${mergeBase.slice(0, 7)}); ` +
      `this change introduces it, so there is no baseline to shrink against yet.`,
  );
  process.exit(0);
}

const violations = budgetShrinkViolations(
  JSON.parse(baseText),
  JSON.parse(readFileSync(FILE, "utf8")),
);
if (violations.length > 0) {
  console.error(
    `✗ budget-shrink: ${FILE} grew against ${ref} (${mergeBase.slice(0, 7)}):`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "  A new export goes in its audience's entry under the ceiling, or replaces a grandfathered one.",
  );
  process.exit(1);
}
console.log(
  `✓ budget-shrink: ${FILE} only shrank against ${ref} (${mergeBase.slice(0, 7)})`,
);
