/**
 * `experimental_stub` — the typed helper, and `.called`, the check that turns
 * "an issue was created in this trial" into a measured precondition instead of
 * an assumption.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { experimental_stub } from "./stub.js";
import type { Trace } from "./harness-test.js";
import type { StubCall } from "./core/stub-rules.js";

const { rest } = experimental_stub;

const trace = (stubCalls: readonly StubCall[] | undefined): Trace => ({
  toolCalls: [],
  hooks: [],
  output: "",
  modelRequests: [],
  turns: 0,
  file: () => null,
  ...(stubCalls === undefined ? {} : { stubCalls }),
});

const CREATE: StubCall = {
  tool: "gh",
  argv: ["issue", "create", "-R", "o/r", "--title", "t", "--body", "b"],
  outcome: { kind: "answered", rule: 0, answer: 0 },
};
const READ: StubCall = {
  tool: "gh",
  argv: ["api", "repos/o/r/issues?state=open"],
  outcome: { kind: "answered", rule: 1, answer: 0 },
};

test("experimental_stub parses and returns plain data — the same thing a .mjs literal would be", () => {
  const gh = experimental_stub("gh", [
    { argv: ["issue", "create", rest], reply: { kind: "always", stdout: "u" } },
  ]);
  assert.equal(gh.name, "gh");
  assert.equal(gh.rules[0].argv[2], rest);
  // `rest` before a token is unrepresentable in TypeScript; a .mjs file can
  // still write it, so the parse refuses it at run time.
  assert.throws(
    () =>
      Reflect.apply(experimental_stub, undefined, [
        "gh",
        [{ argv: [rest, "x"], reply: { kind: "always" } }],
      ]),
    /experimental_stub: stubs\[0\]\.rules\[0\]\.argv/,
  );
});

test(".called: counts matching invocations; default is 'at least once'", () => {
  const created = experimental_stub.called("gh", ["issue", "create", rest]);
  assert.equal(created.eval(trace([READ, CREATE])).pass, true);
  assert.equal(created.eval(trace([READ])).pass, false);
  assert.match(created.eval(trace([READ])).message, /called 0 time/);
  const contains = experimental_stub.called("gh", ["issue", "create", rest], {
    contains: ["o/r"],
  });
  assert.equal(contains.eval(trace([CREATE])).pass, true);
  const never = experimental_stub.called("gh", ["issue", "create", rest], {
    max: 0,
  });
  assert.equal(never.eval(trace([READ])).pass, true);
  assert.equal(never.eval(trace([CREATE])).pass, false);
});

test(".called on a trace with NO stub log fails — 'max: 0' must not pass because nothing was recorded", () => {
  const never = experimental_stub.called("gh", ["issue", "create", rest], {
    max: 0,
  });
  const r = never.eval(trace(undefined));
  assert.equal(r.pass, false);
  assert.match(r.message, /no stub log/);
});

test(".called serialises for reports", () => {
  assert.deepEqual(
    experimental_stub
      .called("gh", ["api", /^repos\//], { min: 2, max: 4 })
      .toJSON(),
    {
      kind: "stubCalled",
      tool: "gh",
      argv: '["api", /^repos\\//]',
      min: 2,
      max: 4,
    },
  );
  assert.equal(experimental_stub.called("gh", ["x"]).toJSON().max, null);
});
