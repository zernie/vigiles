/**
 * Dogfood — does the contributor-only `landing-site` skill trigger (and only then)?
 *
 * `landing-site` lives under `.claude/skills/` (this repo's own harness, not the
 * shipped plugin). It is a DESIGN-BAR skill: its value is arriving BEFORE anyone
 * touches `site/`, and a contributor asking to "shorten the hero" would never think
 * to name it. That is the case for staying model-invocable, and the case is only
 * honest if the description is measured: fires on any edit / design / copy /
 * review request scoped to `site/` (vigiles.sh), quiet on docs/, README, the audit
 * report (`report/`, `packages/report-view/`), and the library itself — the
 * description says "Not for docs/ or the app itself" in so many words.
 *
 * Known neighbour it competes with, NOT asserted here: `screenshot`. "Screenshot
 * the landing page and check the hero" plausibly fires both (this skill claims
 * "reviewing any site/ component"; `screenshot` claims "see how it looks" for
 * `site/`). Rendering prompts appear in NEITHER bank below; that overlap is a
 * `measureSelectionMatrix` question over the whole `.claude/skills/`.
 *
 *   npx vigiles eval examples/harness/dogfood/landing-site.trigger.eval.mjs
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
const skill = "vigiles-loose-skills:landing-site";

export default defineEval({
  measureTriggerRate: {
    skillsDir,
    stubSkillBodies: true, // trigger = frontmatter only; stop at selection
    // SHOULD fire — anything that designs, edits, adds to or reviews site/ (>= 10).
    // "Add a section" is deliberately in the recall bank: the skill should fire
    // and THEN argue for subtraction; not firing is the failure.
    prompts: [
      "Make the hero on vigiles.sh shorter — the CTA is below the fold on a phone.",
      "Add a testimonials section to site/.",
      "Rewrite the headline on the landing page; 'Valid is not true' reads cryptic.",
      "Review the FAQ block in site/src for copy that plants doubt.",
      "The demo frame in DemoAudit doesn't say which repo is shown — fix the labelling.",
      "Redesign the CTA on the landing so the npx command is one tap to copy.",
      "Add a second button next to the primary CTA that links to the docs.",
      "Tune the spacing of the feature cards on the landing site at 390px.",
      "Wire Plausible analytics into site/index.html.",
      "The landing page looks template-y — what should we remove?",
      "Change the FEATURED chips in site/ to show three repos instead of five.",
    ],
    // should NOT fire — front-door-adjacent work that is not site/:
    irrelevantPrompts: [
      "Tighten the wording in docs/compiled-hooks.md, the intro paragraph is long.",
      "Update the README badge to point at the new CI workflow.",
      "Restyle the audit report's ring component in packages/report-view.",
      "Refactor scan.ts so collectMcpServers is under 15 cognitive complexity.",
      "Add a docs/ page explaining the read-vs-run consent in audit.",
      "Fix the off-by-one in the frontmatter reader when the file starts with a BOM.",
      "Review the README from a newcomer's point of view and score it.",
      "Regenerate the vigiles logo with a darker palette.",
      "Add the OpenCode adapter's model-mock port.",
      "Write the changelog entry for the next release.",
      "Fix the mobile layout of the audit HTML report's leaderboard table.",
    ],
    fired: (t) => skillResolved(t, skill),
    trials: 1,
  },
  assert: (report) => {
    assertTriggerRate(report, { min: 0.7, maxFalsePositive: 0.2 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
