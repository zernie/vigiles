/**
 * Canonical example — test the *whole assembled machine*, not one hook.
 *
 * The unit that matters in a plugin/repo is cohesion: do the hooks, settings,
 * CLAUDE.md and skills work *together*? `runHarnessTest({ plugin })` loads the
 * real harness from a plugin's `.claude-plugin/plugin.json` (resolving
 * `${CLAUDE_PLUGIN_ROOT}` to the real scripts), plus its CLAUDE.md and skills —
 * so you test what ships, not a hand-retyped subset.
 *
 * Here one `plugin:` load brings up two hooks at once — a SessionStart setup
 * hook and a PreToolUse Bash policy gate — and we assert both fire in a single
 * scenario. (Point `plugin` at your own repo / "./" to test yours.)
 *
 *   npx vigiles test examples/harness/plugin-cohesion.harness.mjs
 *   node examples/harness/plugin-cohesion.harness.mjs        # standalone
 *
 * Needs the `claude` CLI and a built dist/. External users import from the
 * package: `from "vigiles"`.
 */
import { fileURLToPath } from "node:url";
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { assertCreated, skip } from "../../dist/harness-assert.js";

if (!claudeAvailable()) skip("`claude` CLI not found");

const plugin = fileURLToPath(new URL("./fixture-plugin", import.meta.url));

// The run owns a temp directory; remove it in a `finally` so it goes even when
// an assertion throws. In TypeScript (5.2+) or on Node 24+,
// `await using r = await runHarnessTest(…)` does the same with no `finally`.
const r = await runHarnessTest({
  plugin, // fixture-plugin's real hooks (SessionStart + PreToolUse) + CLAUDE.md
  sandbox: false, // in-repo fixture we authored → trusted, run direct
  model: scriptModel([
    { tool: "Bash", input: { command: "rm -rf /tmp/should-be-blocked" } },
    { tool: "Bash", input: { command: "echo ok > RESULT" } },
    { text: "done" },
  ]),
});
try {
  assertCreated(r, "SETUP_DONE"); // SessionStart setup hook ran
  assertCreated(r, "BLOCKED"); // PreToolUse gate blocked `rm -rf`
  if (!(r.file("RESULT") ?? "").includes("ok")) {
    throw new Error("clean command did not run (RESULT missing 'ok')");
  }
  console.log("  ✓ SessionStart + PreToolUse gate + clean command all fired");
} finally {
  r.cleanup();
}

console.log("\n1 passed.");
