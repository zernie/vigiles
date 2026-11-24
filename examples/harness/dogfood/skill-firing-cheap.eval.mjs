/**
 * Dogfood — the CHEAP firing-only path: `measure` + `stubSkillBodies`.
 *
 * The sibling `skill-quality.eval.mjs` keeps each skill BODY because it grades
 * the suggestion (`judged`) — quality needs the body to run. This eval asks the
 * narrower, far cheaper question: does the `strengthen` skill reliably FIRE on a
 * strengthen request? Firing is a property of the frontmatter (name +
 * description), decided BEFORE the body loads — so `stubSkillBodies: true`
 * replaces each body with a no-op and the run stops AT selection instead of
 * executing the whole multi-step procedure.
 *
 * Measured on this repo's real skill: firing is identical (rate 1 either way),
 * but the stubbed run finished in ~49s vs ~889s full-body — an ~18x saving for
 * the SAME verdict. Stub when you're checking `check.skill()`/firing; DON'T stub when a
 * `judged`/quality check needs the body (there'd be nothing to grade).
 *
 *   npx vigiles eval examples/harness/dogfood/skill-firing-cheap.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../../dist/entries/index.js";
import { assertRates } from "../../../dist/entries/eval.js";
import { check } from "../../../dist/check.js";
import { fileURLToPath } from "node:url";

// The vigiles plugin root (holds .claude-plugin/) — its skills activate natively.
const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));

export default defineEval({
  measure: {
    pluginDir,
    stubSkillBodies: true, // measure SELECTION only — bodies stubbed, ~18x cheaper
    task: "Strengthen the vigiles rules in my CLAUDE.md spec: scan the guidance() rules and find existing linter rules that could back them as enforce(). Use the right skill for this.",
    model: "sonnet", // measure on the model your users actually run
    trials: 5,
    checks: [
      check.skill("vigiles:strengthen"), // the right skill fired
      check.latency({ maxMs: 180000 }), // a stubbed firing run is fast — no procedure runs
    ],
  },
  assert: (report) => {
    // Gate: the skill fires reliably (and the stubbed run stays fast).
    assertRates(report, { min: 0.8 });
    console.log(
      "\n✓ strengthen fires reliably — measured cheaply with bodies stubbed.",
    );
  },
});
