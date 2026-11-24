/**
 * Canonical example — testing a COMPILED hook IN-PROCESS.
 *
 * The cheapest tier there is: a compiled hook's decision is a pure function, so
 * a test can load the hook FILE and call it directly — no subprocess, no exit
 * codes, no JSON plumbing, no `claude` binary, milliseconds.
 *
 *   experimental_loadHook(path)  ->  the hook object
 *   runHookProgram(hook, event)  ->  its outcome
 *   experimental_decision("deny" | "allow")        (gates)
 *   experimental_decision("notice" | "silent")     (reacts)
 *
 * Contrast with `hook-unit.harness.mjs`, which drives a hook as a PROCESS via
 * `runHook`. That tier is still the right one for a hand-written shell hook, or
 * to prove the WIRED artifact behaves end to end. For a compiled hook's LOGIC,
 * this one is strictly cheaper.
 *
 *   npx vigiles test examples/harness/compiled-hook-inprocess.harness.mjs
 *   node examples/harness/compiled-hook-inprocess.harness.mjs   # standalone
 *
 * External users import from the package: `from "vigiles/hook/testing"`, the
 * door for testing a hook (a hook itself may import only `vigiles/hook`). A hook
 * authored in TypeScript (`guard.hook.ts`) loads the same way, under tsx or
 * Node >= 23.6.
 */
import {
  experimental_decision,
  experimental_loadHook,
  runHookProgram,
} from "../../dist/entries/hook/testing.js";
import { assertChecks } from "../../dist/entries/index.js";

// --- a GATE: load it by path, assert over its decisions ---------------------

const guard = await experimental_loadHook(
  "examples/harness/protect-main.hook.mjs",
);

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

assertChecks(runHookProgram(guard, bash("git push --force origin main")), [
  experimental_decision("deny"),
]);
// The matcher is AST-backed, so the compound-command bypass is caught too.
assertChecks(
  runHookProgram(guard, bash("cd repo && git commit -am wip && git push -f")),
  [experimental_decision("deny")],
);
assertChecks(runHookProgram(guard, bash("git push origin main")), [
  experimental_decision("allow"),
]);
assertChecks(runHookProgram(guard, bash("git status")), [
  experimental_decision("allow"),
]);
console.log("  ✓ gate: denies a force-push (however wrapped), allows the rest");

// --- a REACT: its notice goes to stderr AND (on an injectable event) stdout
// as additionalContext, so assert the REACTION itself, never a stream --------

const warn = await experimental_loadHook(
  "examples/harness/warn-on-failure.hook.mjs",
);

const afterBash = (isError) => ({
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  tool_response: isError ? { error: "boom" } : { stdout: "ok" },
});

assertChecks(runHookProgram(warn, afterBash(true)), [
  experimental_decision("notice", /read the error/),
]);
assertChecks(runHookProgram(warn, afterBash(false)), [
  experimental_decision("silent"),
]);
console.log("  ✓ react: notices on a failure, stays silent on success");

console.log("\n6 passed.");
