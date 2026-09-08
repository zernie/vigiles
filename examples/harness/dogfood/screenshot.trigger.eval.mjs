/**
 * Dogfood — does the contributor-only `screenshot` skill trigger (and only then)?
 *
 * `screenshot` lives under `.claude/skills/` (this repo's own harness, not the
 * shipped plugin). It stays model-invocable because a MISS is expensive in a way
 * the model cannot see: without the skill it reaches for `playwright install`
 * (blocked in the container) or captures scroll-reveal sections blank — the two
 * gotchas the skill exists to encode. And the natural phrasings ("see how it
 * looks", "render site/ and show me") do not contain the skill's name, so a
 * name-only listing would not rescue them. The description must therefore fire on
 * render / capture / "show me" requests for a LOCAL page (site/, report/, any dev
 * server) and stay quiet on image processing, copy edits, diagrams and builds.
 *
 * Known neighbour it competes with, NOT asserted here: `landing-site` (see that
 * eval's header). Site prompts DO appear in this recall bank — the description
 * names `site/` explicitly — but no rendering prompt is asserted quiet for
 * `landing-site`; the overlap is a `measureSelectionMatrix` question.
 *
 *   npx vigiles eval examples/harness/dogfood/screenshot.trigger.eval.mjs
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
const skill = "vigiles-loose-skills:screenshot";

export default defineEval({
  measureTriggerRate: {
    skillsDir,
    stubSkillBodies: true, // trigger = frontmatter only; stop at selection
    // SHOULD fire — render/capture a local page and look at it (>= 10):
    prompts: [
      "Screenshot the landing page and show me the result.",
      "Render site/ and let me see how the hero looks on mobile.",
      "How does the audit report template look once built? Show me.",
      "Take desktop and mobile captures of the local dev server on port 5173.",
      "Show me what the report page looks like at 390px wide.",
      "Render dist/audit-report.template.html filled with a sample report and capture it.",
      "I want to see the below-the-fold cards on vigiles.sh — capture the full page.",
      "Grab a full-page image of the built site so I can check the spacing.",
      "Serve the site/dist folder and screenshot it before I commit.",
      "Can you render this local HTML file and send me a picture of it?",
      "Visually verify the DemoAudit frame after my change — capture it.",
    ],
    // should NOT fire — images, copy, diagrams and builds that render nothing:
    irrelevantPrompts: [
      "Crop and compress the screenshots in docs/.",
      "Add alt text to the images in the changelog.",
      "Rewrite the headline on the landing page; it reads cryptic.",
      "Regenerate the vigiles logo with a darker palette.",
      "Convert the hero PNG to a WebP.",
      "Fix the off-by-one in the frontmatter reader when the file starts with a BOM.",
      "Why is the site build failing on the Tailwind step?",
      "Add a Mermaid diagram of the audit flow to docs/audit.md.",
      "Run the site's e2e tests and report which ones fail.",
      "What does the landing page's hero section say? Quote the copy.",
      "Update the README badge to point at the new CI workflow.",
    ],
    fired: (t) => skillResolved(t, skill),
    trials: 1,
  },
  assert: (report) => {
    assertTriggerRate(report, { min: 0.7, maxFalsePositive: 0.2 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
