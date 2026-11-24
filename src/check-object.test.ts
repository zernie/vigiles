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
  type Check,
  tool,
  skill,
  output,
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
      [check.skill("p:s"), skill("p:s")],
      [check.output("done"), output("done")],
    ] as const) {
      assert.deepEqual(a.toJSON(), b.toJSON());
      assert.deepEqual(a.eval(t), b.eval(t));
    }
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
    // `{}` is not a bound but no options: one call is enough, as with none
    assert.deepEqual(
      check.tool("Write", {}).toJSON(),
      check.tool("Write").toJSON(),
    );
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

describe("check.tool(name, { max: 0 }) — a RegExp names the tool it caught", () => {
  test("pass, and the offending tool on failure", () => {
    const t = makeTrace({ toolCalls: [call("Edit", { input: { a: 1 } })] });
    assert.equal(check.tool(/^Bash$/, { max: 0 }).eval(t).pass, true);
    const r = check.tool(/Bash|Edit/, { max: 0 }).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /"Edit": \{"a":1\}/);
    assert.deepEqual(check.tool(/x/, { with: { a: 1 }, max: 0 }).toJSON(), {
      kind: "tool",
      name: "/x/",
      regex: true,
      with: { a: 1 },
      max: 0,
    });
  });

  test("`with` and a bound count only the calls whose input matches", () => {
    const t = makeTrace({
      toolCalls: [
        call("Bash", { input: { command: "git push" } }),
        call("Bash", { input: { command: "ls" } }),
        call("Bash", { input: { command: "git push -f" } }),
      ],
    });
    const pushes = { command: /git push/ };
    assert.equal(
      check.tool("Bash", { with: pushes, max: 2 }).eval(t).pass,
      true,
    );
    const r = check.tool("Bash", { with: pushes, max: 1 }).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /with command=\/git push\/ to be used at most 1/);
    assert.equal(
      check.tool("Bash", { with: { command: "ls" } }).eval(t).pass,
      true,
    );
  });

  test("a global or sticky RegExp in `with` counts every matching call, not every other one", () => {
    const t = makeTrace({
      toolCalls: [
        call("Bash", { input: { command: "git push" } }),
        call("Bash", { input: { command: "git push" } }),
      ],
    });
    for (const re of [/git push/g, /git push/y]) {
      const r = check.tool("Bash", { with: { command: re }, max: 1 }).eval(t);
      assert.equal(r.pass, false, String(re));
      assert.equal(re.lastIndex, 0, `${String(re)} left untouched`);
    }
  });
});

