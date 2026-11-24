/**
 * PARITY: every assertion and predicate removed in v50 has a `check.*` form that
 * says the same thing — the table the "one form" migration stood on, kept now
 * that the old forms are gone.
 *
 * Each row is (the removed function, its check, a trace the old one FAILED on,
 * and the FACTS its message carried — names, counts, inputs, hints). The check's
 * failure message must carry every one of those facts, so "the new form is
 * poorer than what it replaced" still cannot ship unnoticed. Exact strings are
 * not compared: the check's wording is its own.
 *
 * The predicate half: each check that replaced a bare predicate (`usedTool`,
 * `skillResolved`, …) passes on a trace where the predicate held and fails on
 * one where it did not.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { check, assertChecks, type Check } from "./check.js";
import type { HarnessTestResult, ToolCall, HookFire } from "./harness-test.js";
import type { HookRunResult } from "./run-hook.js";

function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { name, input: {}, resultText: "", isError: false, ...over };
}

function hook(name: string, blocked = false): HookFire {
  return {
    name,
    event: name.split(":")[0] ?? name,
    exitCode: blocked ? 2 : 0,
    blocked,
    output: "",
  };
}

function run(over: Partial<HarnessTestResult> = {}): HarnessTestResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    cwd: "/tmp/x",
    turns: 1,
    toolCalls: [],
    hooks: [],
    output: "",
    modelRequests: [],
    file: () => null,
    cleanup: () => undefined,
    [Symbol.asyncDispose]: () => Promise.resolve(),
    ...over,
  };
}

function hookRun(over: Partial<HookRunResult> = {}): HookRunResult {
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

/** What a failing `assertChecks` said, or a failure if it did not throw. */
function messageOf(f: () => void): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the check to fail on this trace");
}

interface RowSpec<T> {
  /** The removed function this row stands for. */
  readonly old: string;
  readonly target: T;
  readonly check: Check<T>;
  /** Facts the OLD message carried, which the check's message must carry too. */
  readonly facts: readonly (string | RegExp)[];
}

/** One row, run: both messages, so rows over different targets share a list. */
interface Row {
  readonly label: string;
  readonly facts: readonly (string | RegExp)[];
  readonly message: () => string;
}

function row<T>(r: RowSpec<T>): Row {
  return {
    label: `${r.old} → ${JSON.stringify(r.check.toJSON())}`,
    facts: r.facts,
    message: () =>
      messageOf(() => {
        assertChecks(r.target, [r.check]);
      }),
  };
}

const reads = call("Read", { input: { file_path: "a.ts" } });
const edit = call("Edit", { input: { file_path: "b.ts" } });
const writes = [call("Write"), call("Write"), call("Write")];

