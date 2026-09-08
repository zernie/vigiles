/**
 * Tests for `runScript` (src/run-script.ts) — the general program runner that
 * `runHook` specializes.
 *
 * Two properties matter here and nowhere else:
 *
 *  1. **Both streams come back.** The bug that motivated the split: a hand-rolled
 *     `execFileSync` runner returns stdout ALONE on success, so advisory output
 *     (which tools, including vigiles's own compiled-hook `notice()`, write to
 *     stderr) silently disappears and a healthy react hook reports as dead.
 *  2. **A script result has no decision.** A HOOK has a decision; a SCRIPT has
 *     effects. Carrying an always-meaningless `decision` field would teach the
 *     reader the field means nothing, so the type must not have one.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScript, routeScriptRun } from "./run-script.js";
import { runHook } from "./run-hook.js";
import { assertNoWrite } from "./harness-assert.js";

/** A temp dir holding one script file. */
function scriptDir(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-runscript-"));
  writeFileSync(join(dir, name), body);
  return dir;
}

test("runs a plain program and returns exit code plus BOTH streams", () => {
  const dir = scriptDir(
    "check.sh",
    'echo "scanning..."\necho "0 broken links" >&2\nexit 0\n',
  );
  const r = runScript("bash check.sh", { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "scanning...\n");
  // The load-bearing one: an execFileSync-shaped runner drops exactly this.
  assert.equal(r.stderr, "0 broken links\n");
});

test("a script result carries NO decision — a script has effects, not a verdict", () => {
  const dir = scriptDir("ok.sh", "exit 0\n");
  const r: object = runScript("bash ok.sh", { cwd: dir });
  // These belong to the hook layer. Their absence is the point of the split:
  // a field that is always meaningless is worse than no field.
  assert.equal("decision" in r, false, "no decision on a script result");
  assert.equal("blocked" in r, false, "no blocked on a script result");
  assert.equal("json" in r, false, "no parsed hook JSON on a script result");
});

test("a non-zero exit is a RESULT, not an exception, and keeps both streams", () => {
  const dir = scriptDir("fail.sh", 'echo "partial"\necho "boom" >&2\nexit 3\n');
  const r = runScript("bash fail.sh", { cwd: dir });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, "partial\n");
  assert.equal(r.stderr, "boom\n");
});

test("stdin is optional, and delivered when given", () => {
  const dir = scriptDir("cat.sh", "cat\n");
  // No stdin: the program sees an empty stream and does not hang.
  assert.equal(runScript("bash cat.sh", { cwd: dir }).stdout, "");
  // With stdin: delivered verbatim.
  const r = runScript("bash cat.sh", { cwd: dir, stdin: "hello payload" });
  assert.equal(r.stdout, "hello payload");
});

test("env and cwd reach the program", () => {
  const dir = scriptDir("env.sh", 'echo "$GREETING at $(basename "$PWD")"\n');
  const r = runScript("bash env.sh", { cwd: dir, env: { GREETING: "hi" } });
  assert.match(r.stdout, /^hi at vigiles-runscript-/);
});

test("an unconfined run leaves filesWritten UNDEFINED, and write assertions refuse it", () => {
  // The script really does write. Recording writes requires confinement, so an
  // unconfined run knows nothing — and must say so rather than report a clean
  // bill of health.
  const dir = scriptDir("w.sh", "echo hi > made-a-file.txt\n");
  const r = runScript("bash w.sh", { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.ok(existsSync(join(dir, "made-a-file.txt")), "it really wrote");
  assert.equal(r.filesWritten, undefined, "unconfined records nothing");
  assert.throws(() => {
    assertNoWrite(r, "made-a-file.txt");
  }, /never recorded/i);
});

test("egress defaults to an empty record rather than undefined", () => {
  const dir = scriptDir("ok.sh", "exit 0\n");
  assert.deepEqual([...runScript("bash ok.sh", { cwd: dir }).egress], []);
});

test("runHook is runScript plus the hook protocol — same effects, plus a decision", () => {
  // Source-compatibility: the hook layer still delivers the event as JSON on
  // stdin and still reports a decision, while inheriting the script fields.
  const dir = scriptDir(
    "hook.sh",
    // Echo back the event it was handed, and deny.
    'cat > event.json\necho "guard ran" >&2\nexit 2\n',
  );
  const r = runHook(
    "bash hook.sh",
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
    { cwd: dir },
  );
  assert.equal(r.blocked, true, "exit 2 is a block");
  assert.equal(r.stderr, "guard ran\n", "script fields are inherited");
  const delivered: unknown = JSON.parse(
    readFileSync(join(dir, "event.json"), "utf-8"),
  );
  assert.deepEqual(delivered, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
  });
});

// ---------------------------------------------------------------------------
// routeScriptRun — the ONE confinement decision (Codex round 2, P1).
//
// The pre-flight in `experimental_verifyPluginGuards` must know whether a run
// will be confined BEFORE it runs anything, because a confined run starts in a
// fresh empty directory with a cleared environment. It used to answer with its
// own copy of the mode expression, and the copy did not know `recordEgress`
// confines. These pin the decision itself, so a future option that selects
// confinement cannot be added in one reader and missed in the other.
// ---------------------------------------------------------------------------

test("recordEgress routes to CONFINEMENT — the term the second copy missed", () => {
  const avail = { sandbox: true, egress: true };
  assert.equal(routeScriptRun({ recordEgress: true }, avail).kind, "sandboxed");
});

test("the ordinary routes are unchanged", () => {
  const avail = { sandbox: true, egress: true };
  assert.equal(routeScriptRun({}, avail).kind, "direct");
  assert.equal(routeScriptRun({ trusted: false }, avail).kind, "sandboxed");
  assert.equal(routeScriptRun({ sandbox: "strict" }, avail).kind, "sandboxed");
  assert.equal(
    routeScriptRun({ egress: { allow: ["x"] } }, avail).kind,
    "egress",
  );
  // An explicit opt-out still wins over the recordEgress default…
  assert.equal(
    routeScriptRun({ recordEgress: true, sandbox: false }, avail).kind,
    "direct",
  );
});

test("an unavailable sandbox REFUSES rather than silently running direct", () => {
  const r = routeScriptRun(
    { trusted: false },
    { sandbox: false, egress: false },
  );
  assert.equal(r.kind, "refuse");
  assert.match(r.kind === "refuse" ? r.reason : "", /without a sandbox/);
  const e = routeScriptRun(
    { egress: { allow: ["x"] } },
    { sandbox: true, egress: false },
  );
  assert.equal(e.kind, "refuse");
  assert.match(e.kind === "refuse" ? e.reason : "", /allowlist sandbox/);
});

test("every non-direct route reads as confined — including the refusal", () => {
  // What the sweep actually asks. A refusal is the CONFINED path: it is the run
  // that declined to happen unconfined, so pre-flighting it against this
  // process's cwd and env would describe an environment it would never have had.
  const avail = { sandbox: false, egress: false };
  for (const opts of [
    { trusted: false },
    { recordEgress: true },
    { egress: { allow: ["x"] } },
    { sandbox: "auto" as const },
  ])
    assert.notEqual(routeScriptRun(opts, avail).kind, "direct");
  assert.equal(routeScriptRun({}, avail).kind, "direct");
});
