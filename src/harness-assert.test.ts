/**
 * Tests for the runner-agnostic harness helpers (src/harness-assert.ts): the
 * eval delta helpers and the jest/vitest matchers. The pure logic is exercised
 * here with fake result/report objects (no model, no claude).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vigilesMatchers } from "./harness-assert.js";
import { check, assertChecks } from "./check.js";
import {
  experimental_assertHookDenies as assertHookDenies,
  experimental_assertHookAllows as assertHookAllows,
  experimental_assertHookNotices as assertHookNotices,
  experimental_assertHookSilent as assertHookSilent,
} from "./hook-assertions.js";
import { experimental_assertAgentOk as assertAgentOk } from "./entries/spec.js";
import { assertNoRegression } from "./eval-readers.js";
import { toBaselineFile } from "./eval-baseline.js";
import { experimental_agent } from "./core/spec.js";
const { result } = experimental_agent;
import { experimental_defineHook, deny, allow } from "./core/hook-program.js";
import {
  experimental_defineInject,
  inject,
  experimental_defineReact,
  run,
  notice,
  nothing,
  tools,
} from "./core/hook-program.js";
import type { Check } from "./check.js";
import type { EvalReport } from "./eval.js";
import type { HarnessTestResult, HookFire } from "./harness-test.js";
import type { HookRunResult } from "./run-hook.js";

// The v50 throwing forms, as the checks that replaced them (src/effect-checks.ts):
// these tests keep pinning the same messages through `assertChecks`.
type RunOf<C extends (...a: never[]) => { eval: (t: never) => unknown }> =
  Parameters<ReturnType<C>["eval"]>[0];
const assertDelivered = (r: RunOf<typeof check.delivered>): void => {
  assertChecks(r, [check.delivered()]);
};
const assertEgressOnly = (
  r: RunOf<typeof check.egressOnly>,
  allowed: ReadonlyArray<string | RegExp>,
): void => {
  assertChecks(r, [check.egressOnly(allowed)]);
};
// `assertNoWrite` / `assertWroteOnly` are `check.writes({ none })` / `({ only })` (v52).
type RecordedWrites = { readonly filesWritten?: readonly string[] };
const assertNoWrite = (r: RecordedWrites, pattern: string | RegExp): void => {
  assertChecks(r, [check.writes({ none: [pattern] })]);
};
const assertWroteOnly = (
  r: RecordedWrites,
  allowed: ReadonlyArray<string | RegExp>,
): void => {
  assertChecks(r, [check.writes({ only: allowed })]);
};

/** Minimal HookRunResult stand-in for the run-hook-tier assertions/matcher. */
function fakeHook(blocked: boolean): HookRunResult {
  return {
    exitCode: blocked ? 2 : 0,
    stdout: "",
    stderr: "",
    json: null,
    blocked,
    haltsTurn: false,
    blockedBy: blocked ? ["exit-code"] : [],
    egress: [],
    filesWritten: [],
    decision: blocked ? "deny" : undefined,
    ran: true,
    conditionReason: "no condition declared",
    delivery: blocked ? { kind: "blocked", stranded: [] } : { kind: "silent" },
  };
}

const NO_USAGE = {
  totalCostUsd: 0,
  meanCostUsd: 0,
  meanDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
} as const;

/** An arm's usage and stub calls when neither is under test. */
const NO_MISSES = { usage: NO_USAGE, unansweredStubCalls: [] } as const;

const report: EvalReport = {
  name: "demo",
  trials: 6,
  totalCostUsd: 0,
  aborted: false,
  arms: {
    vanilla: {
      runs: 6,
      metrics: { caught: 0 },
      stats: {},
      ...NO_MISSES,
    },
    gated: {
      runs: 6,
      metrics: { caught: 0.5 },
      stats: {},
      ...NO_MISSES,
    },
  },
};

/** Minimal HarnessTestResult stand-in for file()-based assertions. */
function fakeResult(
  present: string[],
  toolCalls: HarnessTestResult["toolCalls"] = [],
  extra: {
    output?: string;
    hooks?: readonly HookFire[];
    modelRequests?: HarnessTestResult["modelRequests"];
  } = {},
): HarnessTestResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    cwd: "/tmp/x",
    turns: 2,
    toolCalls,
    hooks: extra.hooks ?? [],
    output: extra.output ?? "",
    modelRequests: extra.modelRequests ?? [],
    file: (p: string) => (present.includes(p) ? "content" : null),
    cleanup: () => undefined,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