const ROWS: readonly Row[] = [
  row<HarnessTestResult>({
    old: "assertToolUsed(name)",
    target: run({ toolCalls: [reads, edit] }),
    check: check.tool("Write"),
    facts: ["Write", "Read", "Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertToolUsed(/re/)",
    target: run({ toolCalls: [reads] }),
    check: check.tool(/^mcp__github__/),
    facts: ["/^mcp__github__/", "Read"],
  }),
  row<HarnessTestResult>({
    old: "assertToolUsed on a run that captured nothing",
    target: run(),
    check: check.tool("Write"),
    facts: ["Write", "transcript"],
  }),
  row<HarnessTestResult>({
    old: "assertToolNotUsed(/re/)",
    target: run({ toolCalls: [reads, edit] }),
    check: check.tool(/Bash|Edit/, { max: 0 }),
    facts: ["/Bash|Edit/", "Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertToolUsedWith(name, fn)",
    target: run({ toolCalls: [reads, edit] }),
    check: check.tool("Edit", { with: { file_path: "a.ts" } }),
    facts: ["Edit", "b.ts"],
  }),
  row<HarnessTestResult>({
    old: "assertSkillResolved — not invoked",
    target: run({
      toolCalls: [call("Skill", { input: { skill: "demo:y" } })],
    }),
    check: check.skill("demo:x"),
    facts: ["demo:x", "demo:y"],
  }),
  row<HarnessTestResult>({
    old: "assertSkillResolved — errored",
    target: run({
      toolCalls: [
        call("Skill", {
          input: { skill: "demo:x" },
          isError: true,
          resultText: "Unknown skill: demo:x",
        }),
      ],
    }),
    check: check.skill("demo:x"),
    facts: ["demo:x", "errored", "Unknown skill: demo:x"],
  }),
  row<HarnessTestResult>({
    old: "assertOutputContains",
    target: run({ output: "nothing yet" }),
    check: check.output("done"),
    facts: ["done", "nothing yet"],
  }),
  row<HarnessTestResult>({
    old: "assertRequestContains — no requests",
    target: run(),
    check: check.received("injected"),
    facts: ["injected", /no requests captured/],
  }),
  row<HarnessTestResult>({
    old: "assertRequestContains — some requests",
    target: run({
      modelRequests: [
        { system: "sys", messages: [{ role: "user", text: "hi" }] },
      ],
    }),
    check: check.received("injected"),
    facts: ["injected", "1 request(s) captured"],
  }),
  row<HarnessTestResult>({
    old: "assertHookFired(label)",
    target: run({ hooks: [hook("PostToolUse:Bash")] }),
    check: check.hookFired("PreToolUse:Edit"),
    facts: ["PreToolUse:Edit", "PostToolUse:Bash"],
  }),
  row<HarnessTestResult>({
    old: "assertHookFired on a run that captured nothing",
    target: run(),
    check: check.hookFired("Stop"),
    facts: ["Stop", "transcript"],
  }),
  row<HarnessTestResult>({
    old: "assertHookFired(name, { blocked: true })",
    target: run({ hooks: [hook("PreToolUse:Edit")] }),
    check: check.hookFired("PreToolUse", { blocked: true }),
    facts: ["PreToolUse", /block/, "PreToolUse:Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertToolCount({ max })",
    target: run({ toolCalls: [...writes, reads] }),
    check: check.tool("Write", { max: 1 }),
    facts: ["Write", "1", "3", "Read"],
  }),
  row<HarnessTestResult>({
    old: "assertToolCount({ exactly })",
    target: run({ toolCalls: [call("Write")] }),
    check: check.tool("Write", { min: 2, max: 2 }),
    facts: ["Write", "2", "1"],
  }),
  row<HarnessTestResult>({
    old: "assertToolSequence",
    target: run({ toolCalls: [reads, edit] }),
    check: check.toolSequence(["Edit", "Read"]),
    facts: ["Edit", "Read", "→"],
  }),
  row<HarnessTestResult>({
    old: "assertToolCalls(pred, message)",
    target: run({ toolCalls: [edit] }),
    check: check<HarnessTestResult>(
      "every Edit after a Read",
      (t) => t.toolCalls[0]?.name === "Read",
    ),
    facts: ["every Edit after a Read", "Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertCreated",
    target: run(),
    check: check.writes({ include: ["out.txt"] }),
    facts: ["out.txt", /create/],
  }),
  row<HarnessTestResult>({
    old: "assertNotCreated",
    target: run({ file: (p) => (p === "secrets.env" ? "x" : null) }),
    check: check.writes({ none: ["secrets.env"] }),
    facts: ["secrets.env", /NOT/],
  }),
  row<HookRunResult>({
    old: "assertHookBlocked",
    target: hookRun({ event: "PreToolUse", exitCode: 0 }),
    check: check.hookFired("PreToolUse", { blocked: true }),
    facts: ["exit 0", /allowed/],
  }),
  row<HookRunResult>({
    old: "assertHookAllowed",
    target: hookRun({
      event: "PreToolUse",
      exitCode: 2,
      blocked: true,
      decision: "deny",
    }),
    check: check.hookFired("PreToolUse", { blocked: false }),
    facts: ["exit 2", "deny", /blocked/],
  }),
];

describe("parity: each removed assertion's facts survive in its check", () => {
  for (const r of ROWS)
    test(r.label, () => {
      const now = r.message();
      for (const fact of r.facts) {
        const has =
          typeof fact === "string" ? now.includes(fact) : fact.test(now);
        assert.ok(has, `the check lost ${String(fact)}: ${now}`);
      }
    });
});

describe("parity: each removed predicate's check holds and fails where it did", () => {
  const hit = run({
    toolCalls: [reads, edit, call("Skill", { input: { skill: "demo:x" } })],
    hooks: [hook("PreToolUse:Edit", true)],
    output: "all done",
    modelRequests: [{ system: "ctx: injected", messages: [] }],
  });
  const miss = run();
  const pairs: readonly [string, Check<HarnessTestResult>][] = [
    ["usedTool", check.tool("Edit")],
    ["usedTool(/re/)", check.tool(/^Ed/)],
    ["toolCount ≥ 1", check.tool("Read", { min: 1 })],
    ["skillResolved", check.skill("demo:x")],
    ["toolUsedWith", check.tool("Edit", { with: { file_path: "b.ts" } })],
    ["outputContains", check.output(/done/)],
    ["requestContains", check.received("injected")],
    ["hookBlocked", check.hookFired("PreToolUse", { blocked: true })],
  ];
  for (const [name, c] of pairs)
    test(`${name} → ${JSON.stringify(c.toJSON())}`, () => {
      assert.equal(c.eval(hit).pass, true, "on a trace where it held");
      assert.equal(c.eval(miss).pass, false, "on a trace where it did not");
    });
});
