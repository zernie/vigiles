/**
 * Dogfood — does the contributor-only `code-quality` skill trigger (and only then)?
 *
 * `code-quality` lives under `.claude/skills/` (this repo's own harness, not the
 * shipped plugin) and is the archetypal AUTO-FIRE skill: nobody types its name —
 * they say "clean this up", "tighten these types", "make this exhaustive" — and
 * the whole point is that the type-driven techniques arrive uninvited. So it must
 * stay model-invocable, and that decision is only honest if its DESCRIPTION is
 * measured: fires on refactor / clean-up / design-review requests, quiet on the
 * neighbours — a bug fix, a bug hunt, a doc edit, a test, CI, the landing site.
 *
 * Known neighbour it competes with, NOT asserted here: `ship-a-feature`. Both
 * descriptions claim the "new public export" prompt space (`code-quality` via
 * "public-API hygiene", `ship-a-feature` via "a new export / public function").
 * None of those prompts appear in EITHER bank below — a per-skill precision arm
 * would only paper the overlap over. That question belongs to
 * `measureSelectionMatrix` + `assertNoCollision` over the whole `.claude/skills/`.
 *
 *   npx vigiles eval examples/harness/dogfood/code-quality.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; runs where a key is. The thresholds are the
 * template's defaults, not calibrated by a run.
 */
import { defineEval } from "../../../dist/test.js";
import {
  skillResolved,
  assertTriggerRate,
} from "../../../dist/harness-assert.js";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(
  new URL("../../../.claude/skills/", import.meta.url),
);
const skill = "vigiles-loose-skills:code-quality";

export default defineEval({
  measureTriggerRate: {
    skillsDir,
    stubSkillBodies: true, // trigger = frontmatter only; stop at selection
    // SHOULD fire — a refactor / clean-up / design pass over existing code (>= 10):
    prompts: [
      "Refactor scan.ts so collectMcpServers is under 15 cognitive complexity.",
      "Clean up hook-normalize.ts — the boolean flags for matcher presence are getting out of hand.",
      "This code re-checks that the severity string is valid at every call site; tidy that up.",
      "Tighten the types in eval-lock.ts so an unchecked record can't be passed where a checked one is expected.",
      "Review the design of the ExcludeSet API before we freeze it.",
      "Improve the shape of parseSetupArgs — it returns a bag of optional booleans.",
      "Harden the frontmatter reader's return type; callers keep testing for undefined.",
      "The switch over Decision kinds has no default branch — make it exhaustive.",
      "Separate the IO from the logic in run-scripts.ts so the classifier is unit-testable.",
      "This module leaks an internal helper through the barrel; clean up the public surface.",
      "Make the illegal state impossible: a hook result that carries both a deny and an inject.",
    ],
    // should NOT fire — nearby work that is not a quality/design pass:
    irrelevantPrompts: [
      "Fix the off-by-one in the frontmatter reader when the file starts with a BOM.",
      "Why does npm run check fail on the format stage?",
      "Tighten the wording in docs/compiled-hooks.md, the intro paragraph is long.",
      "Add a regression test for the compound git push bypass.",
      "Find the bug: audit reports a hook script missing that exists on disk.",
      "Update the README badge to point at the new CI workflow.",
      "Make the hero on vigiles.sh shorter, it pushes the CTA below the fold.",
      "Rebase this branch onto main and resolve the conflict in package-lock.json.",
      "Which CI jobs does npm run check not cover?",
      "Screenshot the audit report at 390px and tell me if the rings overflow.",
      "Write the docs/rules page for the new mcp-hook-target-resolves rule.",
    ],
    fired: (t) => skillResolved(t, skill),
    trials: 1,
  },
  assert: (report) => {
    assertTriggerRate(report, { min: 0.7, maxFalsePositive: 0.2 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
