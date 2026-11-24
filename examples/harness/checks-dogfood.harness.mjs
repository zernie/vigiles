/**
 * Dogfood of the new check vocabulary on the DETERMINISTIC tiers (no API key).
 *
 * Exercises `assertChecks` + the strict-check path end to end:
 *   - hook scope (`runHook`): a PreToolUse Bash gate → `check.hookFired("PreToolUse", { blocked })`.
 *   - harness scope (`runHarnessTest`, mock model): a scripted run → `tool()`,
 *     `check.turns()`, `check.output()`.
 *
 * This is the revamped surface used for real (not just unit-tested with fakes).
 * Runs with the `claude` CLI and NO key:
 *   npx vigiles test examples/harness/checks-dogfood.harness.mjs
 */
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { runHook } from "../../dist/run-hook.js";
import { check, assertChecks } from "../../dist/check.js";

// --- hook scope: no claude needed, always runs ---
const gate =
  `CMD=$(cat | jq -r '.tool_input.command // empty'); ` +
  `case "$CMD" in *"--no-verify"*) echo blocked >&2; exit 2 ;; esac; exit 0`;
const ev = (command) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

assertChecks(runHook(gate, ev("git commit --no-verify")), [
  check.hookFired("PreToolUse", { blocked: true }),
]);
assertChecks(runHook(gate, ev("git commit -m ok")), [
  check.hookFired("PreToolUse", { blocked: false }),
]);
console.log("✓ hook checks: blocked --no-verify, allowed a clean commit");

// --- harness scope: real claude + scripted mock model (needs the binary) ---
if (!claudeAvailable()) {
  console.log("ℹ harness-scope checks need the `claude` CLI — skipping those");
} else {
  const r = await runHarnessTest({
    transcript: true,
    prompt: "do a couple of things then finish",
    model: scriptModel([
      { tool: "Bash", input: { command: "echo step-1" } },
      { text: "all done" },
    ]),
  });
  try {
    // turns + output are the reliable cross-version observables of a scripted
    // multi-turn run (tool-call capture depends on the plugin/permission setup —
    // see the fuller pluginDir tests in harness-test.test.ts).
    assertChecks(r, [check.turns({ min: 1 }), check.output(/done/)]);
    console.log(
      "✓ harness checks: agent took >=1 turn and finished with 'done'",
    );
  } finally {
    r.cleanup();
  }
}
