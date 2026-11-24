/**
 * PARITY: every old assertion and predicate has a `check.*` form that says the
 * same thing — the table the "one form" migration stands on.
 *
 * Each row is (old function, new check, a trace the old one FAILS on). The test
 * runs both, and asserts the check's failure message carries every FACT the old
 * message carried — the names, counts, inputs and hints a reader needs to fix
 * the test. Exact strings are not compared: the check's wording is its own, and
 * a row lists the facts rather than the sentence. A fact the old message had and
 * the check's lacks is a failing row, so "the new form is poorer" cannot ship
 * unnoticed.
 *
 * The predicate half: each bare predicate (`usedTool`, `skillResolved`, …) and
 * its check agree on pass AND fail traces, read as `check.x(…).eval(t).pass`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { check, assertChecks, type Check } from "./check.js";
import {
  assertToolUsed,
  assertToolNotUsed,
  assertToolUsedWith,
  assertSkillResolved,
  assertOutputContains,
  assertRequestContains,
  assertHookFired,
  assertToolCount,
  assertToolSequence,
  assertToolCalls,
  assertCreated,
  assertNotCreated,
  assertHookBlocked,
  assertHookAllowed,
  usedTool,
  toolCount,
  skillResolved,
  toolUsedWith,
  outputContains,
  requestContains,
  hookBlocked,
} from "./harness-assert.js";
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

/** What a throwing assertion said, or a failure if it did not throw. */
function messageOf(f: () => void): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the old assertion to fail on this trace");
}

interface RowSpec<T> {
  readonly old: string;
  readonly target: T;
  readonly fail: (t: T) => void;
  readonly check: Check<T>;
  /** Facts the OLD message carries, which the check's message must carry too. */
  readonly facts: readonly (string | RegExp)[];
}

/** One row, run: both messages, so rows over different targets share a list. */
interface Row {
  readonly label: string;
  readonly facts: readonly (string | RegExp)[];
  readonly messages: () => { readonly old: string; readonly now: string };
}

function row<T>(r: RowSpec<T>): Row {
  return {
    label: `${r.old} → ${JSON.stringify(r.check.toJSON())}`,
    facts: r.facts,
    messages: () => ({
      old: messageOf(() => {
        r.fail(r.target);
      }),
      now: messageOf(() => {
        assertChecks(r.target, [r.check]);
      }),
    }),
  };
}

/** A test's tool-input reader: the `file_path` of an Edit, when it has one. */
const filePath = (input: unknown): unknown =>
  typeof input === "object" && input !== null && "file_path" in input
    ? input.file_path
    : undefined;

const reads = call("Read", { input: { file_path: "a.ts" } });
const edit = call("Edit", { input: { file_path: "b.ts" } });
const writes = [call("Write"), call("Write"), call("Write")];

