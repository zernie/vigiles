/**
 * Dogfood — does the contributor-only `ship-a-feature` skill trigger (and only then)?
 *
 * `ship-a-feature` lives under `.claude/skills/` (this repo's own harness, not
 * the shipped plugin). It must FIRE when someone is about to add a capability /
 * export / public API to vigiles, and stay QUIET on the ordinary edits that
 * surround one — a bug fix, a refactor, a doc tweak, a test. The colocated
 * harness (`.claude/skills/ship-a-feature/ship-a-feature.harness.mjs`) proves
 * the skill's CHECKS fire on their defects; only a real model can prove the
 * DESCRIPTION fires on the right prompt, which is this file.
 *
 *   npx vigiles eval examples/harness/dogfood/ship-a-feature.trigger.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; runs where a key is.
 */
import { defineEval } from "../../../dist/test.js";
import { check } from "../../../dist/check.js";
import { assertTriggerRate } from "../../../dist/eval-surface.js";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(
  new URL("../../../.claude/skills/", import.meta.url),
);
const skill = "vigiles-loose-skills:ship-a-feature";

export default defineEval({
  measureTriggerRate: {
    skillsDir,
    stubSkillBodies: true, // trigger = frontmatter only; stop at selection
    // SHOULD fire — a new capability is about to exist (>= 10 for the diversity gate):
    prompts: [
      "Add a new export to vigiles that expands the disaster battery with equivalent commands.",
      "I want to ship a new public function on the vigiles root surface.",
      "Let's add a new subpath export, vigiles/providers, to the package.",
      "Implement a new hook-vocabulary word `touchesEnv()` for compiled hooks.",
      "Add a --effort flag to the eval CLI and expose it in the API.",
      "New feature: a helper that stubs MCP tool results for the eval tier.",
      "I've just written alternateSpellings in guardrail-check.ts — what's left to ship it?",
      "Expose parseHookOutput publicly so consumers can decode hook stdout.",
      "Add a new lint rule for hook matchers that name undeclared MCP servers.",
      "Build a new capability: measure how often two skills collide, as a public API.",
    ],
    // should NOT fire — everyday edits that are not a new capability:
    irrelevantPrompts: [
      "Fix the off-by-one in the frontmatter reader when the file starts with a BOM.",
      "Rename the internal helper posixly to toPosix.",
      "Tighten the wording in docs/compiled-hooks.md, the intro paragraph is long.",
      "Add a regression test for the compound git push bypass.",
      "Bump typescript to 5.9 and fix the two resulting type errors.",
      "Why does npm run check fail on the format stage?",
      "Refactor scan.ts so collectMcpServers is under 15 cognitive complexity.",
      "Update the README badge to point at the new CI workflow.",
      "Run the dogfood harness and tell me which tests are red.",
      "Remove the dead `dev/` folder reference from the CLAUDE.md layout section.",
    ],
    fired: check.skill(skill),
    trials: 1,
  },
  assert: (report) => {
    assertTriggerRate(report, { min: 0.7, maxFalsePositive: 0.2 });
    console.log(`\n✓ ${skill}: recall + precision within bounds.`);
  },
});
