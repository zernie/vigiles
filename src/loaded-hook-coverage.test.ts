/**
 * THE IN-PROCESS TIER ATTRIBUTES WHAT IT EVALUATES.
 *
 * The documented cheapest path — `loadHook(file)` then `assertHookDenies(hook,
 * event)` — recorded a check and no SURFACE. The child exited a non-vacuous pass
 * with an empty `surfaces` list, `runsFromResults` discarded it, and a harness
 * that genuinely executed a compiled hook produced no execution record; the hook
 * showed as untested unless filename colocation happened to cover it.
 *
 * 🔴 A FALSE NEGATIVE, WHICH IS WHY THE BAR HERE IS THE HIGH ONE. Every other
 * coverage defect in this review was a false GRANT — credit for something that
 * never ran — and the cure was always "abstain when unsure". This is the mirror,
 * so the danger while fixing it is the opposite: recording too eagerly. The
 * assertions below pin the line at EVALUATION, and the quiet halves are the ones
 * that matter.
 */
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadHook } from "./load-hook.js";
import {
  assertHookDenies,
  assertHookAllows,
  assertHookNotices,
  assertHookSilent,
} from "./harness-assert.js";
import { runHookProgram } from "./core/hook-program.js";
import {
  surfacesRecorded,
  resetCheckCount,
  checksRecorded,
} from "./check-count.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const HOOK_ENTRY = resolve(__dirname, "..", "dist", "hook.js");

const GATE = `import { experimental_defineHook, tool, deny, allow } from ${JSON.stringify(HOOK_ENTRY)};
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true }) ? deny("no force-push") : allow(),
});
`;

const REACT = `import { experimental_defineReact, tools, notice, nothing } from ${JSON.stringify(HOOK_ENTRY)};
export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Write"),
  react: (e) => (e.path.under(["src"]) ? notice("typescript touched") : nothing()),
});
`;

const bash = (command: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

let dir: string;

/** Write a hook under a tmp cwd and hand back the repo-relative path. */
function fixture(name: string, body: string): string {
  dir = makeTmpDir("loaded-hook-cov");
  mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
  const rel = `.vigiles/hooks/${name}`;
  writeFileSync(join(dir, rel), body);
  process.chdir(dir);
  return rel;
}

beforeEach(() => {
  resetCheckCount();
});

test("FIRES: evaluating a LOADED hook attributes the file it was loaded from", async () => {
  const rel = fixture("guard.mjs", GATE);
  const hook = await loadHook(rel);

  // 🔴 THE QUIET HALF FIRST, because it is the one a careless fix breaks:
  // loading is not running. Someone loading a hook to inspect its shape has not
  // executed it, and crediting that would be the "an empty file counts"
  // substitution the execution tier exists to remove.
  assert.deepEqual(surfacesRecorded(), [], "a LOAD must attribute nothing");
  assert.equal(checksRecorded(), 0, "…and must not count as a check either");

  // Now evaluate it. The path is exact by construction — `loadHook` resolved it,
  // so there is no command string to parse and nothing to guess.
  assertHookDenies(hook, bash("git push --force"));
  assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: rel }]);
  assert.equal(checksRecorded(), 1);

  // A second evaluation of the same hook names it once (check-count dedupes).
  assertHookAllows(hook, bash("git status"));
  assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: rel }]);
  assert.equal(checksRecorded(), 2, "…while the CHECK count still moves");
  cleanupTmpDir(dir);
});

test("…and every in-process assertion attributes, not just the gate pair", async () => {
  // All four funnel through one place, so none of them can be added later
  // without inheriting the attribution — that is the point of the chokepoint.
  const rel = fixture("react.mjs", REACT);
  const hook = await loadHook(rel);
  const edit = (file_path: string) => ({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path },
  });
  assertHookNotices(hook, edit("src/a.ts"), "typescript");
  assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: rel }]);

  resetCheckCount();
  assertHookSilent(hook, edit("README.md"));
  assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: rel }]);
  cleanupTmpDir(dir);
});

test("QUIET: a hook built IN-PROCESS has no file, so nothing is invented", async () => {
  // There is no path to name, and the tier's first rule is that an unresolvable
  // reference is never guessed into a match. A missed record, never a false one.
  const rel = fixture("guard.mjs", GATE);
  const { experimental_defineHook: experimental_defineHook, deny } =
    (await import(HOOK_ENTRY)) as {
      experimental_defineHook: (o: unknown) => unknown;
      tool: (n: string) => unknown;
      deny: (r: string) => unknown;
    };
  const inline = experimental_defineHook({
    on: "PreToolUse",
    decide: () => deny("x"),
  }) as Parameters<typeof assertHookDenies>[0];
  assertHookDenies(inline, bash("anything"));
  assert.deepEqual(surfacesRecorded(), []);
  assert.equal(checksRecorded(), 1, "it still COUNTS as a check — it did run");

  // …and the loaded one still attributes in the same process, so the emptiness
  // above is about the hook's origin and not about the recorder being off.
  const loaded = await loadHook(rel);
  assertHookDenies(loaded, bash("git push --force"));
  assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: rel }]);
  cleanupTmpDir(dir);
});

test("QUIET: the PURE evaluator attributes nothing — production must not record", async () => {
  // `runHookProgram` is public via `vigiles/hook` AND is what the CLI's
  // `hook-runtime run-program` calls on every live event. Recording there would
  // make the pure decision impure and fire outside any test.
  const rel = fixture("guard.mjs", GATE);
  const hook = await loadHook(rel);
  runHookProgram(hook, bash("git push --force"));
  assert.deepEqual(surfacesRecorded(), []);
  assert.equal(checksRecorded(), 0);
  cleanupTmpDir(dir);
});
