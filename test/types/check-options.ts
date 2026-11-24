/**
 * The v52 check options (zernie/vigiles#518) keep the distinctions the removed
 * siblings drew, at compile time:
 *
 * - `check.writes` reads two kinds of run. An agent run (`Trace`) can only look
 *   a path up, so `only` (which needs the full list of writes) and a RegExp are
 *   type errors against it — never a silent pass.
 * - `check.hook` reads an agent run and one `runHook` result alike.
 * - `check.tool` takes `with` and bounds; `check.turns` takes `matching`.
 */
import { check, assertChecks, type Trace, type HookRunResult } from "vigiles";

declare const trace: Trace;
declare const hookRun: HookRunResult;

// Exact paths: both kinds of run.
assertChecks(trace, [check.writes({ none: ["secrets.env"] })]);
assertChecks(trace, [check.writes({ include: ["out.txt"], none: [".env"] })]);
assertChecks(hookRun, [check.writes({ none: ["secrets.env"] })]);

// `only` and patterns: a recorded run only.
assertChecks(hookRun, [check.writes({ only: ["out.txt", /^tmp\//] })]);
assertChecks(hookRun, [check.writes({ none: [/\.env$/] })]);

// @ts-expect-error -- an agent run cannot list every write, so `only` cannot be judged on it
assertChecks(trace, [check.writes({ only: ["out.txt"] })]);

// @ts-expect-error -- a pattern needs the list of writes, which an agent run does not have
assertChecks(trace, [check.writes({ none: [/\.env$/] })]);

// check.hook: both kinds of run, with the verdict.
assertChecks(trace, [check.hook("PreToolUse:Edit", { blocked: true })]);
assertChecks(hookRun, [check.hook("PreToolUse", { blocked: false })]);

// @ts-expect-error -- a hook decision is not an agent run: tool checks do not read it
assertChecks(hookRun, [check.tool("Bash")]);

// tool options and turns.
assertChecks(trace, [
  check.tool("Bash", { with: { command: /git push/ }, max: 0 }),
  check.tool("Write", { max: 0 }),
  check.turns({ matching: /## Status/, max: 1 }),
  check.output(/done/, { eachReply: true }),
  check.experimental_agentResult("err"),
  check.experimental_agentResult((r) => r.kind === "ok"),
]);
