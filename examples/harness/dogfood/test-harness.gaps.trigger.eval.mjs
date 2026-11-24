/**
 * Dogfood — the FIELD-MISS trigger set for `test-harness`.
 *
 * Companion to `test-harness.trigger.eval.mjs`. That eval measures the prompts we
 * *imagined* while authoring the description, and scores recall 0.90 on Sonnet.
 * This one measures the prompts that ACTUALLY MISSED in live work.
 *
 * Provenance (2026-08-10, dogfooding vigiles from a sibling repo): an agent with
 * the vigiles plugin available reinvented four things the library already ships —
 * `parseToolCalls`, `snapshotTree`/`diffTrees`, `interceptTools`, and the whole
 * effect-boundary tier. The four prompts below are those four moments, restated
 * as the question the agent was actually holding at the time.
 *
 * The hypothesis this measures: the description enumerates SURFACES
 * ("a hook fires or blocks", "a skill triggers", "injected context lands") but
 * never names the OBSERVATION VOCABULARY — tool boundaries, side effects,
 * interception. So a user who asks about the observation, not the surface, misses.
 *
 * Two matched sets isolate that from a language confound: the misses happened in
 * Russian, but the description is English. If RU and EN score the same, the gap is
 * conceptual (a description fix); if RU scores much lower, it is cross-lingual
 * selection (a different fix entirely).
 *
 *   npx vigiles eval examples/harness/dogfood/test-harness.gaps.trigger.eval.mjs
 *   npx vigiles eval --trials=2 examples/harness/dogfood/test-harness.gaps.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 *
 * NOTE ON THE GATE: `minPrompts` is lowered to 4 deliberately. Four prompts cannot
 * separate a rate from noise — this set is not a rate, it is four NAMED CASES we
 * already know occurred. Read it as pass/fail per case, not as a recall estimate.
 */
// vigiles:covers skills/test-harness
import { defineEval } from "../../../dist/entries/index.js";
import { check } from "../../../dist/check.js";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));
const skill = "vigiles:test-harness";

/** The four live misses, in the language they were asked in. */
const RU = [
  "как проверить, что скилл не вышел за свои инструменты",
  "как наблюдать побочные эффекты скилла",
  "как перехватить вызов, не дав ему исполниться",
  "как протестировать скилл",
];

/** The same four questions in English — isolates concept-gap from language. */
const EN = [
  "how do I check that a skill did not go outside the tools it declared",
  "how can I observe the side effects a skill produces",
  "how do I intercept a tool call without letting it actually execute",
  "how do I test a skill",
];

// 🔴 THIS FILE USED TO CALL THE RUNNER TWICE, IN A `for` LOOP OVER THE TWO SETS —
// the one shape in the repo that a single-measurement description cannot copy
// literally. It is ONE run now, over both sets concatenated, and the RU/EN split
// is recovered in `assert` from `perPrompt`, which reports each prompt by name.
//
// Behaviour-preserving for everything this file actually did: same prompts, same
// trials per prompt, same tokens, and the per-prompt verdict below is the only
// thing it ever computed (the aggregate per-set rate was printed, never asserted;
// the table in the FINDING is a recorded measurement, not a computed one). The
// per-set framing moved from WHEN the runs happen to HOW the results are read —
// which is where it belonged, because it was always a property of the prompts.
export default defineEval({
  measureTriggerRate: {
    pluginDir,
    stubSkillBodies: true,
    minPrompts: 4, // deliberate: named cases, not a rate (see header)
    prompts: [...RU, ...EN],
    fired: check.skill(skill),
    trials: 1,
  },

  // FINDING (2026-08-10). Measured on Sonnet, 2 trials/prompt, whole-harness
  // (5 competing skills), across four descriptions of the same skill:
  //
  //   description                                  RU gaps   EN gaps   authored   FP
  //   original (surfaces only)                        25%       25%       90%      —
  //   + observation vocabulary, 594ch                100%      100%       90%      0%
  //   + observation vocabulary, 460ch (SHIPPED)       75%      100%       90%      0%
  //   + observation vocabulary, 595ch                 88%      100%        —       —
  //
  // Two things this says, and one it does NOT:
  //  - naming the observation vocabulary is what moved the number: 2/8 → 6-8/8.
  //    That difference is large and repeated across two languages.
  //  - RU and EN scored IDENTICALLY (25/25) before the fix, prompt for prompt,
  //    which rules out a language effect: the gap was conceptual.
  //  - it does NOT establish that a longer description beats a shorter one. At
  //    n=8 the 75/88/100 spread is one-to-two runs. The shipped text is the one
  //    that fits the 500-char description budget the linter enforces, because
  //    the evidence cannot distinguish the variants and the budget rule is the
  //    project's own documented heuristic.
  //
  // Isolated-vs-whole-harness caveat still applies UPWARD: 5 competitors is far
  // fewer than a populated user harness, so these rates are an upper bound.
  assert: (report) => {
    const sets = [
      ["RU (as actually asked)", RU],
      ["EN (same questions)", EN],
    ];
    console.log("\n===== per-prompt verdict =====");
    for (const [label, prompts] of sets) {
      console.log(`\n${label}`);
      for (const p of report.perPrompt ?? [])
        if (prompts.includes(p.prompt))
          console.log(
            `  ${p.rate > 0 ? "FIRED " : "MISSED"}  ${String(p.rate)}  ${p.prompt}`,
          );
    }
  },
});
