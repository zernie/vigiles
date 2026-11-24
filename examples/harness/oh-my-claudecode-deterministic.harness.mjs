/**
 * oh-my-claudecode walkthrough — Tier 2: deterministic harness test
 * (`runHarnessTest`).
 *
 * Right logic (Tier 1) ≠ wired in correctly and reaching the model. This tier
 * runs the REAL `claude` CLI against a SCRIPTED mock model (no API key, same
 * result every time), with OMC's real `keyword-detector` hook wired on
 * `UserPromptSubmit`. It proves two things a "did it run?" check can't:
 *
 *   1. the hook actually FIRED in a real session, and
 *   2. its injected `additionalContext` actually LANDED in the model's request
 *      (`trace.modelRequests`) — "fired ≠ landed".
 *
 * The hook is wired via inline `settings` (code we authored here → trusted →
 * runs direct, no sandbox needed). Pointing `pluginDir` at the whole untrusted
 * plugin instead would run confined under bubblewrap by default.
 *
 *   npx vigiles test examples/harness/oh-my-claudecode-deterministic.harness.mjs
 *   node examples/harness/oh-my-claudecode-deterministic.harness.mjs   # standalone
 *
 * Needs the `claude` CLI (no API key) and a built dist/. External users import
 * from the package: `from "vigiles"`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { skip } from "../../dist/harness-assert.js";
import { check, assertChecks } from "../../dist/check.js";

if (!claudeAvailable()) skip("`claude` CLI not found");

const ROOT = fileURLToPath(
  new URL("../../test/dogfood/oh-my-claudecode@deee3a4", import.meta.url),
);
// Throwaway HOME + OMC_STATE_DIR so the hook's state dir never touches the repo
// (OMC writes <cwd>/.omc unless OMC_STATE_DIR is set).
const tmp = mkdtempSync(join(tmpdir(), "omc-det-"));
const command =
  `HOME="${tmp}" OMC_STATE_DIR="${tmp}" CLAUDE_PLUGIN_ROOT="${ROOT}" ` +
  `node "${ROOT}/scripts/run.cjs" "${ROOT}/scripts/keyword-detector.mjs"`;

const r = await runHarnessTest({
  settings: {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
  },
  prompt: "please ultrawork on this refactor",
  transcript: true,
  model: scriptModel([{ text: "on it" }]),
});

// The point of this tier: don't just check the hook *ran* — check its output
// actually reached the model. `check.received` inspects the real request
// (`trace.modelRequests`), so it proves both that the UserPromptSubmit hook fired
// AND that its injected routing LANDED in the model's context. (We assert the
// landing rather than a separate "fired" event because UserPromptSubmit hook-fire
// stream events aren't emitted by every claude version, whereas the landing — the
// thing you actually care about — is observable everywhere.)
try {
  assertChecks(r, [check.received("ULTRAWORK")]);
  console.log(
    "  ✓ the injected ULTRAWORK routing reached the model (the hook fired AND landed)",
  );
  console.log("\n1 passed.");
} catch (err) {
  console.log(
    `  ✗ injected routing did not reach the model\n      ${err.message}`,
  );
  console.log("\n1 failed.");
  process.exit(1);
}
