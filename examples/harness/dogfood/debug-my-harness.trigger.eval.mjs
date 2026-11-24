/**
 * Dogfood — does vigiles's OWN `debug-my-harness` skill trigger (and only then)?
 *
 * `debug-my-harness` is model-invocable so the agent reaches for it when the user
 * asks why the harness misbehaved (read the flight-recorder ledger). This eval is
 * the guard that the description FIRES on "why did my skill stop firing / why
 * didn't my hook block" requests (recall) and stays QUIET on ordinary coding
 * (precision). Pairs with the free load gate in
 * src/adapters/claude-code/skills-dogfood.test.ts.
 *
 *   npx vigiles eval examples/harness/dogfood/debug-my-harness.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../../dist/entries/index.js";
import { check } from "../../../dist/check.js";
import { assertRates } from "../../../dist/entries/eval.js";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));
const skill = "vigiles:debug-my-harness";

export default defineEval({
  measureTriggerRate: {
    pluginDir,
    stubSkillBodies: true, // trigger = frontmatter only; stub the body to stop at selection
    // SHOULD fire — requests to diagnose harness behavior (>= 10 varied):
    prompts: [
      "Why did my commit-helper skill stop firing this week?",
      "Debug my harness — the wrong skill keeps running on save requests.",
      "My no-force-push hook didn't block a force push. Why?",
      "Figure out why one of my subagents is going outside its tool contract.",
      "Something's off with my agent setup — investigate what actually happened in the last runs.",
      "Which of my skills are colliding and hijacking each other's prompts?",
      "My skill's trigger rate dropped after I upgraded — what changed?",
      "Look at the flight recorder and tell me why my hook isn't gating anything.",
      "Diagnose why my harness behaved wrong on the last session.",
      "Why is the reviewer subagent allowed to run Bash when it shouldn't be?",
    ],
    // should NOT fire — ordinary coding the skill must not hijack:
    irrelevantPrompts: [
      "Fix the ESLint errors in src/app.ts.",
      "Rename the variable `foo` to `bar` in utils.ts.",
      "Add a dark-mode toggle to the settings page.",
      "Run prettier across the whole repo.",
      "Why does this TypeScript type not narrow correctly?",
      "Add a new column to the orders table.",
      "Write a test for the cart total calculation.",
      "Upgrade React to v19 and fix the warnings.",
      "Implement a debounce on the search input.",
      "Set up Tailwind in this project.",
    ],
    fired: check.skill(skill),
    trials: 1,
  },
  assert: (report) => {
    // Auto (model-invocable) skill: >= 80% recall, low false-positive rate.
    assertRates(report, { min: 0.8, maxFalsePositive: 0.3 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
