/**
 * Canonical example — a skill *trigger-rate* eval (`measureTriggerRate`).
 *
 * A skill's value is its description firing on the right task — the #1 documented
 * skill-authoring pain. Wiring (does the Skill tool resolve it) is the
 * deterministic tier's job; whether the *real model chooses* the skill across
 * varied phrasings is a property only the model can answer. `measureTriggerRate`
 * installs a plugin natively (`pluginDir`), runs a set of prompts, and reports
 * how reliably your `fired` predicate holds.
 *
 *   npx vigiles eval examples/harness/skill-trigger-rate.eval.mjs
 *   npx vigiles eval --trials=2 examples/harness/skill-trigger-rate.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth and a built dist/.
 * External users import from the package: `defineEval` + the free checks from
 * `"vigiles"`. An eval file declares its measurement; `vigiles eval` runs it.
 */
import { defineEval } from "../../dist/test.js";
import { skillResolved } from "../../dist/harness-assert.js";
import { fileURLToPath } from "node:url";

// A real, pinned vendored plugin (no clone at test time). Its TDD skill should
// activate when a task is about writing/changing code with tests.
const pluginDir = fileURLToPath(
  new URL("../../test/dogfood/superpowers@6fd4507", import.meta.url),
);
const skill = "superpowers:test-driven-development";

export default defineEval({
  measureTriggerRate: {
    // NAMED so `vigiles eval --update` writes a committed lock. It belongs HERE,
    // on the trigger-rate spec, NOT top-level on defineEval — measured 2026-09-09:
    // a top-level `name` is silently ignored (defineEval takes unknown keys without
    // complaint) and --update prints "skipped the lock for an unnamed eval", which
    // is the same message you get for having set nothing at all.
    name: "superpowers-tdd-trigger-rate",
    pluginDir,
    stubSkillBodies: true, // trigger = frontmatter only; stub the body to stop at selection
    // Aim for >= 10 varied phrasings — measureTriggerRate runs a deterministic
    // diversity gate (min count + near-duplicate NCD check) before
    // spending any tokens, so a thin or copy-pasted set is rejected up front.
    prompts: [
      "Add an `isEven(n)` function to utils.js — write it test-first.",
      "Implement a stack class in stack.js. Use TDD.",
      "Fix the off-by-one in paginate(); add a regression test first.",
      "Build a small LRU cache, driving it with failing tests first.",
      "Add a `slugify` helper — red/green/refactor please.",
      "Write a rate limiter; start from the tests and work outward.",
      "Implement currency rounding with a test-first approach.",
      "Add retry-with-backoff to the API client, tests leading.",
      "Create a debounce utility; specify behaviour as tests first.",
      "Parse ISO durations into seconds — write the spec before the code.",
    ],
    // reuse a bare predicate: did the model activate the skill (no error)?
    fired: (t) => skillResolved(t, skill),
    trials: 1,
  },
  assert: (report) => {
    // A trigger-rate eval is a measurement, not a hard gate by default — but you can
    // gate in CI with assertTriggerRate(report, { min: 0.6 }) from vigiles.
    if (report.n === 0) {
      throw new Error("no runs executed");
    }
    console.log(`\n✓ measured ${report.n} run(s).`);
  },
});
