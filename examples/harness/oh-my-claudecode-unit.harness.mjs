/**
 * oh-my-claudecode walkthrough — Tier 1: unit-test a hook (`runHook`).
 *
 * The cheapest tier: hand a hook a synthesized event and check its decision —
 * no `claude`, no model, milliseconds. Here it's a REAL hook from a real,
 * pinned, vendored plugin (Yeachan-Heo/oh-my-claudecode, MIT — see
 * ../../test/dogfood/oh-my-claudecode@deee3a4/SOURCE), not a synthetic stand-in.
 *
 * The hook is OMC's `keyword-detector`: a `UserPromptSubmit` hook that scans the
 * prompt for a "magic keyword" and, on a hit, injects skill-routing
 * `additionalContext`. So the unit test is exactly "given this prompt, does the
 * hook inject the right routing?" — pure logic, reproducible.
 *
 *   npx vigiles test examples/harness/oh-my-claudecode-unit.harness.mjs
 *   node examples/harness/oh-my-claudecode-unit.harness.mjs        # standalone
 *
 * No `claude` needed. External users import from the package:
 * `from "vigiles"`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runHook } from "../../dist/run-hook.js";
import { check, assertChecks } from "../../dist/check.js";

const ROOT = fileURLToPath(
  new URL("../../test/dogfood/oh-my-claudecode@deee3a4", import.meta.url),
);
// The shipped hook command: the run.cjs wrapper invokes the detector script.
const command = `node "${ROOT}/scripts/run.cjs" "${ROOT}/scripts/keyword-detector.mjs"`;
// Throwaway HOME + OMC_STATE_DIR so the hook's state dir never touches the repo
// (OMC writes <cwd>/.omc unless OMC_STATE_DIR is set).
const tmp = mkdtempSync(join(tmpdir(), "omc-"));
const env = { CLAUDE_PLUGIN_ROOT: ROOT, HOME: tmp, OMC_STATE_DIR: tmp };

// We run this VENDORED, audited, pinned script directly (trusted). For a hook
// you have NOT audited, pass `{ trusted: false }` and runHook confines it under
// bubblewrap (no egress, cleared env) — or refuses if no sandbox is available.

// 1. A prompt carrying the keyword → routing context is injected.
const hit = runHook(
  command,
  { hook_event_name: "UserPromptSubmit", prompt: "please ultrawork on this" },
  { env },
);
assertChecks(hit, [check.hookFired("UserPromptSubmit", { blocked: false })]); // a context hook never blocks
const injected = hit.json?.hookSpecificOutput?.additionalContext ?? "";
if (!injected.includes("ULTRAWORK")) {
  throw new Error(
    `expected ULTRAWORK routing to be injected; got: ${injected}`,
  );
}

// 2. A plain prompt → no keyword, no routing injected.
const miss = runHook(
  command,
  {
    hook_event_name: "UserPromptSubmit",
    prompt: "what is the capital of France?",
  },
  { env },
);
assertChecks(miss, [check.hookFired("UserPromptSubmit", { blocked: false })]);
if (miss.json?.hookSpecificOutput?.additionalContext) {
  throw new Error("a plain prompt should not inject skill routing");
}

console.log(
  "  ✓ keyword-detector injects ULTRAWORK routing on the keyword, stays quiet otherwise",
);
console.log("\n2 passed.");
