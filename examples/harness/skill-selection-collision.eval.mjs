/**
 * Canonical example — a skill *selection-collision* eval (`paid_measureSelectionMatrix`).
 *
 * Per-skill trigger-rate asks each skill in ISOLATION. It can't see the failure
 * that actually breaks a MULTI-skill plugin: one skill hijacking a SIBLING's
 * prompt. `paid_measureSelectionMatrix` installs the whole plugin, runs each skill's
 * own prompts against the entire set, and records WHICH skill fired — an N×N
 * matrix whose diagonal is recall and whose off-diagonal mass is collision.
 * `assertNoCollision` gates it: fail the build when a sibling steals the prompt.
 *
 *   npx vigiles eval examples/harness/skill-selection-collision.eval.mjs
 *
 * Claude-Code-only (it reads which skill the selector chose — Codex has no
 * skill-selection event), so it imports from `vigiles/harness/claude-code`. Prompts are
 * auto-derived from each skill's description here (zero setup); pass your own for
 * a curated benchmark. Real model → real cost; needs `claude` + auth + a built dist/.
 */
import { defineEval } from "../../dist/entries/index.js";
import { assertNoCollision } from "../../dist/entries/harness/claude-code.js";
import { fileURLToPath } from "node:url";

// A real, pinned vendored plugin with several skills — the case collisions matter.
const pluginDir = fileURLToPath(
  new URL("../../test/dogfood/superpowers@6fd4507", import.meta.url),
);

export default defineEval({
  measureSelectionMatrix: {
    // `paid_measureSelectionMatrix(dir, opts)` takes its directory positionally; a
    // description has no argument positions, so the directory is a field.
    pluginDir,
    // no `prompts` → auto-derived from each skill's description (zero setup)
    trials: 1,
  },
  assert: (report) => {
    // Gate: no skill may hijack a sibling's prompt more than 20% of the time.
    // (Loosen maxOffDiagonal, or set maxPluginCollision, to taste.)
    assertNoCollision(report, { maxOffDiagonal: 0.2 });
    console.log(`\n✓ no collisions above threshold across ${report.n} run(s).`);
  },
});
