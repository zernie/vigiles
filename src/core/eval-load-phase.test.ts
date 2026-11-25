/**
 * The no-spend window: closed while the eval runner imports an eval file.
 *
 * BOTH halves, for every check here — it fires on a planted defect AND it is
 * silent on the clean case. An advisory that is only ever silent is
 * indistinguishable from dead code, and this repository has shipped three such.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import {
  beginEvalLoad,
  endEvalLoad,
  evalLoadRefusal,
  inEvalLoad,
  refuseDuringEvalLoad,
} from "./eval-load-phase.js";

test("the window is CLOSED by default — a direct `paid_runEval(…)` call is nobody's business but the caller's", () => {
  // The quiet half, and the one that matters most: a gate defaulting to closed
  // would refuse every correct direct call of the public paid API, which is the
  // exact failure that got `process.env.VITEST` rejected in foreign-runner.ts.
  assert.equal(inEvalLoad(), false);
  refuseDuringEvalLoad("spawning `claude`"); // does not throw
});

test("inside the window the paid tier refuses, and the message teaches the new shape", () => {
  beginEvalLoad();
  try {
    assert.equal(inEvalLoad(), true);
    assert.throws(() => {
      refuseDuringEvalLoad("measureTriggerRate");
    }, /refused to spawn a model/);
  } finally {
    endEvalLoad();
  }
  assert.equal(inEvalLoad(), false);
});

test("endEvalLoad reopens it even when the import threw", () => {
  beginEvalLoad();
  endEvalLoad();
  refuseDuringEvalLoad("spawning `claude`"); // does not throw
});

test("the refusal names the call, the cost and the way out", () => {
  // The doors pass a PHRASE ("spawning `claude`"); a caller may pass a runner
  // name. Both have to read as English, and the code sample must not
  // interpolate either — `defineEval({ spawning `claude`: … })` is not a fix.
  assert.match(
    evalLoadRefusal("spawning `claude`"),
    /refused to spawn a model: spawning `claude` while an eval file/,
  );
  const m = evalLoadRefusal("measureTriggerRate");
  assert.match(m, /measureTriggerRate/); // what was called
  assert.match(m, /spends real money/); // why it is refused
  assert.match(m, /defineEval/); // the shape that fixes it
  assert.match(m, /assert\(report\)/); // where the result is read
});

// --- the product, not just the unit -----------------------------------------
//
// A gate wired into three of four spawn doors reads as complete and is not.
// That is not hypothetical here: `refuseUnderForeignRunner` shipped guarding
// ONE door of four, and the other three billed for it. This asserts the wiring
// by reading the sources, so a fifth door added without the call fails a test.
//
// 🔴 IT PARSES, IT DOES NOT GREP — and that distinction was found by mutation,
// not by review. The first version of this block asserted
// `src.includes('refuseDuringEvalLoad("grading with `claude`")')`. Commenting
// the call out left the substring in the file, so the mutation ran GREEN: the
// check could not tell a live call from a comment about one. A CallExpression
// in the syntax tree cannot be a comment.

const DOORS = [
  ["src/eval.ts", "spawning `claude`"],
  ["src/judge.ts", "grading with `claude`"],
  ["src/scan-behavioral.ts", "deriving an adversarial prompt with `claude`"],
  ["src/adapters/codex/eval.ts", "driving `codex exec`"],
] as const;

/** Every real call to `name`, with its first argument's text. Comments are not
 *  calls, so they are structurally invisible here. */
function callsTo(file: string, name: string): { arg: string; pos: number }[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const out: { arg: string; pos: number }[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText() === name)
      out.push({
        arg: n.arguments[0]?.getText() ?? "",
        pos: n.getStart(sf),
      });
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return out;
}

test.each(DOORS)(
  "%s calls refuseDuringEvalLoad at its spawn door",
  (file, what) => {
    const load = callsTo(file, "refuseDuringEvalLoad");
    const foreign = callsTo(file, "refuseUnderForeignRunner");
    assert.equal(load.length, 1, `${file}: expected exactly one load refusal`);
    assert.equal(
      foreign.length,
      1,
      `${file}: expected exactly one foreign refusal`,
    );
    assert.equal(load[0]?.arg, JSON.stringify(what));
    assert.equal(
      foreign[0]?.arg,
      load[0]?.arg,
      `${file}: the two describe different calls`,
    );
    // Adjacent, and therefore outside any `try` that swallows — the requirement
    // both refusals share (judge and deriveAttackReal both catch-and-default).
    const gap = (foreign[0]?.pos ?? 0) - (load[0]?.pos ?? 0);
    assert.ok(
      gap > 0 && gap < 200,
      `${file}: the two refusals drifted apart (${String(gap)} chars)`,
    );
  },
);

test("the wiring test FIRES on a commented-out call (the mutation that once passed)", () => {
  // Both halves, on the checker itself. Without this, a future refactor could
  // reintroduce the substring check and nothing would notice.
  const dir = mkdtempSync(join(tmpdir(), "vigiles-door-"));
  const live = join(dir, "live.ts");
  const dead = join(dir, "dead.ts");
  writeFileSync(live, `function d() { refuseDuringEvalLoad("x"); }\n`);
  writeFileSync(dead, `function d() { /* refuseDuringEvalLoad("x"); */ }\n`);
  assert.equal(callsTo(live, "refuseDuringEvalLoad").length, 1);
  assert.equal(callsTo(dead, "refuseDuringEvalLoad").length, 0);
});
