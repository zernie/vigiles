/**
 * A/B — does applying OUR SPEC to a subagent actually help? (run on your sub)
 *
 * The measurement-authority experiment: take ONE code-reviewer subagent and run
 * the SAME review task two ways, changing only whether vigiles's typed contract
 * is applied. A controlled A/B (the review instruction is identical in both arms;
 * only the contract differs):
 *
 *   - arm `prose` — the reviewer WITHOUT a vigiles spec: a plain prose subagent
 *     that ends with a free-text summary (./reviewer-ab/prose/).
 *   - arm `spec`  — the SAME reviewer WITH our spec: a `result()` typed outcome
 *     (ends with a vigiles:ok/err block) + side-effect separation
 *     (`purity:"pure"` + disallowedTools) (./reviewer-ab/spec/, compiled from a
 *     .spec.ts).
 *
 * The claim being tested: the typed contract makes the outcome DETERMINISTICALLY
 * PARSEABLE (experimental_assertAgentOk, no LLM judge) at NO quality cost. So we read three
 * per-arm rates:
 *   1. `subagentRan` — the reviewer dispatched + read the file (both arms; proves
 *      the A/B is fair — the only difference is the contract, not whether it runs).
 *   2. `foundBug`    — it caught the planted defect (QUALITY — must stay ~equal;
 *      if `spec` < `prose` the contract HURT, and that's the finding).
 *   3. `typedOutcome`— the final turn carries a vigiles:ok/err block (only `spec`
 *      can pass — this is the payoff the contract BUYS: a free deterministic test
 *      instead of a model judge).
 *
 * Reading it: spec WINS iff foundBug(spec) ≈ foundBug(prose) AND typedOutcome(spec)
 * ≫ typedOutcome(prose). If foundBug drops on `spec`, the contract is net-negative
 * — exactly the kind of honest result this layer exists to surface.
 *
 *   npx vigiles eval examples/harness/dogfood/reviewer-ab.eval.mjs
 *   npx vigiles eval --trials=5 examples/harness/dogfood/reviewer-ab.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 *
 * CC DISCOVERIES this eval forced (now fixed in parseSubagents, see src/harness-test.ts):
 *   - a `--plugin-dir` agent's `subagent_type` is NAMESPACED `plugin:agent` (captured
 *     "reviewer-spec:code-reviewer"), so a bare-name `check.subagent("code-reviewer")` check
 *     must match the last `:`-segment;
 *   - the sub's `result()` vigiles:ok/err block lands in its RETURN — the dispatch's
 *     top-level tool_result — NOT in the lead's text and NOT in the sub's own assistant
 *     messages. So all three checks read the SUB's trace via `check.subagent(name,[…])`;
 *   - sonnet won't DELEGATE on a soft task (it reviews inline), so `allowedTools:["Task"]`
 *     forces it (the lead has no Read; the sub keeps its own).
 * VERDICT (2026-06-20, sonnet, 2 trials/arm — the tooling now works):
 *   check          prose   spec
 *   (1) sub ran     100%    100%   ← fair A/B (only the contract differs)
 *   (2) found bug   100%    100%   ← QUALITY: identical, no regression
 *   (3) typed block   0%    100%   ← PAYOFF: only the contract arm is parseable
 * So the spec HELPED: it makes the subagent's outcome DETERMINISTICALLY PARSEABLE
 * (experimental_assertAgentOk, no LLM judge) at ZERO quality cost. Categorical (0 vs 100, no
 * variance → no p-value needed). The "typed contracts make measurement affordable"
 * thesis, validated on vigiles's OWN contract. (NOTE: all three rows label as
 * "check.subagent(code-reviewer)" — they're nested checks; order is (1)/(2)/(3) above.)
 */
import { defineEval } from "../../../dist/test.js";
// Internal (not a public export): the per-check significance read.
import { compareCheck } from "../../../dist/eval.js";
import { check } from "../../../dist/check.js";
import { fileURLToPath } from "node:url";

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineEval({
  measureArms: {
    // A planted, unambiguous defect: `add` subtracts.
    fixture: {
      "app.js":
        "function add(a, b) { return a - b; } // should add\nmodule.exports = { add };\n",
    },
    task:
      "You have a `code-reviewer` subagent. DELEGATE the review of app.js to it " +
      "via the Task tool — do NOT read or review the file yourself. Then report " +
      "exactly what the subagent returned.",
    model: "sonnet",
    // Force delegation: the LEAD may only spawn a subagent (no Read/Grep of its
    // own), so it cannot review inline — it MUST dispatch code-reviewer (which has
    // its own Read). Removes the "lead reviewed it itself" confound the pilot found.
    allowedTools: ["Task"],
    trials: 3,
    arms: {
      prose: { pluginDir: dir("./reviewer-ab/prose") },
      spec: { pluginDir: dir("./reviewer-ab/spec") },
    },
    // All three read the SUBAGENT's trace/return (the contract lives in the SUB,
    // not the lead) — possible since the subagent nested-trace fix (namespaced
    // subagent_type + the sub's returned text are now recovered under --plugin-dir).
    checks: [
      // (1) the subagent ran + read the file — fair-A/B guard (both arms).
      check.subagent("code-reviewer", [check.tool("Read")]),
      // (2) QUALITY — the sub caught the subtract-instead-of-add bug. Stays ~equal.
      check.subagent("code-reviewer", [
        check.output(/subtract|a - b|minus|should add|wrong operator/i),
      ]),
      // (3) PAYOFF — the sub RETURNED a parseable typed block. Only `spec` can pass.
      check.subagent("code-reviewer", [check.output(/```vigiles:(ok|err)/)]),
    ],
  },
  assert: (report) => {
    for (const [name, r] of Object.entries(report.arms))
      if (r.n === 0) throw new Error(`arm "${name}": no runs executed`);

    // The significance read (Welch's t over the per-arm rates), prose = baseline:
    //   check 1 = foundBug (QUALITY) — want NOT significantly worse on `spec`.
    //   check 2 = typedOutcome (PAYOFF) — want significantly higher on `spec`.
    const pOf = (cmp) =>
      cmp && typeof cmp.p === "number" && Number.isFinite(cmp.p)
        ? `p=${cmp.p.toFixed(3)}`
        : "p=n/a (needs variance across ≥2 trials)";
    const quality = compareCheck(report, "prose", "spec", 1);
    const payoff = compareCheck(report, "prose", "spec", 2);
    console.log(`\nquality  (foundBug, spec vs prose):    ${pOf(quality)}`);
    console.log(`payoff   (typedOutcome, spec vs prose): ${pOf(payoff)}`);
    console.log(
      "\nVerdict: the spec HELPED iff quality did NOT regress (p high / spec≈prose) " +
        "AND payoff is a real win (p low, spec≫prose).",
    );
  },
});
