/**
 * Dogfood — does vigiles's OWN `strengthen` skill trigger (and only then)?
 *
 * `strengthen` became model-invocable so the agent reaches for it on its own
 * (upgrade guidance() → enforce()). This eval is the guard that the sharpened
 * description FIRES on "strengthen my rules" requests (recall) and stays QUIET
 * on ordinary linting/coding work (precision) — the precision-aware axis the
 * AWS skill-eval taught us. Pairs with the free load gate in
 * src/adapters/claude-code/skills-dogfood.test.ts.
 *
 *   npx vigiles eval examples/harness/dogfood/strengthen.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../../dist/entries/index.js";
import { check } from "../../../dist/check.js";
import { assertRates } from "../../../dist/entries/eval.js";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(new URL("../../../", import.meta.url));
const skill = "vigiles:strengthen";

export default defineEval({
  measureTriggerRate: {
    pluginDir,
    stubSkillBodies: true, // trigger = frontmatter only; stub the body to stop at selection
    // SHOULD fire — requests to harden/strengthen vigiles rules (>= 10 varied):
    prompts: [
      "Strengthen the rules in my CLAUDE.md — upgrade the guidance ones where a linter rule exists.",
      "Can you make my vigiles guidance() rules enforceable by finding matching linter rules?",
      "Harden my spec: which guidance rules could become enforce()?",
      "I have prose conventions in my spec — back them with real linters where possible.",
      "Find ESLint rules that match the guidance I wrote about avoiding console logs.",
      "Turn my 'always handle errors' guidance into an enforced rule if a linter covers it.",
      "Review my spec for guidance that a Ruff or Clippy rule could enforce instead.",
      "Which of my guidance rules are actually enforceable by an existing linter?",
      "Promote my CLAUDE.md style conventions to enforced linter rules.",
      "Make my agent rules deterministic — promote the ones a linter already checks.",
    ],
    // should NOT fire — ordinary linting/coding the skill must not hijack:
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
