/**
 * Dogfood — does the contributor-only `review-docs` skill trigger (and only then)?
 *
 * `review-docs` lives under `.claude/skills/` (this repo's own harness, not the
 * shipped plugin). It was authored here as an AUTO-TRIGGERING skill — "lives in
 * .claude/skills/ so it auto-loads and triggers on 'review the readme'", replacing
 * the explicit-only `audience-check` — and the README is this repo's front door
 * (the `readme-brevity` / `docs-quality` rules), so "review the README" is a
 * frequent contributor prompt that never carries the skill's name. That is the
 * case for staying model-invocable; it is only honest if measured: fires on
 * review / critique / grade / "get to N/5" of the README or a docs/ page, quiet on
 * doc EDITS (tighten, fix a link, add a section), code review, the landing site's
 * copy, and the logo.
 *
 * Boundary NOT asserted here: marketing copy on `site/` is a front door too, but
 * `landing-site` claims "reviewing … marketing copy" for site/. No site-copy
 * review prompt appears in either bank; that is a `measureSelectionMatrix`
 * question over the whole `.claude/skills/`.
 *
 *   npx vigiles eval examples/harness/dogfood/review-docs.trigger.eval.mjs
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
const skill = "vigiles-loose-skills:review-docs";

export default defineEval({
  measureTriggerRate: {
    skillsDir,
    stubSkillBodies: true, // trigger = frontmatter only; stop at selection
    // SHOULD fire — review / critique / grade a front-door doc as real readers (>= 10):
    prompts: [
      "Review the README from several reader points of view and score it.",
      "How does the README read to a Claude Code newcomer? Grade it.",
      "Critique docs/harness-testing.md as a skeptical senior engineer would.",
      "Get the README to 5/5.",
      "Does docs/compiled-hooks.md make sense to a plugin author who has never used vigiles? Review it.",
      "Score the front-door docs x/5 and give me line-level fixes.",
      "Read the README as a decision-maker who won't run anything — what would they think?",
      "Review docs/cli.md for how it lands with real users.",
      "Give me a multi-persona review of the agent-setup guide.",
      "Is the README's first screen clear to someone who lives in Cursor? Review and score it.",
      "Critique the new docs/exclude.md page before I open the PR.",
    ],
    // should NOT fire — doc EDITS, code review, and other front-door work:
    irrelevantPrompts: [
      "Tighten the wording in docs/compiled-hooks.md, the intro paragraph is long.",
      "Update the README badge to point at the new CI workflow.",
      "Review this PR's diff for correctness bugs.",
      "Refactor scan.ts so collectMcpServers is under 15 cognitive complexity.",
      "Write the docs/rules page for the new mcp-hook-target-resolves rule.",
      "Rewrite the headline on the landing page; it reads cryptic.",
      "Fix the broken link in docs/harnesses.md to the adapter guide.",
      "Add a Contents list to docs/harness-testing.md.",
      "Regenerate the vigiles logo with a darker palette.",
      "Which docs/ files are orphans according to vigiles lint?",
      "Review the design of the ExcludeSet API before we freeze it.",
    ],
    fired: (t) => skillResolved(t, skill),
    trials: 1,
  },
  assert: (report) => {
    assertTriggerRate(report, { min: 0.7, maxFalsePositive: 0.2 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
