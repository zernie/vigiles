/**
 * Shell-variable-read suite (vitest, unit tier — parses strings, runs nothing).
 *
 * The load-bearing cases are the two a regex gets wrong, since they are why this
 * module exists: a variable the command ASSIGNS before expanding, and a `$NAME`
 * inside SINGLE QUOTES, where the shell performs no expansion at all. Beside
 * them, the conservative direction is pinned in both places it shows: a parse
 * failure falls back to the regex and SAYS so, and an expansion with a default
 * is still reported as a read.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { shellVarReads } from "./shell-vars.js";

test("a plain expansion is a read", () => {
  const r = shellVarReads('node "$CLAUDE_PLUGIN_ROOT"/hooks/guard.cjs');
  assert.deepEqual(r.reads, ["CLAUDE_PLUGIN_ROOT"]);
  assert.equal(r.parsed, true);
});

test("both spellings are the same name, reported once", () => {
  assert.deepEqual(shellVarReads('echo "$FOO ${FOO}"').reads, ["FOO"]);
});

test("a variable the command ASSIGNS FIRST is not a dependency", () => {
  // The shell sets GUARD before expanding it — the command is self-contained.
  assert.deepEqual(shellVarReads('GUARD=hooks/g.sh; "$GUARD"').reads, []);
});

// 🔴 THE TWO ASSERTIONS BELOW USED TO CLAIM THE OPPOSITE, and both were wrong —
// not by argument, but against `/bin/sh` with the variable exported first:
//
//   export FOO=ambient; FOO=1 sh -c "echo $FOO"   → ambient
//   export X=ambient;   echo "$X"; X=1            → ambient
//
// In both, the expansion really does read the ENVIRONMENT, so the sweep that
// treated them as self-contained ran a differently-configured program and
// scored it. The old tests were the defect, written down.

test("a PREFIX assignment does not cover its own command's expansion", () => {
  assert.deepEqual(shellVarReads('FOO=1 sh -c "echo $FOO"').reads, ["FOO"]);
});

test("an assignment does NOT cover a read that appears before it", () => {
  assert.deepEqual(shellVarReads('echo "$X"; X=1').reads, ["X"]);
});

test("a `$NAME` in SINGLE quotes is not an expansion", () => {
  assert.deepEqual(shellVarReads("echo '$NOT_A_VAR'").reads, []);
  // …but the same name in double quotes still is.
  assert.deepEqual(shellVarReads('echo "$IS_A_VAR"').reads, ["IS_A_VAR"]);
});

test("positional and special parameters are never reads", () => {
  assert.deepEqual(shellVarReads('echo "$1" "$@" "$?" "$$"').reads, []);
});

test("an expansion with a default is STILL a read (conservative)", () => {
  // It always resolves, so this over-reports. The cost of that direction is one
  // unmeasured hook; the other direction measures a differently-configured one.
  assert.deepEqual(shellVarReads("echo ${FOO:-default}").reads, ["FOO"]);
});

test("a command the parser REJECTS falls back, and says so", () => {
  const r = shellVarReads('echo "$UNCLOSED');
  assert.equal(r.parsed, false);
  assert.deepEqual(r.reads, ["UNCLOSED"]);
});

test("no expansions at all", () => {
  const r = shellVarReads("echo hello");
  assert.deepEqual(r.reads, []);
  assert.equal(r.parsed, true);
});

// ---------------------------------------------------------------------------
// EXECUTION ORDER. Subtracting every assigned name globally was the parser
// rewrite's own new way to be wrong: it removed two regex mistakes and added a
// third, in the direction that costs the guarantee rather than a measurement.
// The rule is DOMINANCE — an assignment excuses only the reads it provably
// happens before, in the same shell.
// ---------------------------------------------------------------------------

test("a read BEFORE the assignment is still a read", () => {
  // The shell expands `$GUARD` from the environment here; the later assignment
  // cannot reach backwards in time. Subtracting it ran a different program.
  assert.deepEqual(shellVarReads('echo "$GUARD"; GUARD=hooks/g.sh').reads, [
    "GUARD",
  ]);
});

test("an assignment inside a SUBSHELL does not escape it", () => {
  // `(GUARD=x)` sets it in a child; the parent's expansion still reads the
  // environment, so the name is a genuine dependency.
  assert.deepEqual(shellVarReads('(GUARD=x); "$GUARD"').reads, ["GUARD"]);
});

test("an assignment that DOES dominate the read still excuses it", () => {
  // The half that must not regress: this is a self-contained command, and
  // calling it unresolvable is what sent real guards unmeasured.
  assert.deepEqual(shellVarReads('GUARD=hooks/g.sh; "$GUARD"').reads, []);
});

test("a PREFIX assignment excuses nothing — not even its own command", () => {
  // Measured against /bin/sh, which is why the rule is not the obvious one:
  //   VP=prefix printf '[%s]' "$VP"  → []      it does not reach its own words
  //   VT=prefix true; printf "$VT"   → []      …nor outlive the command
  assert.deepEqual(shellVarReads('GUARD=echo "$GUARD"').reads, ["GUARD"]);
  assert.deepEqual(shellVarReads('GUARD=echo true; "$GUARD"').reads, ["GUARD"]);
});

test("`export NAME=value` DOES persist", () => {
  assert.deepEqual(shellVarReads('export GUARD=echo; "$GUARD"').reads, []);
});

// --- Control flow, not source order. Every command below was run against
// --- `/bin/sh` with the name exported first; the comment states what it printed.

test("an assignment the shell may SKIP excuses nothing", () => {
  // MODE=safe sh -c 'false && MODE=other; [ "$MODE" = safe ] && exit 2' → 2
  // The ambient value is what the guard branches on, so it IS a dependency.
  assert.deepEqual(
    shellVarReads('false && MODE=safe; [ "$MODE" = safe ] && exit 2').reads,
    ["MODE"],
  );
});

test("an assignment inside an `if` excuses nothing", () => {
  assert.deepEqual(shellVarReads('if false; then M=x; fi; echo "$M"').reads, [
    "M",
  ]);
});

test("a BACKGROUNDED assignment never reaches the read", () => {
  // `&` detaches into a subshell — the old rule saw only an earlier offset.
  assert.deepEqual(shellVarReads('M=x & echo "$M"').reads, ["M"]);
});

test("an assignment in a PIPELINE component is discarded with it", () => {
  assert.deepEqual(shellVarReads('true | M=x; echo "$M"').reads, ["M"]);
});

test("an assignment inside a loop or a case excuses nothing", () => {
  assert.deepEqual(
    shellVarReads('while false; do M=x; done; echo "$M"').reads,
    ["M"],
  );
  assert.deepEqual(shellVarReads('case y in x) M=1;; esac; echo "$M"').reads, [
    "M",
  ]);
});

test("the ordinary unconditional assignment STILL excuses its read", () => {
  // The other direction, or the rule is just "report everything": a plain
  // top-level `NAME=value` is exactly the shape that does persist and dominate.
  assert.deepEqual(
    shellVarReads('M=safe; [ "$M" = safe ] && exit 2').reads,
    [],
  );
  assert.deepEqual(shellVarReads('GUARD=hooks/g.sh; "$GUARD"').reads, []);
});

test("an assignment does NOT excuse a read inside its own initializer", () => {
  // Codex round 2, P1. The shell expands the RHS and only THEN binds the name,
  // so `MODE="$MODE"` genuinely reads the environment. Keyed on the assignment's
  // START offset it did not: the walk is preorder, so the `Assign` was recorded
  // before its own `ParamExp` was visited and the read looked dominated. Under
  // confinement the sweep would then clear an ambient `MODE` without reporting
  // it unresolved, and score whichever branch the empty value took.
  assert.deepEqual(
    shellVarReads('MODE="$MODE"; [ "$MODE" = strict ] && exit 2').reads,
    ["MODE"],
  );
  assert.deepEqual(shellVarReads('PATH="$PATH:/opt/bin"; echo hi').reads, [
    "PATH",
  ]);
  assert.deepEqual(shellVarReads('export M="${M}x"; echo "$M"').reads, ["M"]);
});

test("…and the read of a DIFFERENT name in an initializer still stands", () => {
  // The initializer's own reads are reported; the name being bound is still
  // dominated for every read AFTER the statement.
  assert.deepEqual(shellVarReads('MODE="$OTHER"; echo "$MODE"').reads, [
    "OTHER",
  ]);
});

test("…and genuine dominance is UNCHANGED", () => {
  // The other direction, or the fix is just "report everything again": a plain
  // assignment whose RHS names nothing still excuses every later read.
  assert.deepEqual(
    shellVarReads('M=safe; [ "$M" = safe ] && exit 2').reads,
    [],
  );
  assert.deepEqual(shellVarReads('GUARD=hooks/g.sh; "$GUARD"').reads, []);
  // …and a read BEFORE the assignment still stands, which is the bug the
  // offset comparison was introduced for in the first place.
  assert.deepEqual(shellVarReads('echo "$M"; M=safe').reads, ["M"]);
});
