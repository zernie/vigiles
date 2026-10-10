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
  type ArgvPattern,
  type ArgvToken,
  type StubRule,
  type ToolStub,
} from "./core/stub-rules.js";

const result = (pass: boolean, message: string): CheckResult => ({
  pass,
  score: pass ? 1 : 0,
  message,
});

/** Bounds for {@link experimental_stub.called}. */
export interface StubCalledBounds {
  /** At least this many matching calls. Default 1, or 0 when `max` is given. */
  readonly min?: number;
  /** At most this many. Default: no limit. */
  readonly max?: number;
  /** Order-free tokens after the positional prefix (needs a trailing `rest`). */
  readonly contains?: readonly ArgvToken[];
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
  // Parse the pattern the way a rule is parsed (rest position, RegExp flags).
  parseToolStubs(
    [{ name, rules: [{ argv, contains: bounds.contains, reply: { kind: "always" } }] }],
    "experimental_stub.called",
  );
  const min = bounds.min ?? (bounds.max === undefined ? 1 : 0);
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  const shown = `${name} ${describePattern(argv)}`;
  const range = max === Number.POSITIVE_INFINITY
    ? `at least ${String(min)}`
    : `${String(min)}..${String(max)}`;
  return {
    kind: "stubCalled",
    eval(t: Trace): CheckResult {
      if (t.stubCalls === undefined)
        return result(
          false,
          `stub ${shown}: this trace has no stub log — the run declared no stubs, or its tier does not record them`,
        );
      const n = t.stubCalls.filter(
        (c) =>
          c.tool === name &&
          matchArgv({ argv, contains: bounds.contains }, c.argv),
      ).length;
      const pass = n >= min && n <= max;
      return result(
        pass,
        `stub ${shown} called ${String(n)} time(s) (expected ${range})`,
      );
    },
    toJSON: () => ({
      kind: "stubCalled",
      tool: name,
      argv: describePattern(argv),
      min,
      max: max === Number.POSITIVE_INFINITY ? null : max,
    }),
  };
}

function stubOf(
  name: string,
  rules: readonly [StubRule, ...StubRule[]],
): ToolStub {
  const [parsed] = parseToolStubs([{ name, rules }], "experimental_stub");
  // parseToolStubs returns exactly one stub for one input, or throws.
  return parsed as ToolStub;
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
export const experimental_stub = Object.assign(stubOf, {
  rest: ARGV_REST,
  called,
});
