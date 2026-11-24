/**
 * ONE set of `check.*` cases, run unchanged by three runners — node:test
 * (`checks.node-test.mjs`), vitest (`matchers.vitest.mjs`) and jest
 * (`matchers.jest.cjs`). Loaded from the built package root (`dist/entries/index.js`, the
 * `vigiles` entry), so what is exercised is what a user imports.
 *
 * Each case: a target, the checks, and whether `assertChecks` must pass. The
 * runner only iterates; nothing here depends on which runner calls it, which is
 * the claim being tested.
 */
const { check, assertChecks } = require("../../dist/entries/index.js");

const call = (name, extra = {}) => ({
  name,
  input: {},
  resultText: "",
  isError: false,
  ...extra,
});

const trace = (extra = {}) => ({
  toolCalls: [],
  hooks: [],
  output: "",
  modelRequests: [],
  turns: 1,
  file: () => null,
  ...extra,
});

const run = trace({
  toolCalls: [
    call("Read"),
    call("Edit"),
    call("Skill", { input: { skill: "demo:greet" } }),
    call("Bash", { shell: `sudo git push "--force" origin main` }),
  ],
  hooks: [
    {
      name: "PreToolUse:Edit",
      event: "PreToolUse",
      exitCode: 2,
      blocked: true,
      output: "",
    },
  ],
  output: "all done",
});

/** @type {readonly { name: string, target: unknown, checks: readonly unknown[], pass: boolean }[]} */
const CASES = [
  {
    name: "the built-in members hold on a run that did these things",
    target: run,
    checks: [
      check.tool("Read"),
      check.tool(/^Ed/),
      check.tool("Edit", { max: 1 }),
      check.toolSequence(["Read", "Edit"]),
      check.tool("Write", { max: 0 }),
      check.tool("Skill", { with: { skill: "demo:greet" } }),
      check.skill("demo:greet"),
      check.output(/done/),
      check.hookFired("PreToolUse:Edit", { blocked: true }),
      check.runs("git push", { force: true }),
      check("read before edit", (t) => t.toolCalls[0].name === "Read"),
    ],
    pass: true,
  },
  {
    name: "one hook run: it ran for the event and blocked",
    target: { event: "PreToolUse", ran: true, blocked: true, exitCode: 2 },
    checks: [check.hookFired("PreToolUse", { blocked: true })],
    pass: true,
  },
  {
    name: "a hook that never ran did not allow anything",
    target: { event: "PreToolUse", ran: false, blocked: false, exitCode: 0 },
    checks: [check.hookFired("PreToolUse", { blocked: false })],
    pass: false,
  },
  {
    name: "a recorded run's writes stay inside `only`",
    target: { filesWritten: ["out.txt"] },
    checks: [check.writes({ only: ["out.txt"], none: [/\.env$/] })],
    pass: true,
  },
  {
    name: "a run that never recorded its writes fails, not passes",
    target: {},
    checks: [check.writes({ none: [".env"] })],
    pass: false,
  },
  {
    name: "a bound it broke fails",
    target: run,
    checks: [check.tool("Read", { min: 2 })],
    pass: false,
  },
  {
    name: "the wrong order fails",
    target: run,
    checks: [check.toolSequence(["Edit", "Read"])],
    pass: false,
  },
  {
    name: "a command it never ran fails",
    target: run,
    checks: [check.runs("rm")],
    pass: false,
  },
  {
    name: "a named custom check that does not hold fails",
    target: run,
    checks: [
      check("no edits", (t) => !t.toolCalls.some((c) => c.name === "Edit")),
    ],
    pass: false,
  },
  {
    name: "skill activations the harness cannot observe fail, naming it",
    target: trace({
      skills: {
        observable: false,
        harness: "some-harness",
        why: "no commands",
      },
    }),
    checks: [check.skill("demo:greet")],
    pass: false,
  },
];

/** Run one case: undefined when it behaved, else what went wrong. */
function verdict(c) {
  try {
    assertChecks(c.target, c.checks);
    return c.pass ? undefined : `expected "${c.name}" to fail, and it passed`;
  } catch (e) {
    return c.pass ? `expected "${c.name}" to pass: ${e.message}` : undefined;
  }
}

module.exports = { CASES, verdict };
