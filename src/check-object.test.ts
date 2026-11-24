/**
 * `check` — the vocabulary as ONE callable object. Call it for a named custom
 * check; reach every built-in as a member, including the forms the old
 * assertions had and the plain functions lack: a RegExp tool name, a count
 * bound, an order, a hook that must have blocked, and `runs()` over the shell
 * command the adapter recorded.
 *
 * `runs()` is exercised on each harness's real trace shape in
 * `adapters/<harness>/trace-facts.test.ts`; here it runs over `ToolCall.shell`
 * directly, which is all it reads.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  check,
  assertChecks,
  tool,
  toolWith,
  skill,
  output,
  wrote,
  blocked,
} from "./check.js";
import { checksRecorded } from "./check-count.js";
import type { Trace, ToolCall, HookFire } from "./harness-test.js";

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

const call = (name: string, over: Partial<ToolCall> = {}): ToolCall => ({
  name,
  input: {},
  resultText: "",
  isError: false,
  ...over,
});

const shell = (command: string): ToolCall => call("Shell", { shell: command });

const hook = (name: string, blocked = false): HookFire => ({
  name,
  event: name.split(":")[0] ?? name,
  exitCode: blocked ? 2 : 0,
  blocked,
  output: "",
});

describe("check(name, fn) — a named custom check", () => {
  test("passes and fails by the predicate, and the failure names it", () => {
    const t = makeTrace({ toolCalls: [call("Edit")] });
    const rule = check<Trace>(
      "every Edit follows a Read",
      (r) => r.toolCalls[0]?.name === "Read",
    );
    const r = rule.eval(t);
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
    assert.match(r.message, /check "every Edit follows a Read" failed/);
    // over a run, the tools it used — what the old assertToolCalls printed
    assert.match(r.message, /tools used: \[Edit\]/);
    assert.equal(
      check<Trace>("any", () => true).eval(t).message,
      'check "any" held',
    );
  });

  test("serializes as { kind: 'check', name }", () => {
    assert.deepEqual(check("x", () => true).toJSON(), {
      kind: "check",
      name: "x",
    });
  });

  test("a predicate that throws fails the check with what it threw", () => {
    const r = check<number>("boom", () => {
      throw new Error("bad input");
    }).eval(1);
    assert.equal(r.pass, false);
    assert.match(r.message, /check "boom" threw: bad input/);
    const nonError = check<number>("odd", () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
      throw "a string";
    }).eval(1);
    assert.match(nonError.message, /threw: a string/);
  });

  test("any target, not only a run — and no tool list where there are none", () => {
    const r = check<number>("positive", (n) => n > 0).eval(-1);
    assert.equal(r.message, 'check "positive" failed');
  });

  test("an empty name is refused — it is what a failure prints", () => {
    const nameless = (): unknown => check(" ", () => true);
    assert.throws(nameless, /give the check a name/);
  });

  test("each evaluation counts as a check the script made", () => {
    const before = checksRecorded();
    check<number>("n", () => true).eval(1);
    assert.equal(checksRecorded(), before + 1);
  });
});

describe("the members are the vocabulary", () => {
  test("the shared members are the plain functions' checks", () => {
    const t = makeTrace({
      toolCalls: [call("Bash"), call("Skill", { input: { skill: "p:s" } })],
      output: "done",
    });
    for (const [a, b] of [
      [check.tool("Bash"), tool("Bash")],
      [check.toolWith("Bash", {}), toolWith("Bash", {})],
      [check.skill("p:s"), skill("p:s")],
      [check.output("done"), output("done")],
      [check.wrote("x"), wrote("x")],
    ] as const) {
      assert.deepEqual(a.toJSON(), b.toJSON());
      assert.deepEqual(a.eval(t), b.eval(t));
    }
    assert.deepEqual(check.blocked().toJSON(), blocked().toJSON());
  });
});

describe("check.tool — a RegExp name, and { min, max }", () => {
  const t = makeTrace({
    toolCalls: [call("Write"), call("Write"), call("mcp__github__merge")],
  });

  test("a RegExp matches by pattern and names the tool it caught", () => {
    const r = check.tool(/^mcp__github__/).eval(t);
    assert.equal(r.pass, true);
    assert.match(r.message, /mcp__github__merge/);
    assert.deepEqual(check.tool(/^mcp__/).toJSON(), {
      kind: "tool",
      name: "/^mcp__/",
      regex: true,
    });
  });

  test("a run that captured nothing says to stream it", () => {
    assert.match(
      check.tool("Write").eval(makeTrace()).message,
      /no tools \(did you set transcript: true\?\)/,
    );
  });

  test("bounds count the matching calls", () => {
    assert.equal(check.tool("Write", { max: 2 }).eval(t).pass, true);
    assert.equal(check.tool("Write", { min: 2, max: 2 }).eval(t).pass, true);
    const r = check.tool("Write", { max: 1 }).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /at most 1 time\(s\); it was used 2/);
    assert.match(r.message, /mcp__github__merge/);
    assert.equal(check.tool("Read", { min: 1 }).eval(t).pass, false);
    assert.deepEqual(check.tool("Write", { min: 1, max: 3 }).toJSON(), {
      kind: "tool",
      name: "Write",
      min: 1,
      max: 3,
    });
  });

  test("a bound that cannot mean anything is refused when the check is built", () => {
    assert.throws(() => check.tool("Write", {}), /give `min`, `max` or both/);
    assert.throws(
      () => check.tool("Write", { min: 3, max: 1 }),
      /min 3 is above max 1/,
    );
    assert.throws(() => check.tool("Write", { max: -1 }), /whole numbers/);
  });
});

describe("check.toolSequence — an order, gaps allowed", () => {
  const t = makeTrace({
    toolCalls: [call("Read"), call("Grep"), call("Edit")],
  });

  test("a subsequence passes; the wrong order says where it stuck", () => {
    assert.equal(check.toolSequence(["Read", "Edit"]).eval(t).pass, true);
    assert.equal(check.toolSequence([/^Re/, "Edit"]).eval(t).pass, true);
    const r = check.toolSequence(["Edit", "Read"]).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /"Edit" → "Read"/);
    assert.match(r.message, /no "Read" after step 1/);
    assert.deepEqual(check.toolSequence(["Read", /^E/]).toJSON(), {
      kind: "toolSequence",
      names: ["Read", "/^E/"],
    });
  });

  test("an empty order is refused", () => {
    assert.throws(() => check.toolSequence([]), /at least one/);
  });
});

describe("check.notTool — a RegExp names the tool it caught", () => {
  test("pass, and the offending tool on failure", () => {
    const t = makeTrace({ toolCalls: [call("Edit", { input: { a: 1 } })] });
    assert.equal(check.notTool(/^Bash$/).eval(t).pass, true);
    const r = check.notTool(/Bash|Edit/).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /"Edit": \{"a":1\}/);
    assert.deepEqual(check.notTool(/x/, { a: 1 }).toJSON(), {
      kind: "notTool",
      name: "/x/",
      regex: true,
      args: { a: 1 },
    });
  });
});

describe("check.hookFired — event or label, a RegExp, { blocked }", () => {
  const t = makeTrace({
    hooks: [hook("PreToolUse:Edit", true), hook("PostToolUse:Bash")],
  });

  test("matches the label as well as the event", () => {
    assert.equal(check.hookFired("PreToolUse:Edit").eval(t).pass, true);
    assert.equal(check.hookFired("PostToolUse").eval(t).pass, true);
    assert.equal(check.hookFired(/^Pre/).eval(t).pass, true);
    const miss = check.hookFired("Stop").eval(t);
    assert.match(miss.message, /\[PreToolUse:Edit, PostToolUse:Bash\]/);
    assert.match(
      check.hookFired("Stop").eval(makeTrace()).message,
      /none \(did you set transcript: true\?\)/,
    );
  });

  test("{ blocked: true } demands a block", () => {
    assert.equal(
      check.hookFired("PreToolUse", { blocked: true }).eval(t).pass,
      true,
    );
    const r = check.hookFired("PostToolUse", { blocked: true }).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /to block, but none did/);
    assert.match(
      check.hookFired("PreToolUse", { blocked: true }).eval(t).message,
      /fired and blocked/,
    );
    assert.deepEqual(check.hookFired(/^Pre/, { blocked: true }).toJSON(), {
      kind: "hookFired",
      event: "/^Pre/",
      regex: true,
      blocked: true,
    });
  });
});

describe("check.runs — the compiled-hook shell parser over ToolCall.shell", () => {
  const push = (cmd: string): Trace => makeTrace({ toolCalls: [shell(cmd)] });

  for (const cmd of [
    "git push -f origin main",
    "git push --force origin main",
    `git push "--force" origin main`,
    "git push '-f' origin main",
    "sudo git push --force origin main",
    "/usr/bin/git push -f",
    "cd repo && git push -f",
    `bash -c 'git push --force'`,
  ])
    test(`a force push in any spelling: ${cmd}`, () => {
      const r = check.runs("git push", { force: true }).eval(push(cmd));
      assert.equal(r.pass, true, r.message);
    });

  for (const cmd of [
    "git push origin main", // not forced
    "echo git push -f", // the words as data, not a command
    "git log --format=push", // the program is not `git push`
  ])
    test(`not a force push: ${cmd}`, () => {
      const r = check.runs("git push", { force: true }).eval(push(cmd));
      assert.equal(r.pass, false);
      assert.match(r.message, /shell commands run: \[/);
    });

  test("without force, any `git push` is a match", () => {
    assert.equal(
      check.runs("git push").eval(push("git push origin main")).pass,
      true,
    );
  });

  test("a run with no shell command says so", () => {
    const r = check
      .runs("git push")
      .eval(makeTrace({ toolCalls: [call("Read")] }));
    assert.equal(r.pass, false);
    assert.match(r.message, /recorded no shell command \(tools: \[Read\]\)/);
  });

  test("serializes, and refuses an empty program", () => {
    assert.deepEqual(check.runs("git push", { force: true }).toJSON(), {
      kind: "runs",
      program: "git push",
      force: true,
    });
    assert.deepEqual(check.runs("ls").toJSON(), {
      kind: "runs",
      program: "ls",
    });
    assert.throws(() => check.runs(" "), /give the program/);
  });

  test("composes with assertChecks like every other check", () => {
    assert.throws(() => {
      assertChecks(push("git push origin main"), [
        check.runs("git push", { force: true }),
      ]);
    }, /1 of 1 check\(s\) failed/);
  });
});
