/**
 * Dogfood — does vigiles's OWN `generate-logo` skill trigger (and only then)?
 *
 * `generate-logo` is an INTERNAL, contributor-only skill (it lives under
 * `.claude/skills/`, this repo's own harness, not the shipped consumer plugin),
 * but it stays a useful narrow
 * model-invocable dogfood: it should fire ONLY on a request about the vigiles
 * logo, and a narrow skill's risk is the opposite of a broad one — high
 * precision, but watch recall doesn't collapse. The precision-aware
 * `measureTriggerRate` checks both. The shipped user-invoked skills don't
 * auto-trigger and are covered by the free load gate (`src/skills-dogfood.test.ts`).
 *
 *   npx vigiles eval examples/harness/dogfood/generate-logo.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; runs where a key is.
 */
import { defineEval } from "../../../dist/entries/index.js";
import { check } from "../../../dist/check.js";
import { assertRates } from "../../../dist/entries/eval.js";
import { fileURLToPath } from "node:url";

// generate-logo is an INTERNAL skill (not in the shipped plugin), so load it from
// this repo's own `.claude/skills/`, packaged as a throwaway plugin by skillsDir
// (default plugin name `vigiles-loose-skills`), not the shipped repo-root plugin.
const skillsDir = fileURLToPath(
  new URL("../../../.claude/skills/", import.meta.url),
);
const skill = "vigiles-loose-skills:generate-logo";

export default defineEval({
  measureTriggerRate: {
    skillsDir,
    stubSkillBodies: true, // trigger = frontmatter only; stub the body to stop at selection
    // SHOULD fire — logo requests, varied phrasings (>= 10 for the diversity gate):
    prompts: [
      "Regenerate the vigiles logo with a darker palette.",
      "Make a new logo for vigiles.",
      "Iterate on our project logo — try a flatter style.",
      "Design a wordmark for the vigiles README.",
      "Produce an SVG brand mark for the project.",
      "Render the vigiles app icon at 512px.",
      "Give the logo a monochrome variant.",
      "Sketch a mascot-style logo for vigiles.",
      "Update the logo to match our new color scheme.",
      "Create a square logo for the npm package page.",
    ],
    // should NOT fire — nearby creative/asset work that is NOT the vigiles logo:
    irrelevantPrompts: [
      "Generate a favicon for my blog.",
      "Write the README hero section.",
      "Add an SVG icon to the toolbar.",
      "Crop and compress the screenshots in docs/.",
      "Pick a syntax-highlighting theme for the docs site.",
      "Draw a sequence diagram for the auth flow.",
      "Add alt text to the images in the changelog.",
      "Design a social-share preview card for the blog.",
      "Convert the hero PNG to a WebP.",
      "Make a 404 illustration for the website.",
    ],
    fired: check.skill(skill),
    trials: 1,
  },
  assert: (report) => {
    // A narrow skill: precision should be high; keep recall honest too.
    assertRates(report, { min: 0.5, maxFalsePositive: 0.34 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
