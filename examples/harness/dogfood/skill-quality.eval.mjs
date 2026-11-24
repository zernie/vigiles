/**
 * Dogfood — the SCORED check evaluator on vigiles's OWN `strengthen` skill.
 *
 * Exercises the new eval-side checks together: does the skill FIRE
 * (`skill`), is its suggestion actually GOOD (`judged`, model-graded), and is the
 * run CHEAP (`cost`)? `measure` scores each across trials (rate ± se + pass^k);
 * `assertRates` gates them. This is the promptfoo-class scored path, dogfooded.
 *
 *   npx vigiles eval examples/harness/dogfood/skill-quality.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../../dist/test.js";
import { assertRates } from "../../../dist/eval-surface.js";
import { skill, judged, cost } from "../../../dist/check.js";
import { fileURLToPath } from "node:url";

// The vigiles plugin root (holds .claude-plugin/) — its skills activate natively.
const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));

export default defineEval({
  measure: {
    pluginDir,
    // A repo whose CLAUDE.md spec has a guidance() rule that a linter could enforce.
    fixture: {
      "CLAUDE.md.spec.ts": `import { instructionFile, guidance } from "vigiles/spec";
  export default instructionFile({ rules: {
    "no-console": guidance("Don't leave console.log calls in committed code."),
  } });`,
    },
    task: "Strengthen the guidance rules in my CLAUDE.md spec — find a real linter rule that could enforce each, instead of leaving it as prose.",
    model: "sonnet", // measure on the model your users actually run
    trials: 3,
    checks: [
      skill("vigiles:strengthen"), // the right skill fired
      judged(
        "1 if the response names a REAL linter rule (e.g. eslint/no-console, ruff/T201) that would enforce the 'no console.log' guidance; 0 if it's vague or invents a rule",
        { min: 0.6 },
      ),
      cost({ maxUsd: 0.1 }), // the run stayed cheap
    ],
  },
  assert: (report) => {
    // Gate: every check holds at least 60% of the time.
    assertRates(report, { min: 0.6 });
    console.log(
      "\n✓ strengthen: fires, suggests a real rule, and stays cheap.",
    );
  },
});