describe("check.hook — event or label, a RegExp, { blocked }", () => {
  const t = makeTrace({
    hooks: [hook("PreToolUse:Edit", true), hook("PostToolUse:Bash")],
  });

  test("matches the label as well as the event", () => {
    assert.equal(check.hook("PreToolUse:Edit").eval(t).pass, true);
    assert.equal(check.hook("PostToolUse").eval(t).pass, true);
    assert.equal(check.hook(/^Pre/).eval(t).pass, true);
    const miss = check.hook("Stop").eval(t);
    assert.match(miss.message, /\[PreToolUse:Edit, PostToolUse:Bash\]/);
    assert.match(
      check.hook("Stop").eval(makeTrace()).message,
      /none \(did you set transcript: true\?\)/,
    );
  });

  test("{ blocked: true } demands a block", () => {
    assert.equal(
      check.hook("PreToolUse", { blocked: true }).eval(t).pass,
      true,
    );
    const r = check.hook("PostToolUse", { blocked: true }).eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /to block, but none did/);
    assert.match(
      check.hook("PreToolUse", { blocked: true }).eval(t).message,
      /fired and blocked/,
    );
    assert.deepEqual(check.hook(/^Pre/, { blocked: true }).toJSON(), {
      kind: "hook",
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

// --- the members that replaced the last throwing assertions over a run ------

import type { HookRunResult } from "./run-hook.js";

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

describe("check.delivered — a nudge's text reached the model", () => {
  test("passes on delivered; each other verdict fails with its own cause", () => {
    assert.equal(
      check.delivered().eval(
        hookResult({
          delivery: {
            kind: "delivered",
            via: ["additional-context"],
            stranded: [],
          },
        }),
      ).pass,
      true,
    );
    const why = (delivery: HookRunResult["delivery"], ran = true) =>
      check.delivered().eval(hookResult({ delivery, ran })).message;
    assert.match(
      why({
        kind: "undelivered",
        stranded: [{ stream: "stderr", bytes: 237, why: "dead stream" }],
      }),
      /237 bytes on stderr: dead stream/,
    );
    assert.match(
      why({ kind: "silent" }),
      /printed nothing addressed to the model/,
    );
    assert.match(why({ kind: "silent" }, false), /never ran/);
    assert.match(
      why({ kind: "blocked", stranded: [] }),
      /a block is not a nudge/,
    );
    assert.match(
      why({
        kind: "unknown",
        event: "Notification",
        why: "no row for Notification",
      }),
      /cannot be judged: no row/,
    );
    assert.deepEqual(check.delivered().toJSON(), { kind: "delivered" });
  });
});

describe("check.egress / check.writes — a confined run's effects", () => {
  const reached = hookResult({
    egress: [
      { host: "registry.npmjs.org", port: 443, ts: 1 },
      { host: "evil.example", port: 80, ts: 2 },
    ],
    filesWritten: [".omc/state/x.json", "out.txt"],
  });

  test("egress: { none: true } means nowhere; an allowlist names the offender", () => {
    assert.equal(check.egress({ none: true }).eval(hookResult()).pass, true);
    assert.match(
      check.egress({ none: true }).eval(reached).message,
      /registry\.npmjs\.org:443, evil\.example:80/,
    );
    assert.equal(
      check.egress({ only: ["registry.npmjs.org", /evil\./] }).eval(reached)
        .pass,
      true,
    );
  });

  test("none / only / include name the file; unrecorded writes FAIL, not pass", () => {
    assert.equal(check.writes({ none: [".env"] }).eval(reached).pass, true);
    assert.match(
      check.writes({ none: [/\.json$/] }).eval(reached).message,
      /x\.json/,
    );
    assert.match(
      check.writes({ only: [/^\.omc\//] }).eval(reached).message,
      /outside `only`: out\.txt/,
    );
    assert.equal(
      check.writes({ only: [/^\.omc\//, "out.txt"] }).eval(reached).pass,
      true,
    );
    // a string is an exact path (a leading ./ aside), not a substring
    assert.equal(
      check.writes({ include: ["./out.txt"] }).eval(reached).pass,
      true,
    );
    assert.equal(check.writes({ none: ["out"] }).eval(reached).pass, true);
    assert.match(
      check.writes({ include: ["missing.txt"] }).eval(reached).message,
      /wrote nothing matching missing\.txt/,
    );
    const unrecorded: { readonly filesWritten?: readonly string[] } = {};
    assert.equal(check.writes({ none: [".env"] }).eval(unrecorded).pass, false);
    assert.match(check.writes({ only: [] }).eval(unrecorded).message, /record/);
  });

  test("they compose with assertChecks", () => {
    assert.throws(() => {
      const effects: readonly Check<HookRunResult>[] = [
        check.egress({ none: true }),
        check.writes({ none: ["out.txt"] }),
      ];
      assertChecks(reached, effects);
    }, /evil\.example[\s\S]*out\.txt/);
  });
});

describe("check.tokens — one budget check for every token class", () => {
  const run = (u: Partial<Record<string, number>>) => ({
    usage: {
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ...u,
    },
  });
  test("max, maxInput, maxOutput and maxCache each bound their class", () => {
    assert.equal(
      check.tokens({ max: 10 }).eval(run({ inputTokens: 4, outputTokens: 5 }))
        .pass,
      true,
    );
    assert.match(
      check.tokens({ max: 8 }).eval(run({ inputTokens: 4, outputTokens: 5 }))
        .message,
      /9/,
    );
    assert.match(
      check.tokens({ maxInput: 3 }).eval(run({ inputTokens: 4 })).message,
      /input/,
    );
    assert.match(
      check.tokens({ maxOutput: 3 }).eval(run({ outputTokens: 4 })).message,
      /output/,
    );
    assert.match(
      check
        .tokens({ maxCache: 5 })
        .eval(run({ cacheCreationTokens: 3, cacheReadTokens: 3 })).message,
      /cache/,
    );
    assert.deepEqual(check.tokens({ maxInput: 3, maxCache: 5 }).toJSON(), {
      kind: "tokens",
      maxInput: 3,
      maxCache: 5,
    });
  });
});

test("the flat input/output/cache token members are folded into check.tokens", () => {
  for (const gone of ["inputTokens", "outputTokens", "cacheTokens"]) {
    assert.ok(!(gone in check), `check.${gone} is folded into check.tokens`);
  }
});
