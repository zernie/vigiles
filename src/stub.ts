/**
 * `experimental_stub` — a tool stub that answers PER INVOCATION, for the eval
 * tier's `stubs`. The rules and their matching are in `core/stub-rules.ts`; this
 * is the typed helper and the check over a run's recorded calls.
 *
 * ONE experimental root (STABILITY.md "one root per feature"): `rest` and
 * `called` are members, so no stable name rests on an unstable one. The rules
 * themselves are plain data (`ToolStub`): a `.mjs` literal of the same shape is
 * accepted, because the spec boundary parses `stubs` either way.
 */
import type { Check, CheckResult } from "./check.js";
import type { Trace } from "./harness-test.js";
import { parseToolStubs } from "./core/eval-spec-parse.js";
import {
  ARGV_REST,
  describePattern,
  matchArgv,
  toToolStub,
  type ArgvPattern,
  type ArgvToken,
  type StubCall,
  type StubRule,
  type ToolStub,
} from "./core/stub-rules.js";

/** Bounds for {@link experimental_stub.called}. */
export interface StubCalledBounds {
  /** At least this many matching calls. Default 1, or 0 when `max` is given. */
  readonly min?: number;
  /** At most this many. Default: no limit. */
  readonly max?: number;
  /** Order-free tokens after the positional prefix (needs a trailing `rest`). */
  readonly contains?: readonly ArgvToken[];
}

const result = (pass: boolean, message: string): CheckResult => ({
  pass,
  score: pass ? 1 : 0,
  message,
});

/** The failure for a trace that carries no stub log at all. */
const noLog = (shown: string): CheckResult =>
  result(
    false,
    `stub ${shown}: this trace has no stub log — the run declared no stubs, or its tier does not record them`,
  );

/** How many of a run's stub calls are `name` with an argv matching `argv` (+ `contains`). */
function countCalls(
  calls: readonly StubCall[],
  name: string,
  argv: ArgvPattern,
  contains: readonly ArgvToken[] | undefined,
): number {
  return calls.filter(
    (c) => c.tool === name && matchArgv({ argv, contains }, c.argv),
  ).length;
}

/** The [min, max] a `called` check accepts, and how a report prints it. */
function rangeOf(bounds: StubCalledBounds): {
  readonly min: number;
  readonly max: number;
  readonly text: string;
} {
  const min = bounds.min ?? (bounds.max === undefined ? 1 : 0);
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  const text = Number.isFinite(max)
    ? `${String(min)}..${String(max)}`
    : `at least ${String(min)}`;
  return { min, max, text };
}

/**
 * A check over a run's stub log: the invocations of `name` that match `argv`
 * (and `bounds.contains`) number within `[min, max]`. A trace with no stub log
 * FAILS — "called at most 0 times" must not pass because nothing was recorded.
 */
function called(
  name: string,
  argv: ArgvPattern,
  bounds: StubCalledBounds = {},
): Check<Trace> {
  // The pattern is parsed the way a rule is (rest position, RegExp flags).
  const rule = { argv, contains: bounds.contains, reply: { kind: "always" } };
  parseToolStubs([{ name, rules: [rule] }], "experimental_stub.called");
  const { min, max, text } = rangeOf(bounds);
  const shown = `${name} ${describePattern(argv)}`;
  return {
    kind: "stubCalled",
    eval(t: Trace): CheckResult {
      if (t.stubCalls === undefined) return noLog(shown);
      const n = countCalls(t.stubCalls, name, argv, bounds.contains);
      const msg = `stub ${shown} called ${String(n)} time(s) (expected ${text})`;
      return result(n >= min && n <= max, msg);
    },
    toJSON: () => ({
      kind: "stubCalled",
      tool: name,
      argv: describePattern(argv),
      min,
      max: Number.isFinite(max) ? max : null,
    }),
  };
}

/** Parse one stub: a throw names the bad field; the value is plain data. */
function stubOf(
  name: string,
  rules: readonly [StubRule, ...StubRule[]],
): ToolStub {
  parseToolStubs([{ name, rules }], "experimental_stub");
  return toToolStub({ name, rules });
}

/**
 * A stub for the binary `name`: a non-empty list of rules over its argv, first
 * match wins. An invocation no rule answers fails the eval — name each command
 * the agent runs; do not answer everything with one output.
 *
 * ```ts
 * const { rest } = experimental_stub;
 * const gh = experimental_stub("gh", [
 *   { argv: ["issue", "create", rest], reply: { kind: "always", stdout: "https://github.com/o/r/issues/9001\n" } },
 *   { argv: ["api", /^repos\/o\/r\/issues\?/], reply: { kind: "always", stdout: "[]" } },
 * ]);
 * ```
 *
 * `experimental_stub.rest` — "any further tokens", last position only.
 * `experimental_stub.called(name, argv, { min, max, contains })` — a check over
 * the run's recorded calls.
 *
 * @experimental
 */
// eslint-disable-next-line functional/immutable-data -- the one experimental root: a callable with members, built the way experimental_agent is
export const experimental_stub = Object.assign(stubOf, {
  rest: ARGV_REST,
  called,
});
