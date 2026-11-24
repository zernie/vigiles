/**
 * Canonical example — testing a COMPILED hook IN-PROCESS.
 *
 * The cheapest tier there is: a compiled hook's decision is a pure function, so
 * a test can load the hook FILE and call it directly — no subprocess, no exit
 * codes, no JSON plumbing, no `claude` binary, milliseconds.
 *
 *   loadHook(path)  ->  the hook object
 *   assertHookDenies / assertHookAllows      (gates)
 *   assertHookNotices / assertHookSilent     (reacts)
 *
 * Contrast with `hook-unit.harness.mjs`, which drives a hook as a PROCESS via
 * `runHook`. That tier is still the right one for a hand-written shell hook, or
 * to prove the WIRED artifact behaves end to end. For a compiled hook's LOGIC,
 * this one is strictly cheaper.
 *
 *   npx vigiles test examples/harness/compiled-hook-inprocess.harness.mjs
 *   node examples/harness/compiled-hook-inprocess.harness.mjs   # standalone
 *
 * External users import from the package: `from "vigiles/hook"`, the door of
 * the hook vocabulary these test. A hook
 * authored in TypeScript (`guard.hook.ts`) loads the same way, under tsx or
 * Node >= 23.6.
 */
import {
  loadHook,
  assertHookDenies,
  assertHookAllows,
  assertHookNotices,
  assertHookSilent,
} from "../../dist/hook.js";

// --- a GATE: load it by path, assert over its decisions ---------------------

const guard = await loadHook("examples/harness/protect-main.hook.mjs");

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

assertHookDenies(guard, bash("git push --force origin main"));
// The matcher is AST-backed, so the compound-command bypass is caught too.
assertHookDenies(guard, bash("cd repo && git commit -am wip && git push -f"));
assertHookAllows(guard, bash("git push origin main"));
assertHookAllows(guard, bash("git status"));
console.log("  ✓ gate: denies a force-push (however wrapped), allows the rest");

// --- a REACT: its notice goes to stderr AND (on an injectable event) stdout
// as additionalContext, so assert the REACTION itself, never a stream --------

const warn = await loadHook("examples/harness/warn-on-failure.hook.mjs");

const afterBash = (isError) => ({
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  tool_response: isError ? { error: "boom" } : { stdout: "ok" },
});

assertHookNotices(warn, afterBash(true), /read the error/);
assertHookSilent(warn, afterBash(false));
console.log("  ✓ react: notices on a failure, stays silent on success");

console.log("\n6 passed.");
