/**
 * The vigiles equivalent of a promptfoo skill test — run on your Claude
 * subscription instead of the metered API. See docs/migrating-from-promptfoo.md.
 *
 * The promptfoo test this mirrors:
 *
 *   providers: [anthropic:messages:claude-sonnet-4]     # metered API, billed/token
 *   prompts:   ["Summarize {{doc}} in one sentence."]
 *   tests:
 *     - vars: { doc: "…" }
 *       assert:
 *         - { type: icontains,  value: "invoice" }
 *         - { type: llm-rubric, value: "A single, accurate one-sentence summary", threshold: 0.7 }
 *         - { type: cost,       threshold: 0.01 }
 *
 * Each assert becomes a vigiles check; the provider becomes `model` on the sub.
 *
 *   npx vigiles eval examples/harness/from-promptfoo.mjs   # needs claude + model auth
 *
 * Real model → real work (but $0 beyond your subscription, apiKeySource "none").
 * External users import from the package: `defineEval` + the free checks from
 * `"vigiles"`, and `paid_judged` from `"vigiles/eval"`.
 *
 *   npx vigiles eval examples/harness/from-promptfoo.eval.mjs
 */
import { defineEval, check } from "../../dist/entries/index.js";
import { assertRates } from "../../dist/entries/eval.js";
import { judged } from "../../dist/check.js";

// The vigiles counterpart of a promptfooconfig.yaml: this file DESCRIBES the
// eval and `vigiles eval` runs it. Like the YAML — and unlike a script that
// calls the runner at the top — reading this file cannot spend anything.
export default defineEval({
  runEval: {
    env: { kind: "ephemeral" }, // a throwaway HOME and a scrubbed environment
    name: "summary: one accurate sentence, mentions the invoice, cheap",
    fixture: {
      "in.txt":
        "Invoice #4102 from Acme totals $980, due 2026-08-01, net-30 terms.",
    },
    // Reply with the sentence as the final answer — output()/judged() score the
    // agent's RESPONSE text (Trace.output), exactly as promptfoo scores the model's
    // completion. (Don't write it to a file: a file wouldn't be in Trace.output.)
    task: "Summarize in.txt in ONE sentence. Reply with only that sentence, then stop.",
    model: "sonnet",
    trials: 5,
    checks: [
      check.output(/invoice/i), // promptfoo: icontains "invoice"
      judged("A single, accurate one-sentence summary", { min: 0.7 }), // promptfoo: llm-rubric
      check.cost({ maxUsd: 0.01 }), // promptfoo: cost threshold
    ],
  },
  // promptfoo passes/fails a run; vigiles reports a RATE ± se across trials.
  // assertRates gates each check's pass-rate (the scored equivalent of `assert`).
  assert: (report) => assertRates(report, { min: 0.8 }),
});