const ROWS: readonly Row[] = [
  row<HarnessTestResult>({
    old: "assertToolUsed(name)",
    target: run({ toolCalls: [reads, edit] }),
    fail: (t) => {
      assertToolUsed(t, "Write");
    },
    check: check.tool("Write"),
    facts: ["Write", "Read", "Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertToolUsed(/re/)",
    target: run({ toolCalls: [reads] }),
    fail: (t) => {
      assertToolUsed(t, /^mcp__github__/);
    },
    check: check.tool(/^mcp__github__/),
    facts: ["/^mcp__github__/", "Read"],
  }),
  row<HarnessTestResult>({
    old: "assertToolUsed on a run that captured nothing",
    target: run(),
    fail: (t) => {
      assertToolUsed(t, "Write");
    },
    check: check.tool("Write"),
    facts: ["Write", "transcript"],
  }),
  row<HarnessTestResult>({
    old: "assertToolNotUsed(/re/)",
    target: run({ toolCalls: [reads, edit] }),
    fail: (t) => {
      assertToolNotUsed(t, /Bash|Edit/);
    },
    check: check.notTool(/Bash|Edit/),
    facts: ["/Bash|Edit/", "Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertToolUsedWith(name, fn)",
    target: run({ toolCalls: [reads, edit] }),
    fail: (t) => {
      assertToolUsedWith(t, "Edit", (i) => filePath(i) === "a.ts");
    },
    check: check.toolWith("Edit", { file_path: "a.ts" }),
    facts: ["Edit", "b.ts"],
  }),
  row<HarnessTestResult>({
    old: "assertSkillResolved — not invoked",
    target: run({
      toolCalls: [call("Skill", { input: { skill: "demo:y" } })],
    }),
    fail: (t) => {
      assertSkillResolved(t, "demo:x");
    },
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
    fail: (t) => {
      assertSkillResolved(t, "demo:x");
    },
    check: check.skill("demo:x"),
    facts: ["demo:x", "errored", "Unknown skill: demo:x"],
  }),
  row<HarnessTestResult>({
    old: "assertOutputContains",
    target: run({ output: "nothing yet" }),
    fail: (t) => {
      assertOutputContains(t, "done");
    },
    check: check.output("done"),
    facts: ["done", "nothing yet"],
  }),
  row<HarnessTestResult>({
    old: "assertRequestContains — no requests",
    target: run(),
    fail: (t) => {
      assertRequestContains(t, "injected");
    },
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
    fail: (t) => {
      assertRequestContains(t, "injected");
    },
    check: check.received("injected"),
    facts: ["injected", "1 request(s) captured"],
  }),
  row<HarnessTestResult>({
    old: "assertHookFired(label)",
    target: run({ hooks: [hook("PostToolUse:Bash")] }),
    fail: (t) => {
      assertHookFired(t, "PreToolUse:Edit");
    },
    check: check.hookFired("PreToolUse:Edit"),
    facts: ["PreToolUse:Edit", "PostToolUse:Bash"],
  }),
  row<HarnessTestResult>({
    old: "assertHookFired on a run that captured nothing",
    target: run(),
    fail: (t) => {
      assertHookFired(t, "Stop");
    },
    check: check.hookFired("Stop"),
    facts: ["Stop", "transcript"],
  }),
  row<HarnessTestResult>({
    old: "assertHookFired(name, { blocked: true })",
    target: run({ hooks: [hook("PreToolUse:Edit")] }),
    fail: (t) => {
      assertHookFired(t, "PreToolUse", { blocked: true });
    },
    check: check.hookFired("PreToolUse", { blocked: true }),
    facts: ["PreToolUse", /block/, "PreToolUse:Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertToolCount({ max })",
    target: run({ toolCalls: [...writes, reads] }),
    fail: (t) => {
      assertToolCount(t, "Write", { max: 1 });
    },
    check: check.tool("Write", { max: 1 }),
    facts: ["Write", "1", "3", "Read"],
  }),
  row<HarnessTestResult>({
    old: "assertToolCount({ exactly })",
    target: run({ toolCalls: [call("Write")] }),
    fail: (t) => {
      assertToolCount(t, "Write", { exactly: 2 });
    },
    check: check.tool("Write", { min: 2, max: 2 }),
    facts: ["Write", "2", "1"],
  }),
  row<HarnessTestResult>({
    old: "assertToolSequence",
    target: run({ toolCalls: [reads, edit] }),
    fail: (t) => {
      assertToolSequence(t, ["Edit", "Read"]);
    },
    check: check.toolSequence(["Edit", "Read"]),
    facts: ["Edit", "Read", "→"],
  }),
  row<HarnessTestResult>({
    old: "assertToolCalls(pred, message)",
    target: run({ toolCalls: [edit] }),
    fail: (t) => {
      assertToolCalls(
        t,
        (calls) => calls[0]?.name === "Read",
        "every Edit after a Read",
      );
    },
    check: check<HarnessTestResult>(
      "every Edit after a Read",
      (t) => t.toolCalls[0]?.name === "Read",
    ),
    facts: ["every Edit after a Read", "Edit"],
  }),
  row<HarnessTestResult>({
    old: "assertCreated",
    target: run(),
    fail: (t) => {
      assertCreated(t, "out.txt");
    },
    check: check.wrote("out.txt"),
    facts: ["out.txt", /create/],
  }),
  row<HarnessTestResult>({
    old: "assertNotCreated",
    target: run({ file: (p) => (p === "secrets.env" ? "x" : null) }),
    fail: (t) => {
      assertNotCreated(t, "secrets.env");
    },
    check: check.didNotWrite("secrets.env"),
    facts: ["secrets.env", /NOT/],
  }),
  row<HookRunResult>({
    old: "assertHookBlocked",
    target: hookRun({ exitCode: 0 }),
    fail: (r) => {
      assertHookBlocked(r);
    },
    check: check.blocked(),
    facts: ["exit 0", /allowed/],
  }),
  row<HookRunResult>({
    old: "assertHookAllowed",
    target: hookRun({ exitCode: 2, blocked: true, decision: "deny" }),
    fail: (r) => {
      assertHookAllowed(r);
    },
    check: check.allowed(),
    facts: ["exit 2", "deny", /blocked/],
  }),
];

describe("parity: each old assertion's facts survive in its check", () => {
  for (const r of ROWS)
    test(r.label, () => {
      const { old, now } = r.messages();
      for (const fact of r.facts) {
        const has = (m: string): boolean =>
          typeof fact === "string" ? m.includes(fact) : fact.test(m);
        assert.ok(
          has(old),
          `the table is wrong: the OLD message lacks ${String(fact)}: ${old}`,
        );
        assert.ok(
          has(now),
          `the check lost ${String(fact)} — old: ${old}\nnew: ${now}`,
        );
      }
    });
});

describe("parity: each predicate agrees with its check", () => {
  const hit = run({
    toolCalls: [reads, edit, call("Skill", { input: { skill: "demo:x" } })],
    hooks: [hook("PreToolUse:Edit", true)],
    output: "all done",
    modelRequests: [{ system: "ctx: injected", messages: [] }],
  });
  const miss = run();
  const pairs: readonly [
    string,
    (t: HarnessTestResult) => boolean,
    Check<HarnessTestResult>,
  ][] = [
    ["usedTool", (t) => usedTool(t, "Edit"), check.tool("Edit")],
    ["usedTool(/re/)", (t) => usedTool(t, /^Ed/), check.tool(/^Ed/)],
    [
      "toolCount ≥ 1",
      (t) => toolCount(t, "Read") >= 1,
      check.tool("Read", { min: 1 }),
    ],
    ["skillResolved", (t) => skillResolved(t, "demo:x"), check.skill("demo:x")],
    [
      "toolUsedWith",
      (t) => toolUsedWith(t, "Edit", (i) => filePath(i) === "b.ts"),
      check.toolWith("Edit", { file_path: "b.ts" }),
    ],
    ["outputContains", (t) => outputContains(t, /done/), check.output(/done/)],
    [
      "requestContains",
      (t) => requestContains(t, "injected"),
      check.received("injected"),
    ],
    [
      "hookBlocked",
      (t) => hookBlocked(t, "PreToolUse"),
      check.hookFired("PreToolUse", { blocked: true }),
    ],
  ];
  for (const [name, predicate, c] of pairs)
    test(`${name} ≡ ${JSON.stringify(c.toJSON())}`, () => {
      assert.equal(
        c.eval(hit).pass,
        predicate(hit),
        "on a trace where it holds",
      );
      assert.equal(c.eval(hit).pass, true);
      assert.equal(
        c.eval(miss).pass,
        predicate(miss),
        "on a trace where it does not",
      );
      assert.equal(c.eval(miss).pass, false);
    });
});
