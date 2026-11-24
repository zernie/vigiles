/**
 * Real-`claude` dogfood of the refs-hook (deterministic tier, no API key).
 *
 * The earlier `runHook` test proves the hook's decision in isolation; this proves
 * it FIRES inside an actual `claude` session: the real CLI runs the PostToolUse
 * refs-hook against a scripted mock model that writes a CLAUDE.md naming an
 * unmarked linter rule, and we assert the non-blocking nudge made it back into
 * the model's context (the "fired ≠ landed" check via `check.received`).
 *
 *   node examples/harness/refs-nudge.harness.mjs
 *
 * Needs the `claude` CLI + a built dist/. Skips cleanly without claude.
 */
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { skip } from "../../dist/harness-assert.js";
import { check } from "../../dist/check.js";

if (!claudeAvailable()) skip("`claude` CLI not found");

const CLI = new URL("../../dist/cli.js", import.meta.url).pathname;

const r = await runHarnessTest({
  settings: {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: `node ${CLI} hook-runtime refs` },
          ],
        },
      ],
    },
  },
  model: scriptModel([
    {
      tool: "Write",
      input: {
        file_path: "CLAUDE.md",
        content: "Always enforce `eslint/no-console` across the repo.\n",
      },
    },
    { text: "done" },
  ]),
});

try {
  const reached =
    check.received("eslint/no-console").eval(r).pass &&
    check.received("unmarked linter-rule").eval(r).pass;
  if (!reached) {
    throw new Error(
      `refs-hook nudge did not reach the model ` +
        `(captured ${r.modelRequests.length} request(s))`,
    );
  }
  console.log(
    "  ✓ refs-hook nudged in a real claude session after a Write to CLAUDE.md",
  );
  console.log("\n1 passed.");
} catch (err) {
  console.log(`  ✗ ${err.message}\n\n1 failed.`);
  r.cleanup();
  process.exit(1);
}
r.cleanup();
