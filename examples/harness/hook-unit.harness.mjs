/**
 * Canonical example — the *unit* tier for a hook.
 *
 * A hook is just a process: Claude Code pipes a JSON event to its stdin and
 * reads back an exit code (2 = block) and an optional JSON decision on stdout.
 * `runHook` drives exactly that — no `claude` binary, no model, no sandbox — so
 * a hook's logic is testable in milliseconds and in CI for free.
 *
 * Unlike the other *.harness.mjs examples, this one does NOT need the `claude`
 * CLI: it tests the hook in isolation. That is the point of this tier — it is
 * the cheap base of the pyramid, and the only tier that reaches every event
 * (here a Bash PreToolUse guard, but Edit/Write/PreCompact/etc. are identical:
 * just hand the hook the event JSON).
 *
 *   npx vigiles test examples/harness/hook-unit.harness.mjs
 *   node examples/harness/hook-unit.harness.mjs        # standalone
 *
 * External users import from the package: `from "vigiles"`.
 */
import { runHook } from "../../dist/run-hook.js";
import { check, assertChecks } from "../../dist/check.js";

// A block-no-verify–style guard: deny any Bash command carrying --no-verify.
// In a real plugin this is the shipped hook script; here it's inline so the
// example is self-contained.
const guard = `node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const ev = JSON.parse(s);
    const cmd = String((ev.tool_input && ev.tool_input.command) || "");
    if (/--no-verify|--no-gpg-sign/.test(cmd)) {
      console.error("blocked: bypass flag");
      process.exit(2);
    }
  });'`;

const blocked = runHook(guard, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git commit --no-verify -m wip" },
});
assertChecks(blocked, [check.hookFired("PreToolUse", { blocked: true })]);

const allowed = runHook(guard, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git commit -m wip" },
});
assertChecks(allowed, [check.hookFired("PreToolUse", { blocked: false })]);

console.log(
  "  ✓ guard blocks --no-verify and allows a clean commit (no claude needed)",
);
console.log("\n2 passed.");
