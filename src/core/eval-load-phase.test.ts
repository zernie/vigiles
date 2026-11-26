/**
 * A model is spawned only inside a vigiles runner, never while an eval file loads.
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
import { AsyncLocalStorage } from "node:async_hooks";
import ts from "typescript";

import {
  evalLoadRefusal,
  inEvalLoad,
  inVigilesRunner,
  outsideRunnerRefusal,
  refuseOutsideRunner,
  withEvalLoad,
  withVigilesRunner,
} from "./eval-load-phase.js";

test("CLOSED by default: outside a runner the spawn refuses and names both doors", () => {
  // Guards: the vigiles#416 failure — a direct call that ran, got a broken
  // report and exited 0. Outside a runner nothing may spawn.
  assert.equal(inVigilesRunner(), false);
  assert.throws(() => {
    refuseOutsideRunner("spawning `claude`");
  }, /outside a vigiles runner/);
  const m = outsideRunnerRefusal("spawning `claude`");
  assert.match(m, /npx vigiles eval <file>/);
  assert.match(m, /paid_runEval\(definition\)/);
});

test("inside a runner the spawn is allowed", () => {
  // Guards: the quiet half — a closed gate that also refuses inside the runner
  // would refuse every correct eval.
  withVigilesRunner("eval-cli", () => {
    assert.equal(inVigilesRunner(), true);
    refuseOutsideRunner("spawning `claude`"); // does not throw
  });
});

test("while an eval file loads the spawn refuses, and the message teaches the new shape", () => {
  // Guards: import is not execution — a half-migrated file billing on import.
  const refuse = (): void => {
    refuseOutsideRunner("measureTriggerRate");
  };
  withVigilesRunner("eval-cli", () => {
    withEvalLoad(() => {
      assert.equal(inEvalLoad(), true);
      assert.throws(refuse, /while an eval file was being IMPORTED/);
    });
    assert.equal(inEvalLoad(), false);
    refuseOutsideRunner("spawning `claude`"); // the load phase ended with its callback
  });
});

test("a runner entered DURING a load phase stays in it — a nested door cannot reopen spawning", () => {
  // Guards: Codex P1 on #587 — an eval file whose module body calls
  // `paid_runEval(...)` entered a fresh runner with loading:false and billed
  // during the import the load phase exists to keep free.
  const refuse = (): void => {
    refuseOutsideRunner("spawning `claude`");
  };
  withVigilesRunner("eval-cli", () => {
    withEvalLoad(() => {
      withVigilesRunner("eval-programmatic", () => {
        assert.equal(inEvalLoad(), true);
        assert.throws(refuse, /while an eval file was being IMPORTED/);
      });
    });
  });
});

test("the load phase of an async import ends when its promise does, even when it rejects", async () => {
  // Guards: a throwing import must not leave the run stuck in the load phase.
  await withVigilesRunner("eval-cli", async () => {
    await assert.rejects(
      withEvalLoad(async () => {
        await Promise.resolve();
        assert.equal(inEvalLoad(), true);
        throw new Error("import failed");
      }),
      /import failed/,
    );
    assert.equal(inEvalLoad(), false);
    refuseOutsideRunner("spawning `claude`"); // does not throw
  });
});

test("two CONCURRENT runs never see each other's phase", async () => {
  // Guards: the refuted first design, a process-wide boolean — under
  // Promise.all the first run to finish its load closed or opened the door for
  // the other. Each async chain carries its own state.
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  const seen: string[] = [];
  await Promise.all([
    withVigilesRunner("eval-programmatic", async () => {
      await withEvalLoad(async () => {
        await tick();
        await tick();
        seen.push(`a-loading=${String(inEvalLoad())}`);
      });
    }),
    withVigilesRunner("eval-programmatic", async () => {
      await tick();
      seen.push(`b-loading=${String(inEvalLoad())}`);
      refuseOutsideRunner("spawning `claude`"); // b is past its load: allowed
    }),
  ]);
  assert.deepEqual(
    new Set(seen),
    new Set(["a-loading=true", "b-loading=false"]),
  );
  assert.equal(inVigilesRunner(), false, "nothing leaks out of either run");
});

test("the store is shared across installed copies of the module", () => {
  // Guards: two copies of vigiles in one process (a plugin's and the repo's) —
  // a runner entered by one must count for the other's doors.
  const key = Symbol.for("vigiles.runner");
  withVigilesRunner("eval-cli", () => {
    const shared: unknown = Reflect.get(globalThis, key);
    assert.ok(shared instanceof AsyncLocalStorage);
    assert.notEqual(shared.getStore(), undefined);
  });
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
// `src.includes('refuseOutsideRunner("grading with `claude`")')`. Commenting
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
  "%s calls refuseOutsideRunner at its spawn door, after the foreign-runner refusal",
  (file, what) => {
    const load = callsTo(file, "refuseOutsideRunner");
    const foreign = callsTo(file, "refuseUnderForeignRunner");
    assert.equal(
      load.length,
      1,
      `${file}: expected exactly one runner refusal`,
    );
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
    // The foreign-runner refusal comes FIRST: under vitest or jest its message
    // is the right one, and a test file is never inside a vigiles runner.
    const gap = (load[0]?.pos ?? 0) - (foreign[0]?.pos ?? 0);
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
  writeFileSync(live, `function d() { refuseOutsideRunner("x"); }\n`);
  writeFileSync(dead, `function d() { /* refuseOutsideRunner("x"); */ }\n`);
  assert.equal(callsTo(live, "refuseOutsideRunner").length, 1);
  assert.equal(callsTo(dead, "refuseOutsideRunner").length, 0);
});
