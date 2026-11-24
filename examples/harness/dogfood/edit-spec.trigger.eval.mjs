/**
 * Dogfood — does vigiles's OWN `edit-spec` skill trigger (and only then)?
 *
 * `edit-spec` became model-invocable so the agent reaches for it when asked to
 * change a compiled CLAUDE.md/AGENTS.md (edit the .spec.ts, not the artifact) —
 * the same skill the pre-edit hook points at when it blocks a direct edit. This
 * eval guards that it FIRES on "change my CLAUDE.md / add a rule" requests
 * (recall) and stays QUIET on ordinary coding (precision). Pairs with the free
 * load gate in src/adapters/claude-code/skills-dogfood.test.ts.
 *
 *   npx vigiles eval examples/harness/dogfood/edit-spec.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../../dist/test.js";
import { skillResolved } from "../../../dist/harness-assert.js";
import { assertTriggerRate } from "../../../dist/eval-surface.js";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));
const skill = "vigiles:edit-spec";

export default defineEval({
  measureTriggerRate: {
    pluginDir,
    stubSkillBodies: true, // trigger = frontmatter only; stub the body to stop at selection
    // SHOULD fire — requests to change the compiled instruction file via its spec
    // (>= 10 varied phrasings; the diversity gate rejects a thin set up front):
    prompts: [
      "Add a rule to our CLAUDE.md that we always route output through logger.ts.",
      "Update the architecture section of CLAUDE.md to mention the new adapter layer.",
      "Add src/services/auth.ts to the key files in our vigiles spec.",
      "Change the testing guidance in our CLAUDE.md.",
      "Remove the outdated rule about the legacy build step from CLAUDE.md.",
      "Add `npm run e2e` to the commands documented in AGENTS.md.",
      "Edit our spec to require co-located tests for every service file.",
      "Our CLAUDE.md says use yarn but we moved to pnpm — fix that rule.",
      "Add a guidance rule that every PR must update the changelog.",
      "Document the new caching module in our instruction file.",
    ],
    // should NOT fire — ordinary coding the skill must not hijack:
    irrelevantPrompts: [
      "Why is this regex throwing? Fix it.",
      "Rename the variable `foo` to `bar` in utils.ts.",
      "Add a dark-mode toggle to the settings page.",
      "Implement retry logic for the HTTP client.",
      "Write a migration to drop the deprecated column.",
      "Fix the flaky test in checkout.test.ts.",
      "Add a loading spinner to the dashboard.",
      "Optimize the image assets under public/.",
      "Convert this class component to a hook.",
      "Set up ESLint in this repo.",
    ],
    fired: (t) => skillResolved(t, skill),
    trials: 1,
  },
  assert: (report) => {
    // Auto (model-invocable) skill: >= 80% recall, low false-positive rate.
    assertTriggerRate(report, { min: 0.8, maxFalsePositive: 0.3 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
