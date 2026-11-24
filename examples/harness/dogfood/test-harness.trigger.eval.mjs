/**
 * Dogfood — does vigiles's OWN `test-harness` skill trigger (and only then)?
 *
 * We eat our own dog food: point `measureTriggerRate` at the vigiles plugin
 * itself and check the `test-harness` skill's description on the precision-aware
 * axis the AWS skill-eval taught us — it should FIRE on harness-testing requests
 * (recall) and stay QUIET on unrelated coding work (precision). The
 * model-invocable shipped skills (`test-harness`, `strengthen`, `edit-spec`)
 * each get a trigger eval; the user-invoked ones (`adopt-spec`,
 * `linter-docs`) can't auto-fire, so triggering doesn't apply — see
 * `src/adapters/claude-code/skills-dogfood.test.ts` for the (free) load gate
 * that covers every shipped skill.
 *
 *   npx vigiles eval examples/harness/dogfood/test-harness.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../../dist/entries/index.js";
import { check } from "../../../dist/check.js";
import { assertRates } from "../../../dist/entries/eval.js";
import { fileURLToPath } from "node:url";

// The vigiles plugin root (the dir that holds .claude-plugin/), installed
// natively so its skills activate by description the real way.
const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));
const skill = "vigiles:test-harness";

export default defineEval({
  measureTriggerRate: {
    pluginDir,
    stubSkillBodies: true, // trigger = frontmatter only; stub the body to stop at selection
    // SHOULD fire — harness-testing requests in varied phrasings (>= 10, the
    // diversity gate rejects a too-small or near-duplicate set before any run):
    prompts: [
      "Write a test that my PreToolUse hook blocks `git commit --no-verify`.",
      "Does my SessionStart hook actually inject context into the model? Add a test.",
      "Check that my skill triggers across different prompts.",
      "Verify my Stop hook fires when the agent finishes a turn.",
      "I want to know if my CLAUDE.md rule actually changes the agent's behavior — measure it.",
      "Set up an eval comparing my hook switched on versus off.",
      "Prove my settings.json permissions really block the Write tool.",
      "How reliably does my subagent get dispatched? Measure the trigger rate.",
      "Confirm the injected context from my hook reaches the model.",
      "Add a deterministic check that my PostToolUse hook runs the formatter.",
    ],
    // should NOT fire — ordinary coding work the skill must not hijack:
    irrelevantPrompts: [
      "Rename the variable `foo` to `bar` in utils.ts.",
      "Add a dark-mode toggle to the settings page.",
      "Why is this regex throwing? Fix it.",
      "Convert this callback-based code to async/await.",
      "Write a SQL migration to add an index on users.email.",
      "Bump the lodash dependency and fix the breaking changes.",
      "Implement pagination for the search results endpoint.",
      "Refactor this 200-line function into smaller pieces.",
      "Add input validation to the signup form.",
      "Fix the off-by-one error in the date picker.",
    ],
    fired: check.skill(skill),
    trials: 1,
  },
  assert: (report) => {
    // The dogfood bar: a model-invocable ("auto") skill must fire on real harness
    // work at least 80% of the time (recall) and rarely on noise (precision).
    assertRates(report, { min: 0.8, maxFalsePositive: 0.3 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);

    // FINDING (2026-06-17): MEASURE ON SONNET. On claude-haiku-4-5 this skill scored
    // recall 0.50 (missed every "eval/measure/trigger-rate" phrasing) and FAILED the
    // ≥0.8 bar; on claude-sonnet-4-6 it scored 0.90 and passed — the descriptions are
    // fine, haiku is just a weaker SELECTOR. Trigger-rate is a selection measurement,
    // so it must run on the model users actually run (Sonnet), not a cheap haiku.
  },
});