test("assertDelivered: passes only on delivered, and names the cause of every other verdict", () => {
  const withDelivery = (delivery: HookRunResult["delivery"], ran = true) => ({
    ...fakeHook(false),
    ran,
    conditionReason: ran ? "no condition declared" : "the if did not match",
    delivery,
  });
  assert.doesNotThrow(() => {
    assertDelivered(
      withDelivery({
        kind: "delivered",
        via: ["additional-context"],
        stranded: [],
      }),
    );
  });
  assert.throws(() => {
    assertDelivered(
      withDelivery({
        kind: "undelivered",
        stranded: [{ stream: "stderr", bytes: 237, why: "dead stream" }],
      }),
    );
  }, /237 bytes on stderr: dead stream/);
  assert.throws(() => {
    assertDelivered(withDelivery({ kind: "silent" }));
  }, /printed nothing addressed to the model/);
  assert.throws(() => {
    assertDelivered(withDelivery({ kind: "silent" }, false));
  }, /never ran: the if did not match/);
  assert.throws(() => {
    assertDelivered(withDelivery({ kind: "blocked", stranded: [] }));
  }, /check\.hookFired\(event, \{ blocked: true \}\)/);
  assert.throws(() => {
    assertDelivered(
      withDelivery({ kind: "unknown", event: "X", why: "no row" }),
    );
  }, /cannot be judged: no row/);
});

test('assertEgressOnly (recordEgress results); [] is "no egress at all"', () => {
  const clean = { egress: [] };
  assert.doesNotThrow(() => {
    assertEgressOnly(clean, []);
  });

  const reached = {
    egress: [
      { host: "registry.npmjs.org", port: 443, ts: 1 },
      { host: "evil.example", port: 80, ts: 2 },
    ],
  };
  // an empty allowlist names every offender as host:port
  assert.throws(() => {
    assertEgressOnly(reached, []);
  }, /registry\.npmjs\.org:443, evil\.example:80/);
  // allowlist by host string leaves the non-allowlisted one as a failure
  assert.throws(() => {
    assertEgressOnly(reached, ["registry.npmjs.org"]);
  }, /evil\.example:80/);
  // host regex + exact host:port both satisfy the allowlist
  assert.doesNotThrow(() => {
    assertEgressOnly(reached, ["registry.npmjs.org", /evil\./]);
  });
  assert.doesNotThrow(() => {
    assertEgressOnly(reached, ["registry.npmjs.org:443", "evil.example:80"]);
  });
});

