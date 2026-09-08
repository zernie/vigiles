/**
 * Tests for the runner-agnostic harness helpers (src/harness-assert.ts): the
 * eval delta helpers and the jest/vitest matchers. The pure logic is exercised
 * here with fake result/report objects (no model, no claude).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  improvement,
  assertImproves,
  significantlyBeats,
  assertSignificant,
  reliable,
  assertReliable,
  assertNoRegression,
  toBaselineFile,
  assertCreated,
  assertNotCreated,
  assertServedTurns,
  assertHookBlocked,
  assertHookAllowed,
  assertHookDenies,
  assertHookAllows,
  assertHookNotices,
  assertHookSilent,
  assertNoEgress,
  assertEgressOnly,
  egressHosts,
  assertNoWrite,
  assertWroteOnly,
  assertAgentOk,
  assertAgentErr,
  assertAgentResult,
  usedTool,
  toolCount,
  skillResolved,
  toolUsedWith,
  outputContains,
  requestContains,
  assertRequestContains,
  hookFired,
  hookBlocked,
  assertToolUsed,
  assertToolNotUsed,
  assertSkillResolved,
  assertToolUsedWith,
  assertOutputContains,
  assertHookFired,
  assertToolCount,
  assertToolSequence,
  assertToolCalls,
  vigilesMatchers,
} from "./harness-assert.js";
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

const report: EvalReport = {
  name: "demo",
  trials: 6,
  totalCostUsd: 0,
  aborted: false,
  arms: {
    vanilla: { runs: 6, metrics: { caught: 0 }, stats: {}, usage: NO_USAGE },
    gated: { runs: 6, metrics: { caught: 0.5 }, stats: {}, usage: NO_USAGE },
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
  };
}

test("improvement returns the arm − baseline gap", () => {
  assert.equal(improvement(report, "vanilla", "gated", "caught"), 0.5);
  assert.equal(improvement(report, "gated", "vanilla", "caught"), -0.5);
});

test("assertImproves passes on a positive gap and throws otherwise", () => {
  assert.doesNotThrow(() => {
    assertImproves(report, {
      baseline: "vanilla",
      arm: "gated",
      metric: "caught",
    });
  });
  assert.throws(() => {
    assertImproves(report, {
      baseline: "vanilla",
      arm: "gated",
      metric: "caught",
      by: 0.9,
    });
  });
});

test("significantlyBeats / assertSignificant use a computed noise floor", () => {
  const stat = (mean: number, se: number, n: number) => ({
    mean,
    se,
    n,
    std: se * Math.sqrt(n),
    passK: 0,
  });
  const sigReport: EvalReport = {
    name: "sig",
    trials: 20,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      base: {
        runs: 20,
        metrics: { caught: 0.1 },
        stats: { caught: stat(0.1, 0.05, 20) },
        usage: NO_USAGE,
      },
      // a real, tight separation → significant
      good: {
        runs: 20,
        metrics: { caught: 0.6 },
        stats: { caught: stat(0.6, 0.05, 20) },
        usage: NO_USAGE,
      },
      // a small gap drowned in wide se → not significant
      noisy: {
        runs: 5,
        metrics: { caught: 0.2 },
        stats: { caught: stat(0.2, 0.2, 5) },
        usage: NO_USAGE,
      },
    },
  };

  assert.equal(significantlyBeats(sigReport, "base", "good", "caught"), true);
  assert.equal(significantlyBeats(sigReport, "base", "noisy", "caught"), false);
  assert.equal(significantlyBeats(sigReport, "base", "good", "missing"), false);

  assert.doesNotThrow(() => {
    assertSignificant(sigReport, {
      baseline: "base",
      arm: "good",
      metric: "caught",
    });
  });
  // a real but not-significant gap throws
  assert.throws(() => {
    assertSignificant(sigReport, {
      baseline: "base",
      arm: "noisy",
      metric: "caught",
    });
  });
  // missing data throws with the no-data message
  assert.throws(() => {
    assertSignificant(sigReport, {
      baseline: "base",
      arm: "good",
      metric: "missing",
    });
  }, /no data to compare/);
  // assertImproves delegates to the significance test when asked
  assert.doesNotThrow(() => {
    assertImproves(sigReport, {
      baseline: "base",
      arm: "good",
      metric: "caught",
      significant: true,
    });
  });
  assert.throws(() => {
    assertImproves(sigReport, {
      baseline: "base",
      arm: "noisy",
      metric: "caught",
      significant: true,
    });
  });
});

test("reliable / assertReliable gate on pass^k (succeeded every trial)", () => {
  const rep: EvalReport = {
    name: "rel",
    trials: 4,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      flaky: {
        runs: 4,
        metrics: { safe: 0.75 },
        stats: { safe: { mean: 0.75, std: 0.5, se: 0.25, n: 4, passK: 0 } },
        usage: NO_USAGE,
      },
      solid: {
        runs: 4,
        metrics: { safe: 1 },
        stats: { safe: { mean: 1, std: 0, se: 0, n: 4, passK: 1 } },
        usage: NO_USAGE,
      },
    },
  };
  assert.equal(reliable(rep, "solid", "safe"), true);
  assert.equal(reliable(rep, "flaky", "safe"), false);
  assert.doesNotThrow(() => {
    assertReliable(rep, { arm: "solid", metric: "safe" });
  });
  assert.throws(() => {
    assertReliable(rep, { arm: "flaky", metric: "safe" });
  });
});

test("assertCreated / assertNotCreated check the sandbox", () => {
  const r = fakeResult(["RESULT"]);
  assert.doesNotThrow(() => {
    assertCreated(r, "RESULT");
  });
  assert.throws(() => {
    assertCreated(r, "MISSING");
  });
  assert.doesNotThrow(() => {
    assertNotCreated(r, "MISSING");
  });
  assert.throws(() => {
    assertNotCreated(r, "RESULT");
  });
});

test("assertServedTurns checks the mock turn count", () => {
  const r = fakeResult([]); // fakeResult sets turns: 2
  assert.doesNotThrow(() => {
    assertServedTurns(r, 2);
  });
  assert.throws(() => {
    assertServedTurns(r, 3);
  });
});

test("assertHookBlocked / assertHookAllowed (run-hook results)", () => {
  assert.doesNotThrow(() => {
    assertHookBlocked(fakeHook(true));
  });
  assert.throws(() => {
    assertHookBlocked(fakeHook(false));
  });
  assert.doesNotThrow(() => {
    assertHookAllowed(fakeHook(false));
  });
  assert.throws(() => {
    assertHookAllowed(fakeHook(true));
  });
});

test("assertNoEgress / assertEgressOnly / egressHosts (recordEgress results)", () => {
  const clean = { egress: [] };
  assert.doesNotThrow(() => {
    assertNoEgress(clean);
  });
  assert.deepEqual(egressHosts(clean), []);

  const reached = {
    egress: [
      { host: "registry.npmjs.org", port: 443, ts: 1 },
      { host: "evil.example", port: 80, ts: 2 },
    ],
  };
  assert.deepEqual(egressHosts(reached), [
    "registry.npmjs.org:443",
    "evil.example:80",
  ]);
  // no-egress assertion names the offenders
  assert.throws(() => {
    assertNoEgress(reached);
  }, /evil\.example/);
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

test("assertAgentOk / assertAgentErr / assertAgentResult (subagent outcomes)", () => {
  const ok = '```vigiles:ok\n{ "summary": "done" }\n```';
  const err = '```vigiles:err\n{ "reason": "boom" }\n```';
  const c = result({ summary: "string" }, { reason: "string" });

  // assertAgentOk: returns the value on success; throws on err / malformed
  assert.deepEqual(assertAgentOk(ok), { summary: "done" });
  assert.deepEqual(assertAgentOk(ok, c), { summary: "done" });
  assert.throws(() => assertAgentOk(err), /returned an error result/);
  assert.throws(() => assertAgentOk("no block here"), /no vigiles/);

  // assertAgentErr: returns the error on failure; throws on ok / malformed
  assert.deepEqual(assertAgentErr(err), { reason: "boom" });
  assert.throws(() => assertAgentErr(ok), /returned a success result/);
  assert.throws(() => assertAgentErr("nope"), /expected an error result/);

  // assertAgentResult: general predicate
  assert.doesNotThrow(() => {
    assertAgentResult(ok, (r) => r.kind === "ok" && r.value.summary === "done");
  });
  assert.throws(() => {
    assertAgentResult(ok, (r) => r.kind === "err");
  }, /did not satisfy the predicate: ok/);
  // malformed path includes the reason in the message
  assert.throws(() => {
    assertAgentResult("plain", (r) => r.kind === "ok");
  }, /malformed \(no vigiles/);
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
  );
});

// --- tool-call assertions (action invariants) ------------------------------

const skillCall = {
  name: "Skill",
  input: { skill: "demo:greet" },
  resultText: "Launching skill: demo:greet",
  isError: false,
};
const bashCall = {
  name: "Bash",
  input: { command: "ls" },
  resultText: "",
  isError: false,
};

test("assertToolUsed: matches by exact name and by regex", () => {
  const r = fakeResult([], [skillCall, bashCall]);
  assertToolUsed(r, "Skill"); // exact
  assertToolUsed(r, /^Bash$/); // regex
  assert.throws(() => {
    assertToolUsed(r, "Task");
  });
  assert.throws(() => {
    assertToolUsed(r, /^mcp__/);
  });
});

test("assertToolNotUsed: the safety negative", () => {
  const r = fakeResult([], [skillCall, bashCall]);
  assertToolNotUsed(r, /^mcp__github__merge/); // never invoked → ok
  assert.throws(() => {
    assertToolNotUsed(r, "Bash"); // was invoked → throws
  });
});

test("assertSkillResolved: needs a non-error Skill tool_use with that name", () => {
  assertSkillResolved(fakeResult([], [skillCall]), "demo:greet");
  assert.throws(() => {
    assertSkillResolved(fakeResult([], [skillCall]), "demo:other"); // wrong name
  });
  const errored = { ...skillCall, isError: true, resultText: "No such skill" };
  assert.throws(() => {
    assertSkillResolved(fakeResult([], [errored]), "demo:greet"); // errored
  });
});

// --- bare predicates (the shared vocabulary) -------------------------------

test("usedTool / toolCount: bare predicates return values, don't throw", () => {
  const r = fakeResult([], [skillCall, bashCall, bashCall]);
  assert.equal(usedTool(r, "Skill"), true);
  assert.equal(usedTool(r, /^Bash$/), true);
  assert.equal(usedTool(r, "Task"), false);
  assert.equal(toolCount(r, "Bash"), 2);
  assert.equal(toolCount(r, /^mcp__/), 0);
});

test("skillResolved: true only for a non-error Skill call by that name", () => {
  assert.equal(skillResolved(fakeResult([], [skillCall]), "demo:greet"), true);
  assert.equal(skillResolved(fakeResult([], [skillCall]), "demo:other"), false);
  const errored = { ...skillCall, isError: true, resultText: "No such skill" };
  assert.equal(skillResolved(fakeResult([], [errored]), "demo:greet"), false);
});

test("toolUsedWith: matches a tool by name AND its input", () => {
  const editCall = {
    name: "Edit",
    input: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
    resultText: "",
    isError: false,
  };
  const r = fakeResult([], [editCall]);
  const targets = (p: string) => (i: unknown) =>
    (i as { file_path?: string }).file_path === p;
  assert.equal(toolUsedWith(r, "Edit", targets("src/x.ts")), true);
  assert.equal(toolUsedWith(r, "Edit", targets("src/other.ts")), false);
  assert.equal(toolUsedWith(r, "Write", targets("src/x.ts")), false);
});

test("assertToolUsedWith: tool-argument assertion (asserts on input, not name)", () => {
  const editCall = {
    name: "Edit",
    input: { file_path: "note.txt" },
    resultText: "",
    isError: false,
  };
  const r = fakeResult([], [editCall]);
  const targets = (p: string) => (i: unknown) =>
    (i as { file_path?: string }).file_path === p;
  assertToolUsedWith(r, "Edit", targets("note.txt"));
  assert.throws(() => {
    assertToolUsedWith(r, "Edit", targets("WRONG.txt"));
  });
});

// --- output predicate (DeepEval-style "what did the agent say") ------------

test("outputContains / assertOutputContains check trace.output", () => {
  const r = fakeResult([], [], { output: "All done: created RESULT.md" });
  assert.equal(outputContains(r, "RESULT.md"), true);
  assert.equal(outputContains(r, /created \w+/), true);
  assert.equal(outputContains(r, "missing"), false);
  assertOutputContains(r, "All done");
  assert.throws(() => {
    assertOutputContains(r, "nope");
  });
});

// --- model-request predicate (did the injected context reach the model) ----

test("requestContains / assertRequestContains search system + messages", () => {
  const r = fakeResult([], [], {
    modelRequests: [
      {
        system: "You have superpowers. Use the using-superpowers skill.",
        messages: [{ role: "user", text: "go" }],
      },
      {
        system: "",
        messages: [
          { role: "user", text: "/review the repo" },
          { role: "assistant", text: "on it" },
        ],
      },
    ],
  });
  // hits in the system prompt (SessionStart additionalContext shape)
  assert.equal(requestContains(r, "You have superpowers"), true);
  assert.equal(requestContains(r, /super\w+/), true);
  // hits in a message (slash-command expansion shape)
  assert.equal(requestContains(r, "/review the repo"), true);
  assert.equal(requestContains(r, "never sent"), false);
  assertRequestContains(r, "superpowers");
  assert.throws(() => {
    assertRequestContains(r, "never sent");
  });
});

test("assertRequestContains hints when no requests were captured (eval tier)", () => {
  const r = fakeResult([], [], { modelRequests: [] });
  assert.equal(requestContains(r, "anything"), false);
  assert.throws(() => {
    assertRequestContains(r, "anything");
  }, /harness-tier only/);
});

// --- hook predicates (recorded from the stream, not marker files) ----------

const hookFires: readonly HookFire[] = [
  {
    name: "PreToolUse:Edit",
    event: "PreToolUse",
    exitCode: 2,
    blocked: true,
    output: "BLOCKED",
  },
  {
    name: "PostToolUse:Bash",
    event: "PostToolUse",
    exitCode: 0,
    blocked: false,
    output: "ok",
  },
];

test("hookFired / hookBlocked: match by label and by bare event", () => {
  const r = fakeResult([], [], { hooks: hookFires });
  assert.equal(hookFired(r, "PreToolUse:Edit"), true); // full label
  assert.equal(hookFired(r, "PostToolUse"), true); // bare event
  assert.equal(hookFired(r, /^PreToolUse/), true); // regex
  assert.equal(hookFired(r, "SessionStart"), false);
  assert.equal(hookBlocked(r, "PreToolUse"), true); // the Edit hook blocked
  assert.equal(hookBlocked(r, "PostToolUse"), false); // the Bash hook didn't
});

test("assertHookFired: fires, and { blocked: true } demands a block", () => {
  const r = fakeResult([], [], { hooks: hookFires });
  assertHookFired(r, "PreToolUse:Edit");
  assertHookFired(r, "PreToolUse", { blocked: true });
  assert.throws(() => {
    assertHookFired(r, "SessionStart"); // never fired
  });
  assert.throws(() => {
    assertHookFired(r, "PostToolUse", { blocked: true }); // fired but didn't block
  });
});

// --- sequence / budget invariants (idea 1) ---------------------------------

const call = (name: string) => ({
  name,
  input: {},
  resultText: "",
  isError: false,
});

test("assertToolCount: min / max / exactly bounds", () => {
  const r = fakeResult([], [call("Read"), call("Write"), call("Write")]);
  assertToolCount(r, "Write", { max: 2 });
  assertToolCount(r, "Read", { exactly: 1 });
  assertToolCount(r, /^mcp__/, { exactly: 0 });
  assert.throws(() => {
    assertToolCount(r, "Write", { max: 1 }); // 2 > 1
  });
  assert.throws(() => {
    assertToolCount(r, "Read", { min: 2 }); // only 1
  });
});

test("assertToolSequence: in-order subsequence (gaps allowed)", () => {
  const r = fakeResult([], [call("Read"), call("Bash"), call("Edit")]);
  assertToolSequence(r, ["Read", "Edit"]); // Read before Edit (Bash between is fine)
  assertToolSequence(r, [/^Read$/, /^Edit$/]); // regex form
  assert.throws(() => {
    assertToolSequence(r, ["Edit", "Read"]); // wrong order
  });
  assert.throws(() => {
    assertToolSequence(r, ["Read", "Read"]); // only one Read
  });
});

test("assertToolCalls: custom invariant — every Edit preceded by a Read", () => {
  const everyEditAfterRead = (calls: readonly { name: string }[]) => {
    let read = false;
    for (const c of calls) {
      if (c.name === "Read") read = true;
      if (c.name === "Edit" && !read) return false;
    }
    return true;
  };
  assertToolCalls(
    fakeResult([], [call("Read"), call("Edit")]),
    everyEditAfterRead,
  );
  assert.throws(() => {
    assertToolCalls(fakeResult([], [call("Edit")]), everyEditAfterRead);
  });
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
        usage: NO_USAGE,
      },
    },
  });
  const baseline = toBaselineFile([mk(0.9)]);

  // a clear drop throws (single report)
  assert.throws(() => {
    assertNoRegression(mk(0.3), baseline);
  }, /regression vs baseline/);
  // holding steady passes (array form)
  assert.doesNotThrow(() => {
    assertNoRegression([mk(0.9)], baseline);
  });
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
