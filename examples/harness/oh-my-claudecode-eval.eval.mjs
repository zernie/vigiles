/**
 * oh-my-claudecode walkthrough — Tier 3: eval (`measureTriggerRate`).
 *
 * The deterministic tier (Tier 2) proves a skill *resolves* when invoked. But
 * whether the REAL model *chooses* a skill from its description — across varied
 * phrasings — is a property only a real model can answer, and the #1
 * skill-authoring pain. This eval installs the real, pinned, vendored OMC plugin
 * natively (`pluginDir`) and measures how reliably its `verify` skill
 * ("Verify that a change really works before you claim completion") fires on
 * prompts that are about exactly that.
 *
 *   npx vigiles eval examples/harness/oh-my-claudecode-eval.eval.mjs
 *   npx vigiles eval --trials=3 examples/harness/oh-my-claudecode-eval.eval.mjs
 *
 * Real model → real cost. This is the ONE tier that needs model auth, so it is
 * NOT run in CI (unlike the unit/deterministic tiers above). External users
 * import from the package: `from "vigiles/eval"` (the paid runners) and
 * `from "vigiles"` (the free checks).
 */
import { fileURLToPath } from "node:url";

import { defineEval } from "../../dist/entries/index.js";
import { check } from "../../dist/check.js";

const pluginDir = fileURLToPath(
  new URL("../../test/dogfood/oh-my-claudecode@deee3a4", import.meta.url),
);
const skill = "oh-my-claudecode:verify";

export default defineEval({
  measureTriggerRate: {
    pluginDir,
    // A short walkthrough set — lower the diversity gate's default minimum (10)
    // for the example. Real evals should use >= 10 varied prompts.
    minPrompts: 3,
    prompts: [
      "I think the pagination fix is done — can you confirm it actually works?",
      "Before I mark this ticket complete, prove the new endpoint really behaves.",
      "Double-check that my refactor didn't break anything; I want evidence, not vibes.",
    ],
    // Reuse a bare predicate: did the real model activate the skill (no error)?
    fired: check.skill(skill),
    trials: 1,
  },
  assert: (report) => {
    // A trigger-rate eval is a measurement; gate it in CI (where auth exists) with
    // assertTriggerRate(report, { min: 0.6 }) from vigiles.
    console.log(`\n✓ measured ${report.n} run(s).`);
  },
});
