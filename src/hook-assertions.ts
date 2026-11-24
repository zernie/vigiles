/**
 * Testing a COMPILED hook in-process — the runner and the check behind `vigiles/hook/testing`.
 *
 * `experimental_loadHook(file)` loads the hook the way the runtime does,
 * `runHookProgram(hook, event)` runs it on a raw event, and the check
 * `experimental_decision(...)` asserts on the outcome through `assertChecks` /
 * `toPass`: no subprocess, no model. They are NOT on `vigiles/hook`:
 * that entry is the only import a compiled hook may have, so anything on it is
 * reachable from inside every hook (src/hook-entry-effects.test.ts). This module
 * still stays small, because the CLI runner loads it beside the hook under test:
 * it imports the pure evaluator and the check counter, never the harness runner
 * or the eval tier.
 */
import {
  hookSource,
  runHookProgram as evaluateHookProgram,
} from "./core/hook-program.js";
import type {
  AnyHook,
  RawHookEvent,
  HookProgramOutcome,
} from "./core/hook-program.js";
import type { Check, CheckResult } from "./check.js";
import type { StateFact } from "./core/hook-state.js";
import { recordCheck, recordSurfaceProbe } from "./check-count.js";

/** Render a {@link HookProgramOutcome} for a check message. */
function describeOutcome(o: HookProgramOutcome): string {
  if (o.kind === "decision") return `${o.decision.kind} (a gate decision)`;
  if (o.kind === "injection") return `an injection`;
  return `${o.reaction.kind} (a reaction)`;
}

/**
 * Run a COMPILED hook (a `vigiles/hook` program) on one raw event, in-process —
 * no subprocess, no model — and return its outcome, dispatched by role
 * (`{ kind: "decision" | "injection" | "reaction", … }`). Assert on it with
 * `experimental_decision(...)`:
 *
 * ```ts
 * import { assertChecks } from "vigiles";
 * import { experimental_decision, experimental_loadHook, runHookProgram }
 *   from "vigiles/hook/testing";
 *
 * const hook = await experimental_loadHook(".vigiles/hooks/guard.hook.mjs");
 * assertChecks(runHookProgram(hook, event), [experimental_decision("deny")]);
 * ```
 *
 * It is the pure evaluator the runtime uses — with the same optional `ctx` (the
 * facts a gate's `needs` read) and project `root` — counted AND attributed: an
 * in-process hook decision is an observation the CLI runner can see — without
 * it, a `*.harness.*` file that only tests compiled hooks would look like it
 * did nothing at all (see check-count.ts).
 *
 * 🔴 THE PROBE BELONGS HERE, AND NOWHERE EARLIER OR LATER. Not at LOAD:
 * `experimental_loadHook` only remembers the path, and someone loading a hook
 * to inspect its shape has not run it. Not in the core evaluator: that is what
 * the CLI's `hook-runtime run-program` calls on every live event in production,
 * and recording there would fire outside any test. This runner is the only
 * place that has both facts — the hook is about to be evaluated, and (when it
 * came from `experimental_loadHook`) we know its file. A compiled hook cannot
 * import `vigiles/hook/testing`, so it never runs in production.
 *
 * ⚠️ A hook built in-process rather than loaded from disk has no file to name,
 * so nothing is attributed and nothing is invented — a missed record, never a
 * false one.
 *
 * @public
 */
export function runHookProgram(
  hook: AnyHook,
  event: RawHookEvent,
  ctx?: Readonly<Record<string, string | boolean | StateFact>>,
  root?: string,
): HookProgramOutcome {
  recordCheck();
  // The path `experimental_loadHook` resolved: exact by construction.
  const source = hookSource(hook);
  if (source !== undefined) recordSurfaceProbe("command", source);
  return evaluateHookProgram(hook, event, { ...ctx }, root ?? event.cwd);
}

/**
 * What a hook's outcome must be, for {@link experimental_decision}: a gate
 * decision (`deny`, `allow`), a react hook's `notice(…)`, or a react hook that
 * stays `silent` (`nothing()`).
 *
 * @beta
 */
export type ExpectedDecision = "deny" | "allow" | "notice" | "silent";

const pass = (message: string): CheckResult => ({
  pass: true,
  score: 1,
  message,
});
const fail = (message: string): CheckResult => ({
  pass: false,
  score: 0,
  message,
});

/** A matcher as a message shows it: the string, or `/source/flags`. */
const show = (m: string | Readonly<RegExp>): string =>
  typeof m === "string" ? m : `/${m.source}/${m.flags}`;

/** Did the notice's message match? A string is a substring; a RegExp is tested. */
function matches(message: string, matcher: string | Readonly<RegExp>): boolean {
  return typeof matcher === "string"
    ? message.includes(matcher)
    : matcher.test(message);
}

/** The verdict of one expectation over one outcome. */
function decide(
  o: HookProgramOutcome,
  expect: ExpectedDecision,
  matcher: string | Readonly<RegExp> | undefined,
): CheckResult {
  switch (expect) {
    case "deny":
    case "allow":
      return o.kind === "decision" && o.decision.kind === expect
        ? pass(`the hook decided ${expect}`)
        : fail(`expected the hook to ${expect}, got ${describeOutcome(o)}`);
    case "silent":
      if (o.kind !== "reaction")
        return fail(`expected a react hook, got ${describeOutcome(o)}`);
      return o.reaction.kind === "none"
        ? pass("the hook stayed silent")
        : fail(`expected the hook to stay silent, got ${describeOutcome(o)}`);
    case "notice":
      return noticed(o, matcher);
  }
}

/** The `notice` expectation: a notice reaction, its message matching `matcher` if given. */
function noticed(
  o: HookProgramOutcome,
  matcher: string | Readonly<RegExp> | undefined,
): CheckResult {
  if (o.kind !== "reaction" || o.reaction.kind !== "notice")
    return fail(`expected the hook to notice, got ${describeOutcome(o)}`);
  const { message } = o.reaction;
  if (matcher === undefined || matches(message, matcher))
    return pass("the hook noticed");
  return fail(
    `expected the notice to match ${show(matcher)}, got ${JSON.stringify(message)}`,
  );
}

/**
 * The check over a compiled hook's outcome ({@link runHookProgram}): it
 * decided `deny` or `allow` (a gate), or reacted with a `notice` — whose message
 * contains `matcher` (a string) or matches it (a RegExp), when given — or stayed
 * `silent` (a react hook returning `nothing()`; a `run(…)` reaction is not
 * silent, the hook still reacted). The silent half is the one that regresses:
 * together `notice` and `silent` pin a react hook firing when it should and
 * NOT firing when it shouldn't.
 *
 * Reading the outcome in-process means no stream enters into it: a probe built
 * on stdout alone once reported a healthy react hook as dead (measured against
 * three real hooks on 2026-08-03), and which stream carries a notice now
 * depends on the event. For the hook wired into the real CLI, use
 * `check.hook(event, { blocked })` over a `runHook` result.
 *
 * @experimental Tests the experimental compiled-hook vocabulary
 * (`experimental_define*`), so it moves with it.
 *
 * @beta
 */
export function experimental_decision(
  expect: ExpectedDecision,
  matcher?: string | Readonly<RegExp>,
): Check<HookProgramOutcome> {
  return {
    kind: "decision",
    eval: (o) => decide(o, expect, matcher),
    toJSON: () => ({
      kind: "decision",
      expect,
      ...(matcher !== undefined && { matcher: show(matcher) }),
    }),
  };
}
