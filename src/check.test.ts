/**
 * `vigiles/check` vocabulary test suite (Phase 0).
 *
 * Pure, model-free: build a fake `Trace` / `HookRunResult` and assert each
 * check's pass/fail, its 0–1 score, that the FAILURE MESSAGE is actionable (not
 * a bare "false"), and that it round-trips through `toJSON`. The messages are the
 * product, so they're tested as much as the verdict.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  tool,
  toolWith,
  notTool,
  didNotWrite,
  skill,
  output,
  hookFired,
  received,
  turns,
  wrote,
  blocked,
  allowed,
  mcp,
  subagent,
  judged,
  cost,
  latency,
  tokens,
  inputTokens,
  outputTokens,
  cacheTokens,
  evalChecks,
  assertChecks,
  type Check,
} from "./check.js";
import type { Trace, ToolCall, HookFire } from "./harness-test.js";
import type { HookRunResult } from "./run-hook.js";

function makeTrace(over: Partial<Trace> = {}): Trace {
  return {
    toolCalls: [],
    hooks: [],
    output: "",
    modelRequests: [],
    turns: 0,
    file: () => null,
    ...over,
  };
}

function toolCall(name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { name, input: {}, resultText: "", isError: false, ...over };
}

function hook(event: string): HookFire {
  return {
    name: `${event}:*`,
    event,
    exitCode: 0,
    blocked: false,
    output: "",
  };
}

function hookResult(over: Partial<HookRunResult> = {}): HookRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    json: null,
    blocked: false,
    haltsTurn: false,
    blockedBy: [],
    egress: [],
    filesWritten: [],
    decision: undefined,
    ran: true,
    conditionReason: "no condition declared",
    delivery: { kind: "silent" },
    ...over,
  };
}

test("tool(): pass when used, actionable message + score when not", () => {
  const used = makeTrace({ toolCalls: [toolCall("Bash")] });
  const r1 = tool("Bash").eval(used);
  assert.equal(r1.pass, true);
  assert.equal(r1.score, 1);

  const other = makeTrace({ toolCalls: [toolCall("Read"), toolCall("Edit")] });
  const r2 = tool("Bash").eval(other);
  assert.equal(r2.pass, false);
  assert.equal(r2.score, 0);
  assert.match(r2.message, /expected the agent to use tool "Bash"/);
  assert.match(r2.message, /\[Read, Edit\]/); // names the tools it DID use
  assert.deepEqual(tool("Bash").toJSON(), { kind: "tool", name: "Bash" });
});

test("toolWith(): asserts on a tool call's arguments (exact + regex + dot-path)", () => {
  const t = makeTrace({
    toolCalls: [
      toolCall("Bash", { input: { command: "git push origin feature" } }),
      toolCall("Write", {
        input: { body: { prompt: "a cat, watercolor STYLE" } },
      }),
    ],
  });
  // regex "contains" over a nested dot-path
  assert.equal(
    toolWith("Write", { "body.prompt": /STYLE$/ }).eval(t).pass,
    true,
  );
  // exact match on a string field
  assert.equal(
    toolWith("Bash", { command: "git push origin feature" }).eval(t).pass,
    true,
  );
  // tool used, but never with these args → actionable message naming what it saw
  const wrongArgs = toolWith("Bash", { command: /main/ }).eval(t);
  assert.equal(wrongArgs.pass, false);
  assert.match(wrongArgs.message, /never with command=\/main\//);
  assert.match(wrongArgs.message, /git push origin feature/);
  // tool not used at all → distinct from wrong-args
  const notUsed = toolWith("Read", { path: "x" }).eval(t);
  assert.equal(notUsed.pass, false);
  assert.match(notUsed.message, /expected the agent to use tool "Read"/);
  // serializable (RegExp → string form)
  assert.deepEqual(toolWith("Bash", { command: /main/i }).toJSON(), {
    kind: "toolWith",
    name: "Bash",
    args: { command: "/main/i" },
  });
});

test("notTool(): the safety/negative assertion, with and without arg-scoping", () => {
  const pushedMain = makeTrace({
    toolCalls: [
      toolCall("Bash", { input: { command: "git push origin main" } }),
    ],
  });
  const pushedFeature = makeTrace({
    toolCalls: [
      toolCall("Bash", { input: { command: "git push origin feature" } }),
    ],
  });

  // unscoped: forbids the tool outright
  assert.equal(notTool("WebFetch").eval(pushedMain).pass, true); // never used → ok
  const usedAtAll = notTool("Bash").eval(pushedMain);
  assert.equal(usedAtAll.pass, false);
  assert.match(usedAtAll.message, /expected the agent NOT to use "Bash"/);

  // arg-scoped: "did not push to main" allows pushing elsewhere
  const forbidMain = notTool("Bash", { command: /push origin main\b/ });
  assert.equal(forbidMain.eval(pushedFeature).pass, true); // feature push is fine
  const tripped = forbidMain.eval(pushedMain);
  assert.equal(tripped.pass, false);
  assert.match(tripped.message, /NOT to use "Bash" with command=/);
  assert.match(tripped.message, /git push origin main/);

  assert.deepEqual(notTool("Bash").toJSON(), { kind: "notTool", name: "Bash" });
  assert.deepEqual(notTool("Bash", { command: /main/ }).toJSON(), {
    kind: "notTool",
    name: "Bash",
    args: { command: "/main/" },
  });
});

test("skill(): resolves on a non-error Skill call with the right id", () => {
  const fired = makeTrace({
    toolCalls: [toolCall("Skill", { input: { skill: "vig:test-harness" } })],
  });
  assert.equal(skill("vig:test-harness").eval(fired).pass, true);

  // wrong skill id → fail, message lists what was invoked
  const wrong = makeTrace({
    toolCalls: [toolCall("Skill", { input: { skill: "vig:other" } })],
  });
  const r = skill("vig:test-harness").eval(wrong);
  assert.equal(r.pass, false);
  assert.match(r.message, /\[vig:other\]/);

  // errored Skill call doesn't count
  const errored = makeTrace({
    toolCalls: [
      toolCall("Skill", { input: { skill: "vig:x" }, isError: true }),
    ],
  });
  assert.equal(skill("vig:x").eval(errored).pass, false);
  assert.deepEqual(skill("vig:x").toJSON(), { kind: "skill", id: "vig:x" });
});

test("output(): substring and regex, with a truncated got-message", () => {
  const t = makeTrace({ output: "the answer is 42, done." });
  assert.equal(output("42").eval(t).pass, true);
  assert.equal(output(/answer is \d+/).eval(t).pass, true);

  const miss = output("nope").eval(t);
  assert.equal(miss.pass, false);
  assert.match(miss.message, /expected output to contain nope/);
  assert.match(miss.message, /the answer is 42/); // shows actual

  assert.deepEqual(output("x").toJSON(), {
    kind: "output",
    matcher: "x",
    regex: false,
  });
  assert.equal(output(/x/i).toJSON().regex, true);
});

test("hookFired(): matches by event, lists fired events on miss", () => {
  const t = makeTrace({ hooks: [hook("PreToolUse"), hook("Stop")] });
  assert.equal(hookFired("Stop").eval(t).pass, true);
  const miss = hookFired("PostToolUse").eval(t);
  assert.equal(miss.pass, false);
  assert.match(miss.message, /\[PreToolUse, Stop\]/);
});

test("received(): a slash-command expansion / injected context reached the model", () => {
  // modelRequests is what the mock captured reaching the model — a /review
  // command expands its commands/review.md body into the user message.
  const t = makeTrace({
    modelRequests: [
      {
        system: "You are Claude.",
        messages: [
          {
            role: "user",
            text: "Run the full review checklist: lint, tests, types.",
          },
        ],
      },
    ],
  });
  assert.equal(received("review checklist").eval(t).pass, true);
  assert.equal(received(/lint, tests, types/).eval(t).pass, true);
  const miss = received("deploy to prod").eval(t);
  assert.equal(miss.pass, false);
  assert.match(miss.message, /slash-command expansion or injected context/);
  // eval tier captures no requests → an explicit, actionable message
  const noReqs = received("x").eval(makeTrace());
  assert.match(noReqs.message, /no requests captured/);
  assert.deepEqual(received("x").toJSON(), {
    kind: "received",
    matcher: "x",
    regex: false,
  });
});

test("turns(): multi-turn observable (min/max)", () => {
  assert.equal(turns({ min: 2 }).eval(makeTrace({ turns: 3 })).pass, true);
  assert.equal(turns({ min: 2 }).eval(makeTrace({ turns: 1 })).pass, false);
  assert.match(
    turns({ min: 2 }).eval(makeTrace({ turns: 1 })).message,
    /expected ≥ 2 turn\(s\), got 1/,
  );
  assert.equal(turns({ max: 5 }).eval(makeTrace({ turns: 6 })).pass, false);
  assert.equal(
    turns({ min: 2, max: 5 }).eval(makeTrace({ turns: 3 })).pass,
    true,
  );
  assert.deepEqual(turns({ min: 2 }).toJSON(), {
    kind: "turns",
    min: 2,
    max: undefined,
  });
});

test("wrote(): checks the work-dir file presence", () => {
  const t = makeTrace({ file: (p) => (p === "DONE" ? "x" : null) });
  assert.equal(wrote("DONE").eval(t).pass, true);
  const miss = wrote("NOPE").eval(t);
  assert.equal(miss.pass, false);
  assert.match(miss.message, /expected the agent to create "NOPE"/);
});

test("didNotWrite(): the side-effect-boundary negative over the work dir", () => {
  const t = makeTrace({ file: (p) => (p === "out.txt" ? "x" : null) });
  // absent file → ok (stayed inside the declared write surface)
  assert.equal(didNotWrite("secrets.env").eval(t).pass, true);
  assert.match(
    didNotWrite("secrets.env").eval(t).message,
    /"secrets.env" was not created/,
  );
  // present file → fail (escaped the boundary)
  const escaped = didNotWrite("out.txt").eval(t);
  assert.equal(escaped.pass, false);
  assert.match(escaped.message, /expected the agent NOT to create "out.txt"/);
  assert.deepEqual(didNotWrite("x").toJSON(), {
    kind: "didNotWrite",
    path: "x",
  });
});

test("blocked()/allowed(): hook-decision checks over HookRunResult", () => {
  const b = hookResult({ blocked: true, exitCode: 2 });
  const a = hookResult({ blocked: false, exitCode: 0 });
  assert.equal(blocked().eval(b).pass, true);
  assert.equal(blocked().eval(a).pass, false);
  assert.match(blocked().eval(a).message, /expected the hook to block/);
  assert.equal(allowed().eval(a).pass, true);
  assert.equal(allowed().eval(b).pass, false);
  assert.deepEqual(blocked().toJSON(), { kind: "blocked" });
});

test("mcp(): matches an mcp__server__tool call", () => {
  const t = makeTrace({ toolCalls: [toolCall("mcp__github__create_issue")] });
  assert.equal(mcp("github", "create_issue").eval(t).pass, true);
  const miss = mcp("github", "list_issues").eval(t);
  assert.equal(miss.pass, false);
  assert.match(miss.message, /mcp__github__list_issues/);
  assert.deepEqual(mcp("github", "x").toJSON(), {
    kind: "mcp",
    server: "github",
    tool: "x",
  });
});

test("subagent(): runs nested checks over a subagent's sub-trace", () => {
  const t = makeTrace({
    toolCalls: [toolCall("Task")],
    subagents: [
      {
        name: "reviewer",
        toolCalls: [toolCall("Read"), toolCall("Bash")],
        output: "",
      },
    ],
  });
  // the reviewer subagent used Read + Bash → nested checks pass
  assert.equal(
    subagent("reviewer", [tool("Read"), tool("Bash")]).eval(t).pass,
    true,
  );
  // a nested check that fails surfaces in the message
  const failNested = subagent("reviewer", [tool("Edit")]).eval(t);
  assert.equal(failNested.pass, false);
  assert.match(failNested.message, /subagent "reviewer".*use tool "Edit"/s);
  // a subagent that never ran
  const missing = subagent("planner", [tool("Read")]).eval(t);
  assert.equal(missing.pass, false);
  assert.match(missing.message, /\[reviewer\]/);
  assert.equal(subagent("x", [tool("Read")]).toJSON().kind, "subagent");
});

test("subagent(): matches a --plugin-dir namespaced subagent_type by bare name", () => {
  // Real --plugin-dir dispatch records subagent_type as "plugin:agent"; the caller
  // passes the bare agent name. (Captured: "reviewer-spec:code-reviewer".)
  const t = makeTrace({
    subagents: [
      {
        name: "reviewer-spec:code-reviewer",
        toolCalls: [toolCall("Read")],
        // the sub's RETURN carries its result() block (where vigiles:ok lands)
        output: "```vigiles:ok\n{ defects: [], summary: 'ok' }\n```",
      },
    ],
  });
  // bare name matches the namespaced subagent_type, and a nested output() check
  // reads the sub's RETURN — the payoff a result() contract makes measurable.
  assert.equal(
    subagent("code-reviewer", [tool("Read"), output(/vigiles:ok/)]).eval(t)
      .pass,
    true,
  );
  // the full namespaced name still matches too
  assert.equal(
    subagent("reviewer-spec:code-reviewer", [tool("Read")]).eval(t).pass,
    true,
  );
});

test("judged(): model-graded check with an injectable judge (no real model)", () => {
  const t = makeTrace({ output: "a thorough, well-ordered plan" });
  const fakeHigh = () => ({ score: 0.9, pass: true, reason: "ordered steps" });
  const fakeLow = () => ({ score: 0.2, pass: false, reason: "vague" });

  const passC = judged("1 if the plan is concrete", {
    min: 0.7,
    judge: fakeHigh,
  });
  const r1 = passC.eval(t);
  assert.equal(r1.pass, true);
  assert.equal(r1.score, 0.9);

  const failC = judged("1 if concrete", { min: 0.7, judge: fakeLow });
  const r2 = failC.eval(t);
  assert.equal(r2.pass, false);
  assert.match(r2.message, /judge 0.20 < 0.7/);
  assert.match(r2.message, /vague/);
  assert.deepEqual(judged("rubric x", { min: 0.6 }).toJSON(), {
    kind: "judged",
    rubric: "rubric x",
    min: 0.6,
  });
});

test("cost / latency / tokens checks over a run's usage", () => {
  const run = {
    usage: {
      costUsd: 0.02,
      durationMs: 1500,
      inputTokens: 800,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
  assert.equal(cost({ maxUsd: 0.05 }).eval(run).pass, true);
  assert.equal(cost({ maxUsd: 0.01 }).eval(run).pass, false);
  assert.match(
    cost({ maxUsd: 0.01 }).eval(run).message,
    /expected cost ≤ \$0.01/,
  );
  assert.equal(latency({ maxMs: 2000 }).eval(run).pass, true);
  assert.equal(latency({ maxMs: 1000 }).eval(run).pass, false);
  assert.equal(tokens({ max: 1000 }).eval(run).pass, true); // 800+200 = 1000
  assert.equal(tokens({ max: 999 }).eval(run).pass, false);
  assert.deepEqual(cost({ maxUsd: 0.1 }).toJSON(), {
    kind: "cost",
    maxUsd: 0.1,
  });
});

test("inputTokens check: pass/fail, score, message, toJSON", () => {
  const run = {
    usage: {
      costUsd: 0.01,
      durationMs: 500,
      inputTokens: 800,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
  // passing case
  assert.equal(inputTokens({ max: 800 }).eval(run).pass, true);
  assert.equal(inputTokens({ max: 800 }).eval(run).score, 1);
  assert.match(
    inputTokens({ max: 800 }).eval(run).message,
    /800 input tokens ≤ 800/,
  );
  // failing case
  assert.equal(inputTokens({ max: 799 }).eval(run).pass, false);
  assert.equal(inputTokens({ max: 799 }).eval(run).score, 0);
  assert.match(
    inputTokens({ max: 799 }).eval(run).message,
    /expected ≤ 799 input tokens, got 800/,
  );
  // toJSON round-trip
  assert.deepEqual(inputTokens({ max: 500 }).toJSON(), {
    kind: "inputTokens",
    max: 500,
  });
});

test("outputTokens check: pass/fail, score, message, toJSON", () => {
  const run = {
    usage: {
      costUsd: 0.01,
      durationMs: 500,
      inputTokens: 800,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
  // passing case
  assert.equal(outputTokens({ max: 200 }).eval(run).pass, true);
  assert.equal(outputTokens({ max: 200 }).eval(run).score, 1);
  assert.match(
    outputTokens({ max: 200 }).eval(run).message,
    /200 output tokens ≤ 200/,
  );
  // failing case
  assert.equal(outputTokens({ max: 199 }).eval(run).pass, false);
  assert.equal(outputTokens({ max: 199 }).eval(run).score, 0);
  assert.match(
    outputTokens({ max: 199 }).eval(run).message,
    /expected ≤ 199 output tokens, got 200/,
  );
  // toJSON round-trip
  assert.deepEqual(outputTokens({ max: 150 }).toJSON(), {
    kind: "outputTokens",
    max: 150,
  });
});

test("cacheTokens check: maxCreation-only, maxRead-only, both, pass-within-bounds, toJSON", () => {
  const run = {
    usage: {
      costUsd: 0.02,
      durationMs: 600,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 400,
      cacheReadTokens: 300,
    },
  };
  // maxCreation-only: pass
  assert.equal(cacheTokens({ maxCreation: 400 }).eval(run).pass, true);
  assert.equal(cacheTokens({ maxCreation: 400 }).eval(run).score, 1);
  // maxCreation-only: fail
  assert.equal(cacheTokens({ maxCreation: 399 }).eval(run).pass, false);
  assert.equal(cacheTokens({ maxCreation: 399 }).eval(run).score, 0);
  assert.match(
    cacheTokens({ maxCreation: 399 }).eval(run).message,
    /expected ≤ 399 cache-creation tokens, got 400/,
  );
  // maxRead-only: pass
  assert.equal(cacheTokens({ maxRead: 300 }).eval(run).pass, true);
  // maxRead-only: fail
  assert.equal(cacheTokens({ maxRead: 299 }).eval(run).pass, false);
  assert.match(
    cacheTokens({ maxRead: 299 }).eval(run).message,
    /expected ≤ 299 cache-read tokens, got 300/,
  );
  // both constraints: pass when both within bounds
  assert.equal(
    cacheTokens({ maxCreation: 400, maxRead: 300 }).eval(run).pass,
    true,
  );
  assert.match(
    cacheTokens({ maxCreation: 400, maxRead: 300 }).eval(run).message,
    /cache tokens within bounds/,
  );
  // both constraints: creation fails first
  assert.equal(
    cacheTokens({ maxCreation: 399, maxRead: 300 }).eval(run).pass,
    false,
  );
  assert.match(
    cacheTokens({ maxCreation: 399, maxRead: 300 }).eval(run).message,
    /cache-creation/,
  );
  // toJSON round-trips both optional fields
  assert.deepEqual(cacheTokens({ maxCreation: 500, maxRead: 200 }).toJSON(), {
    kind: "cacheTokens",
    maxCreation: 500,
    maxRead: 200,
  });
  // toJSON with only one field set
  assert.deepEqual(cacheTokens({ maxCreation: 500 }).toJSON(), {
    kind: "cacheTokens",
    maxCreation: 500,
  });
  assert.deepEqual(cacheTokens({ maxRead: 200 }).toJSON(), {
    kind: "cacheTokens",
    maxRead: 200,
  });
});

test("checks are harness-agnostic: they read Trace fields, not a CC shape", () => {
  // A Codex run produces a Trace with `output` but a deliberately sparse
  // tool/hook trace (codexDriver doesn't parse JSONL tool events). The checks
  // must still evaluate correctly — `output` passes, tool/hook checks fail
  // gracefully (not throw) — because the vocabulary is over the generic Trace.
  const codexLike = makeTrace({
    output: "AGENTS.md updated as requested",
    toolCalls: [], // not captured by this harness
    hooks: [],
  });
  assert.equal(output("AGENTS.md updated").eval(codexLike).pass, true);
  assert.equal(tool("Bash").eval(codexLike).pass, false); // graceful, not a throw
  assert.equal(hookFired("Stop").eval(codexLike).pass, false);
  // assertChecks works over any harness's result — same entry, no CC assumption.
  assertChecks(codexLike, [output(/AGENTS\.md/)]);
});

test("evalChecks(): evaluates every check, preserving order", () => {
  const t = makeTrace({ toolCalls: [toolCall("Bash")], output: "done" });
  const checks: Check<Trace>[] = [tool("Bash"), output("done"), tool("Read")];
  const results = evalChecks(t, checks);
  assert.deepEqual(
    results.map((r) => r.pass),
    [true, true, false],
  );
});

test("assertChecks(): passes silently, throws collecting ALL failures", () => {
  const t = makeTrace({ toolCalls: [toolCall("Bash")], output: "done" });
  // all pass → no throw
  assertChecks(t, [tool("Bash"), output("done")]);

  // two fail → one throw listing both messages
  assert.throws(
    () => {
      assertChecks(t, [tool("Bash"), tool("Read"), output("nope")]);
    },
    (err: Error) => {
      assert.match(err.message, /2 of 3 check\(s\) failed/);
      assert.match(err.message, /use tool "Read"/);
      assert.match(err.message, /output to contain nope/);
      return true;
    },
  );
});