test("assertNoWrite / assertWroteOnly (confined run file writes)", () => {
  const r = { filesWritten: [".omc/state/x.json", "out.txt"] };
  // no-write: by substring and by regex
  assert.doesNotThrow(() => {
    assertNoWrite(r, ".env");
  });
  assert.throws(() => {
    assertNoWrite(r, "out.txt");
  }, /out\.txt/);
  assert.throws(() => {
    assertNoWrite(r, /\.json$/);
  }, /x\.json/);
  // wrote-only: every file must match an allowed pattern; offenders are named
  assert.throws(() => {
    assertWroteOnly(r, [/^\.omc\//]);
  }, /out\.txt/);
  assert.doesNotThrow(() => {
    assertWroteOnly(r, [/^\.omc\//, "out.txt"]);
  });
});

test("assertAgentOk / check.experimental_agentResult (subagent outcomes)", () => {
  const ok = '```vigiles:ok\n{ "summary": "done" }\n```';
  const err = '```vigiles:err\n{ "reason": "boom" }\n```';
  const c = result({ summary: "string" }, { reason: "string" });

  // assertAgentOk: returns the value on success; throws on err / malformed
  assert.deepEqual(assertAgentOk(ok), { summary: "done" });
  assert.deepEqual(assertAgentOk(ok, c), { summary: "done" });
  assert.throws(() => assertAgentOk(err), /returned an error result/);
  assert.throws(() => assertAgentOk("no block here"), /no vigiles/);

  // the error track, as a check (formerly experimental_assertAgentErr)
  const isErr = check.experimental_agentResult("err");
  assert.equal(isErr.eval({ output: err }).pass, true);
  assert.match(
    isErr.eval({ output: ok }).message,
    /expected an err result.*got ok/,
  );
  assert.match(isErr.eval({ output: "nope" }).message, /got malformed/);
  assert.equal(
    check.experimental_agentResult("ok", c).eval({ output: ok }).pass,
    true,
  );

  // a predicate, as a check (formerly experimental_assertAgentResult)
  assert.doesNotThrow(() => {
    assertChecks({ output: ok }, [
      check.experimental_agentResult(
        (r) => r.kind === "ok" && r.value.summary === "done",
      ),
    ]);
  });
  assert.throws(() => {
    assertChecks({ output: ok }, [
      check.experimental_agentResult((r) => r.kind === "err"),
    ]);
  }, /satisfies the predicate.*got ok/);
  // malformed path includes the reason in the message
  assert.throws(() => {
    assertChecks({ output: "plain" }, [
      check.experimental_agentResult((r) => r.kind === "ok"),
    ]);
  }, /malformed \(no vigiles/);
  // a predicate that throws fails the check with what it threw
  assert.match(
    check
      .experimental_agentResult(() => {
        throw new Error("bad predicate");
      })
      .eval({ output: ok }).message,
    /bad predicate/,
  );
  assert.deepEqual(check.experimental_agentResult("err", c).toJSON(), {
    kind: "agentResult",
    expect: "err",
    contract: true,
  });
});

test("vigilesMatchers.toHaveCreated reports pass/fail", () => {
  const r = fakeResult(["BLOCKED"]);
  assert.equal(vigilesMatchers.toHaveCreated(r, "BLOCKED").pass, true);
  assert.equal(vigilesMatchers.toHaveCreated(r, "nope").pass, false);
});

test("vigilesMatchers.toBlock + every matcher's message() render both states", () => {
  assert.equal(vigilesMatchers.toBlock(fakeHook(true)).pass, true);
  assert.equal(vigilesMatchers.toBlock(fakeHook(false)).pass, false);
  // invoke .message() in pass and fail states to cover the message closures
  assert.match(vigilesMatchers.toBlock(fakeHook(true)).message(), /to block/);
  assert.match(vigilesMatchers.toBlock(fakeHook(false)).message(), /to block/);
  assert.match(
    vigilesMatchers.toHaveCreated(fakeResult(["X"]), "X").message(),
    /to create/,
  );
  assert.match(
    vigilesMatchers.toHaveCreated(fakeResult([]), "X").message(),
    /to create/,
  );
  assert.match(
    vigilesMatchers
      .toBeatBaseline(report, "vanilla", "gated", "caught")
      .message(),
    /to beat/,
  );
  assert.match(
    vigilesMatchers
      .toBeatBaseline(report, "gated", "vanilla", "caught")
      .message(),
    /to beat/,
  );
});

test("vigilesMatchers.toPass / toPassAll evaluate a check, carrying its message", () => {
  const yes: Check<string> = {
    kind: "yes",
    eval: (s) => ({
      pass: s === "ok",
      score: s === "ok" ? 1 : 0,
      message: s === "ok" ? "matched" : "no match",
    }),
    toJSON: () => ({ kind: "yes" }),
  };
  const no: Check<string> = {
    kind: "no",
    eval: () => ({ pass: false, score: 0, message: "always fails" }),
    toJSON: () => ({ kind: "no" }),
  };
  // toPass carries the check's own message on both verdicts.
  assert.equal(vigilesMatchers.toPass("ok", yes).pass, true);
  const failed = vigilesMatchers.toPass("nope", yes);
  assert.equal(failed.pass, false);
  assert.equal(failed.message(), "no match");
  // toPassAll: all pass → pass + summary; any fail → fail listing the failures.
  const all = vigilesMatchers.toPassAll("ok", [yes]);
  assert.equal(all.pass, true);
  assert.match(all.message(), /all checks passed/);
  const some = vigilesMatchers.toPassAll("ok", [yes, no]);
  assert.equal(some.pass, false);
  assert.match(some.message(), /✗ always fails/);
});

test("vigilesMatchers.toBeatBaseline respects the `by` threshold", () => {
  assert.equal(
    vigilesMatchers.toBeatBaseline(report, "vanilla", "gated", "caught").pass,
    true,
  );
  assert.equal(
    vigilesMatchers.toBeatBaseline(report, "vanilla", "gated", "caught", 0.9)
      .pass,
    false,
  ); // an arm that never reported the metric is not an arm that scored 0
  assert.throws(
    () => vigilesMatchers.toBeatBaseline(report, "vanilla", "gated", "missing"),
    /no data to compare gated vs vanilla on missing/,
  );
});

test("assertNoRegression gates on a significant drop vs baseline", () => {
  const stat = (mean: number, se: number, n: number) => ({
    mean,
    std: se * Math.sqrt(n),
    se,
    n,
    passK: mean >= 1 ? 1 : 0,
  });
  const mk = (caught: number): EvalReport => ({
    name: "demo",
    trials: 20,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      gated: {
        runs: 20,
        metrics: { caught },
        stats: { caught: stat(caught, 0.03, 20) },
        ...NO_MISSES,
      },
    },
  });
  const baseline = toBaselineFile([mk(0.9)]);

  // a clear drop throws (single report)
  assert.throws(() => {
    assertNoRegression(mk(0.3), { baseline });
  }, /regression vs baseline/);
  // holding steady passes (array form)
  assert.doesNotThrow(() => {
    assertNoRegression([mk(0.9)], { baseline });
  });

  // a PATH: missing fails loudly, `update: true` records, later runs gate on it
  const dir = mkdtempSync(join(tmpdir(), "vigiles-baseline-"));
  try {
    const path = join(dir, "nested", "eval-baseline.json");
    assert.throws(() => {
      assertNoRegression(mk(0.9), { baseline: path });
    }, /no baseline at .*update: true/);
    assertNoRegression(mk(0.9), { baseline: path, update: true });
    assert.ok(existsSync(path), "update: true wrote the baseline");
    assert.doesNotThrow(() => {
      assertNoRegression(mk(0.9), { baseline: path });
    });
    assert.throws(() => {
      assertNoRegression(mk(0.3), { baseline: path });
    }, /regression vs baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertHookDenies / assertHookAllows test a compiled hook in-process (no subprocess)", () => {
  const guard = experimental_defineHook({
    on: "PreToolUse",
    decide: (e) =>
      e.command.runs("git push", { force: true })
        ? deny("no force-push")
        : allow(),
  });
  const ev = (command: string) => ({
    tool_name: "Bash",
    tool_input: { command },
  });

  // No throw on the matching decision …
  assert.doesNotThrow(() => {
    assertHookDenies(guard, ev("git push --force origin main"));
  });
  assert.doesNotThrow(() => {
    assertHookAllows(guard, ev("git status"));
  });
  // … and a loud throw on the wrong one (the message names what it got).
  assert.throws(() => {
    assertHookDenies(guard, ev("git status"));
  }, /expected the hook to deny, got allow \(a gate decision\)/);
  // assertHookAllows throws on a deny (the other fail path + message).
  assert.throws(() => {
    assertHookAllows(guard, ev("git push -f"));
  }, /expected the hook to allow, got deny \(a gate decision\)/);

  // A non-gate hook isn't a decision at all — the message names the role, so a
  // gate assert against an inject/react hook fails loudly (not silently passes).
  const briefing = experimental_defineInject({
    on: "SessionStart",
    produce: () => inject("hi"),
  });
  assert.throws(() => {
    assertHookDenies(briefing, { source: "startup" });
  }, /got an injection/);

  const formatOnWrite = experimental_defineReact({
    on: "PostToolUse",
    match: tools("Write"),
    react: () => run("prettier --write x"),
  });
  assert.throws(() => {
    assertHookDenies(formatOnWrite, {
      tool_name: "Write",
      tool_input: { file_path: "x.ts" },
    });
  }, /got run \(a reaction\)/);
});

// A react hook can't block, so the gate assertions don't apply to it — and until
// now nothing else did either. `notice()` writes to STDERR, which is a live trap:
// a probe built on `execFileSync` (stdout only) reported three perfectly healthy
// react hooks as DEAD on 2026-08-03. These read the reaction in-process, so
// stdout-vs-stderr never enters into it.
test("assertHookNotices / assertHookSilent test a react hook in-process", () => {
  const warnOnFailure = experimental_defineReact({
    on: "PostToolUse",
    match: tools("Bash"),
    react: (e) =>
      e.response.isError() ? notice("that command failed — check the log") : nothing(), // prettier-ignore
  });
  const ev = (isError: boolean) => ({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: isError ? { error: "boom" } : { stdout: "ok" },
  });

  assert.doesNotThrow(() => {
    assertHookNotices(warnOnFailure, ev(true));
  });
  assert.doesNotThrow(() => {
    assertHookSilent(warnOnFailure, ev(false));
  });

  // The message can be pinned by substring OR regexp.
  assert.doesNotThrow(() => {
    assertHookNotices(warnOnFailure, ev(true), "check the log");
  });
  assert.doesNotThrow(() => {
    assertHookNotices(warnOnFailure, ev(true), /failed/);
  });
  assert.throws(() => {
    assertHookNotices(warnOnFailure, ev(true), "totally different");
  }, /expected the notice to match totally different, got "that command failed/);
  assert.throws(() => {
    assertHookNotices(warnOnFailure, ev(true), /^nope$/);
  }, /expected the notice to match/);

  // Each assertion throws loudly on the other outcome (never a silent pass).
  assert.throws(() => {
    assertHookNotices(warnOnFailure, ev(false));
  }, /expected the hook to notice, got none \(a reaction\)/);
  assert.throws(() => {
    assertHookSilent(warnOnFailure, ev(true));
  }, /expected the hook to stay silent, got notice \(a reaction\)/);

  // A `run(…)` reaction is not silence — the hook still reacted.
  const formatOnWrite = experimental_defineReact({
    on: "PostToolUse",
    match: tools("Write"),
    react: () => run("prettier --write x"),
  });
  assert.throws(() => {
    assertHookSilent(formatOnWrite, {
      tool_name: "Write",
      tool_input: { file_path: "x.ts" },
    });
  }, /expected the hook to stay silent, got run \(a reaction\)/);

  // Aimed at the wrong ROLE, both name what they got instead of passing.
  const guard = experimental_defineHook({
    on: "PreToolUse",
    decide: () => allow(),
  });
  assert.throws(() => {
    assertHookNotices(guard, { tool_name: "Bash", tool_input: { command: "x" } }); // prettier-ignore
  }, /expected the hook to notice, got allow \(a gate decision\)/);
  assert.throws(() => {
    assertHookSilent(guard, {
      tool_name: "Bash",
      tool_input: { command: "x" },
    });
  }, /expected a react hook, got allow \(a gate decision\)/);
});

// --- "nobody looked" is not "nothing happened" -----------------------------
//
// `filesWritten` is recorded only on CONFINED runs. Before this, an unconfined
// run produced `[]`, so `assertNoWrite(r, /secret/)` returned GREEN having
// inspected nothing — a checker reporting success while doing no work, the
// exact class this repo keeps finding in other people's harnesses. The two
// states are now structurally distinct: `undefined` = never recorded,
// `[]` = recorded and genuinely empty.

test("assertNoWrite THROWS when writes were never recorded, instead of passing vacuously", () => {
  const unrecorded = {}; // an unconfined runHook result: no filesWritten
  assert.throws(
    () => {
      assertNoWrite(unrecorded, /\.env$/);
    },
    /never (recorded|captured)|not recorded/i,
    "an unrecorded run must not report a clean bill of health",
  );
});

test("assertWroteOnly THROWS when writes were never recorded", () => {
  assert.throws(() => {
    assertWroteOnly({}, [/^\.omc\//]);
  }, /never (recorded|captured)|not recorded/i);
});

test("the throw says HOW to record writes, so the fix isn't a doc hunt", () => {
  let msg = "";
  try {
    assertNoWrite({}, ".env");
  } catch (e) {
    msg = (e as Error).message;
  }
  // Naming the option is the whole point — confinement is what records writes.
  assert.match(msg, /sandbox/i);
});

test("a RECORDED-but-empty write list still passes — nothing happened is a real answer", () => {
  assert.doesNotThrow(() => {
    assertNoWrite({ filesWritten: [] }, /\.env$/);
  });
  assert.doesNotThrow(() => {
    assertWroteOnly({ filesWritten: [] }, [/^\.omc\//]);
  });
});
