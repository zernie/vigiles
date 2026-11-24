/**
 * Dogfood — the `subagent` (nested-trace) check on a REAL subagent.
 *
 * vigiles's own plugin ships no subagents, so we dogfood on the vendored,
 * pinned **oh-my-claudecode** plugin, which registers a `code-reviewer` agent.
 * `measure` drives a task that should dispatch it via the `Task` tool;
 * `check.subagent("code-reviewer", [checks])` then runs the check vocabulary over what
 * the SUBAGENT did (recovered from `parent_tool_use_id` — see parseSubagents).
 *
 *   npx vigiles eval examples/harness/subagent.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth + a built dist/.
 * Write-don't-run in a keyless env; this is the artifact that runs where a key is.
 */
import { defineEval } from "../../dist/entries/index.js";
import { assertRates } from "../../dist/entries/eval.js";
import { check } from "../../dist/check.js";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(
  new URL("../../test/dogfood/oh-my-claudecode@deee3a4", import.meta.url),
);

export default defineEval({
  measure: {
    pluginDir,
    fixture: {
      "app.js": `function add(a, b) { return a - b; } // bug: subtracts\nmodule.exports = { add };\n`,
    },
    task: "Use your code-reviewer subagent to review app.js and report any defects.",
    model: "sonnet",
    trials: 3,
    checks: [
      // The code-reviewer subagent ran AND read the file (asserting what the
      // SUBAGENT did, not just that Task fired — the nested-trace capability).
      check.subagent("code-reviewer", [check.tool("Read")]),
    ],
  },
  assert: (report) => {
    assertRates(report, { min: 0.5 });
    console.log("\n✓ code-reviewer subagent ran and inspected the file.");
  },
});
