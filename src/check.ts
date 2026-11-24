/**
 * `vigiles/check` — the declarative check vocabulary (Phase 0 of the testing-API
 * revamp; see `research/testing-api-design.md`).
 *
 * A **check** is *data*, not a throwing assertion: a small object that knows how
 * to `eval` itself against a result and how to `toJSON`. One vocabulary, evaluated
 * two ways downstream — strict (`expect`, throws on first fail) for the
 * deterministic tiers, and scored (`measure`, 0–1 across trials) for evals — so
 * `tool("Bash")` reads as pass/fail on one run AND as a rate across many. Because
 * a check serializes, JSON/JUnit/baseline output and a promptfoo bridge fall out
 * for free.
 *
 * Pure + model-free: every check is fully unit-testable without a `claude`
 * subprocess. Checks over a {@link Trace} (the agent-run shape, from
 * `runHarness`/`runEval`) and checks over a {@link HookRunResult} (the hook
 * decision shape, from `runHook`) are distinguished at the type level, so
 * `expect(result, checks)` only accepts checks that match the result.
 */
import type {
  Trace,
  ToolCall,
  HookFire,
  SubagentTrace,
} from "./harness-test.js";
import type { HookRunResult } from "./run-hook.js";
import type { SkillFacts } from "./core/harness-driver.js";
import { parseShellCommand } from "./core/hook-program.js";
import { judge as runJudge } from "./judge.js";
import { recordCheck } from "./check-count.js";
import { delivered, egress } from "./effect-checks.js";
import {
  parseAgentResult,
  type ParsedAgentResult,
} from "./core/agent-result.js";
import type { OutputContract } from "./core/spec.js";
import {
  type ArgMatcher,
  matchesArgs,
  stringifyValue,
  describeArgs,
  serializeArgs,
} from "./arg-match.js";

export type { ArgMatcher };

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * The outcome of evaluating one check against one result.
 *
 * @public
 */
export interface CheckResult {
  /** Did the check hold? */
  readonly pass: boolean;
  /** 0..1 — `pass ? 1 : 0` for a boolean check; a fraction for graded ones. */
  readonly score: number;
  /** A human message: confirming on pass, actionable on failure. */
  readonly message: string;
}

/**
 * A check's serialized form (for JSON/JUnit output and the promptfoo bridge).
 *
 * @public
 */
export interface CheckJSON {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/**
 * A declarative check over a result of type `T` ({@link Trace} or {@link HookRunResult}).
 *
 * @public
 */
export interface Check<T> {
  /** Discriminator, e.g. `"tool"`, `"skill"`, `"blocked"`. */
  readonly kind: string;
  /** Evaluate this check against a result. Pure. */
  eval(target: T): CheckResult;
  /** Serialize to a plain object — `expect`/`measure` use this for reports. */
  toJSON(): CheckJSON;
}

/** Evaluate every check against a target. Pure — the shared core of `expect`
 * (strict) and `measure` (scored). */
export function evalChecks<T>(
  target: T,
  checks: readonly Check<T>[],
): CheckResult[] {
  return checks.map((c) => c.eval(target));
}

/**
 * Strict evaluator (Phase 1): throw if any check fails, collecting **all**
 * failures into one actionable message (Validation-applicative, not
 * short-circuit). The deterministic-tier verdict — use it in `node:test`, or any
 * runner, over a `runHook` / `runHarness` result. `measure` (Phase 3) is the
 * scored counterpart over trials.
 *
 * @public
 */
export function assertChecks<T>(target: T, checks: readonly Check<T>[]): void {
  const failures = evalChecks(target, checks).filter((r) => !r.pass);
  if (failures.length > 0) {
    throw new Error(
      `${String(failures.length)} of ${String(checks.length)} check(s) failed:\n` +
        failures.map((f) => `  ✗ ${f.message}`).join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ok = (message: string): CheckResult => ({
  pass: true,
  score: 1,
  message,
});
const no = (message: string): CheckResult => ({
  pass: false,
  score: 0,
  message,
});

/**
 * `Bash(git:*)` → `Bash`. A declaration may carry a restriction; a trace never
 * does, so the two only meet on the base name. Same one-liner as
 * `core/tool-contract.ts` / `core/lethal-trifecta.ts`, kept local because the
 * testing pillar does not otherwise depend on the linting core.
 */
function baseTool(raw: string): string {
  return raw.split("(")[0].trim();
}

function distinctToolNames(calls: readonly ToolCall[]): string {
  const names = [...new Set(calls.map((c) => c.name))];
  return names.length > 0 ? `[${names.join(", ")}]` : "no tools";
}

function truncate(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/**
 * Does `text` match? A RegExp is copied first: with `g` / `y`, `test` advances
 * `lastIndex` on the object it is called on, so reusing the caller's object
 * would miss on its second reply or its second trial.
 */
const matches = (matcher: string | Readonly<RegExp>, text: string): boolean =>
  typeof matcher === "string"
    ? text.includes(matcher)
    : new RegExp(matcher).test(text);

/** A matcher as the report prints it: the string, or the RegExp literal. */
const show = (matcher: string | Readonly<RegExp>): string =>
  typeof matcher === "string" ? matcher : `/${matcher.source}/${matcher.flags}`;

/** A tool/hook name matcher: a string is an exact name, a RegExp is tested. */
type NameMatcher = string | Readonly<RegExp>;

const nameIs = (matcher: NameMatcher, name: string): boolean =>
  typeof matcher === "string"
    ? name === matcher
    : new RegExp(matcher).test(name);

/** A name matcher as a message prints it: `"Bash"` or `/^mcp__/`. */
const showName = (matcher: NameMatcher): string =>
  typeof matcher === "string" ? `"${matcher}"` : show(matcher);

/** A name matcher's serialized fields — the string as before, a RegExp flagged. */
const nameJSON = (
  matcher: NameMatcher,
): { readonly name: string; readonly regex?: true } =>
  typeof matcher === "string"
    ? { name: matcher }
    : { name: show(matcher), regex: true };

/** The tools a run used, with the hint an empty list needs. */
function usedTools(calls: readonly ToolCall[]): string {
  return calls.length > 0
    ? distinctToolNames(calls)
    : "no tools (did you set transcript: true?)";
}

/** Why a reply check cannot run: the trace carries no replies to read. */
const NO_REPLIES =
  "the run has no `replies` (the harness does not tell replies apart, or the run was not streamed — pass `transcript: true`)";

/** Why a `{ min, max }` bound cannot mean anything, or null when it can. */
function boundsProblem(opts: {
  readonly min?: number;
  readonly max?: number;
}): string | null {
  const given = [opts.min, opts.max].filter((n) => n !== undefined);
  if (given.length === 0) return "give `min`, `max` or both";
  if (given.some((n) => !Number.isInteger(n) || n < 0))
    return "bounds are whole numbers, 0 or more";
  if (opts.min !== undefined && opts.max !== undefined && opts.min > opts.max)
    return `min ${String(opts.min)} is above max ${String(opts.max)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Trace checks (an agent run — runHarness / runEval)
// ---------------------------------------------------------------------------

/**
 * The options of `check.tool`: which calls count (`with`) and how many of them
 * there may be (`min` / `max`).
 *
 * - `{ max: 1 }` — at most one call; `{ min: n, max: n }` — exactly n.
 * - `{ max: 0 }` — the tool was NOT used: the safety negative, the decision not
 *   to act that a completion grader cannot see.
 * - `{ with: { command: /git push/ } }` — at least one call whose `input`
 *   matches; with `max: 0`, no call with that input ("did not push to `main`"
 *   still allows pushing elsewhere).
 *
 * @public
 */
export interface ToolOptions {
  /** Only calls whose `input` matches count (see {@link ArgMatcher}). */
  readonly with?: ArgMatcher;
  /** At least this many matching calls. */
  readonly min?: number;
  /** At most this many matching calls; `0` forbids the tool. */
  readonly max?: number;
}

/** What a bound demands, as a message prints it: "at least 1 and at most 2". */
function boundText(opts: ToolOptions): string {
  return [
    opts.min !== undefined ? `at least ${String(opts.min)}` : null,
    opts.max !== undefined ? `at most ${String(opts.max)}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" and ");
}

/**
 * `check.tool`: the agent invoked a tool by this name (regardless of result).
 * A RegExp matches by pattern (`check.tool(/^mcp__github__/)`). Options narrow
 * which calls count and bound how many there are — see {@link ToolOptions}.
 * Without `min` / `max`, one matching call is enough.
 */
function toolCheck(name: NameMatcher, opts: ToolOptions = {}): Check<Trace> {
  const bounded = opts.min !== undefined || opts.max !== undefined;
  if (bounded) {
    const problem = boundsProblem(opts);
    if (problem !== null) throw new Error(`tool: ${problem}`);
  }
  if (opts.max === 0 && (opts.min ?? 0) === 0) return toolAbsent(name, opts);
  if (!bounded) return toolPresent(name, opts);
  const what =
    opts.with === undefined
      ? `tool ${showName(name)}`
      : `tool ${showName(name)} with ${describeArgs(opts.with)}`;
  const want = boundText(opts);
  return {
    kind: "tool",
    eval: (t) => {
      const n = callsOf(t, name, opts).length;
      const pass =
        (opts.min === undefined || n >= opts.min) &&
        (opts.max === undefined || n <= opts.max);
      return pass
        ? ok(`${what} used ${String(n)} time(s) (${want})`)
        : no(
            `expected ${what} to be used ${want} time(s); it was used ${String(n)} (tools: ${usedTools(t.toolCalls)})`,
          );
    },
    toJSON: () => toolJSON(name, opts),
  };
}

/** The calls `check.tool` counts: the name matches, and the input if `with` is given. */
function callsOf(
  t: Trace,
  name: NameMatcher,
  opts: ToolOptions,
): readonly ToolCall[] {
  const named = t.toolCalls.filter((c) => nameIs(name, c.name));
  const args = opts.with;
  return args === undefined
    ? named
    : named.filter((c) => matchesArgs(c.input, args));
}

/** `check.tool`'s serialized form: the name, then whichever options were given. */
function toolJSON(name: NameMatcher, opts: ToolOptions): CheckJSON {
  return {
    kind: "tool",
    ...nameJSON(name),
    ...(opts.with !== undefined && { with: serializeArgs(opts.with) }),
    ...(opts.min !== undefined && { min: opts.min }),
    ...(opts.max !== undefined && { max: opts.max }),
  };
}

/** `check.tool(name)` / `check.tool(name, { with })`: at least one matching call. */
function toolPresent(name: NameMatcher, opts: ToolOptions): Check<Trace> {
  const args = opts.with;
  return {
    kind: "tool",
    eval: (t) => {
      const named = t.toolCalls.filter((c) => nameIs(name, c.name));
      const first = named[0];
      if (first === undefined) {
        const want = args === undefined ? "" : ` (with ${describeArgs(args)})`;
        return no(
          `expected the agent to use tool ${showName(name)}${want}, but it used ${usedTools(t.toolCalls)}`,
        );
      }
      if (args === undefined)
        return typeof name === "string"
          ? ok(`agent used tool "${name}"`)
          : ok(`agent used tool "${first.name}" (matched ${showName(name)})`);
      const want = describeArgs(args);
      return named.some((c) => matchesArgs(c.input, args))
        ? ok(`agent used ${showName(name)} with ${want}`)
        : no(
            `agent used ${showName(name)} but never with ${want} (saw ${named
              .map((c) => truncate(stringifyValue(c.input), 60))
              .join("; ")})`,
          );
    },
    toJSON: () => toolJSON(name, opts),
  };
}

/**
 * `check.tool(name, { max: 0 })`: the agent did NOT use the tool — or, with
 * `with`, never called it with that input. The negative a completion-grading
 * eval structurally cannot make: it sees the agent's decision to act, not just
 * its final text.
 */
function toolAbsent(name: NameMatcher, opts: ToolOptions): Check<Trace> {
  const what =
    opts.with === undefined
      ? showName(name)
      : `${showName(name)} with ${describeArgs(opts.with)}`;
  return {
    kind: "tool",
    eval: (t) => {
      const first = callsOf(t, name, opts)[0];
      if (first === undefined) return ok(`agent never used ${what}`);
      // A pattern names a family of tools, so say which one it caught.
      const which = typeof name === "string" ? "" : `"${first.name}": `;
      return no(
        `expected the agent NOT to use ${what}, but it did (${which}${truncate(stringifyValue(first.input), 60)})`,
      );
    },
    toJSON: () => toolJSON(name, opts),
  };
}

/** The agent invoked a tool by this name (regardless of result). */
export function tool(name: string): Check<Trace> {
  return toolCheck(name);
}

/**
 * The named tools ran in this order, as a subsequence (other calls may sit
 * between them): `toolSequence(["Read", "Edit"])` is "a Read came before an
 * Edit". A RegExp entry matches by pattern. Reached as `check.toolSequence`.
 */
function toolSequence(
  names: readonly (string | Readonly<RegExp>)[],
): Check<Trace> {
  if (names.length === 0)
    throw new Error("toolSequence: give at least one tool name");
  const order = names.map(showName).join(" → ");
  return {
    kind: "toolSequence",
    eval: (t) => {
      const matched = t.toolCalls.reduce((i, c) => {
        const want = names[i];
        return want !== undefined && nameIs(want, c.name) ? i + 1 : i;
      }, 0);
      if (matched === names.length) return ok(`tools ran in order ${order}`);
      const stuck = names[matched];
      return no(
        `expected tools in order ${order}; got ${usedTools(t.toolCalls)}` +
          (stuck === undefined
            ? ""
            : ` (no ${showName(stuck)} after step ${String(matched)})`),
      );
    },
    toJSON: () => ({
      kind: "toolSequence",
      names: names.map((n) => (typeof n === "string" ? n : show(n))),
    }),
  };
}

/**
 * The agent used **only** tools drawn from `allowed` — the white-list, and the
 * missing half of a symmetry the file surface already has:
 *
 * |       | "not this one"                 | "nothing but these"      |
 * | ----- | ------------------------------ | ------------------------ |
 * | files | `check.writes({ none })`       | `check.writes({ only })` |
 * | tools | `check.tool(name, { max: 0 })` | **`onlyTools`** (this)   |
 *
 * Why the asymmetry mattered: a `{ max: 0 }` bound can only forbid the calls
 * the test author thought of, and the set of undeclared tools is unbounded — so "this
 * skill stayed inside the tools it declares" was not expressible, which is
 * exactly the claim a `SKILL.md` frontmatter makes in prose. See
 * `readSkillContract`, which builds this check from that declaration.
 *
 * **Fails closed on an empty trace.** A `Trace` records tool calls only when the
 * run captured the stream (`transcript: true` on the harness tier; always on the
 * eval tier), so an uncaptured run is indistinguishable from a tool-free one —
 * and passing it would assert nothing. Same discipline as `assertWroteOnly`
 * refusing a result that never recorded writes: "we didn't look" is not "it was
 * clean".
 *
 * 🔴 A `Tool(restriction)` DECLARATION IS MATCHED BY ITS BASE NAME. `allowed-tools:
 * Bash(git:*)` is the ordinary way to write a narrow grant, and `readSkillContract`
 * hands that literal string here — while a trace only ever carries the base name
 * `Bash`, because that is the tool the harness reports. Set membership therefore
 * missed, and every legitimate `Bash` call was reported as outside the declared
 * surface, against a declaration that literally lists Bash (measured 2026-08-11:
 * `agent used tool(s) outside its declared set: Bash (declared: Bash(git:*),
 * Read, Skill)`). A check that fires on its own happy path gets deleted, not
 * debugged — and it would fire on exactly the authors who narrowed their grant.
 *
 * ⚠️ AND THE RESTRICTION ITSELF IS NOT VERIFIED HERE, deliberately. A trace names
 * the tool, not the grant it was matched against, so `Bash(git:*)` can be held to
 * "no tool outside the declared set" and no further; whether the command really
 * was a `git` one is a claim this layer has no evidence for. Narrowing beyond the
 * base name is `disallowed-tools:` + `lethal-trifecta`'s job (see
 * `skill-contract.ts`), which reads the grant instead of the run. The same
 * `split("(")` normalization the rest of the codebase already applies to tool
 * declarations — `core/tool-contract.ts`, `core/lethal-trifecta.ts`,
 * `core/delegation-trifecta.ts`.
 *
 * ⚠️ SPANS THE WHOLE TRACE, deliberately. It answers "did this RUN stay inside
 * these tools?", which is the right question for a harness that drives one thing.
 * It is the wrong question when the trace has setup calls before the surface
 * under test activated, drives several skills, or dispatches a subagent whose
 * nested calls the parser folds into the same flat list — and reporting those as
 * a violation is an accusation about the wrong code.
 *
 * `readSkillContract` therefore does NOT use this directly: it wraps it in a window
 * bounded by its own `Skill` activation (see `duringSkill` in
 * `src/skill-contract.ts`). If you are checking one skill, prefer the contract;
 * reach for this when the claim really is about the whole run.
 */
export function onlyTools(allowed: readonly string[]): Check<Trace> {
  const allow = new Set(allowed.map(baseTool));
  // The declaration is echoed VERBATIM: an author who wrote `Bash(git:*)` must
  // read back what they wrote, not the normalized form the matching used.
  const declared = [...new Set(allowed)].join(", ") || "none";
  return {
    kind: "onlyTools",
    eval: (t) => {
      if (t.toolCalls.length === 0)
        return no(
          `onlyTools cannot run: this trace recorded no tool calls, so passing ` +
            `it would assert nothing. Tool calls are parsed from the stream — ` +
            `pass \`transcript: true\` on the harness tier (the eval tier always ` +
            `captures it). If the run genuinely used no tools there is no tool ` +
            `surface to constrain, and this check does not apply.`,
        );
      // Report EVERY distinct offender, not just the first: a skill reaching for
      // three undeclared tools should not take three runs to discover that.
      const offenders = [
        ...new Set(
          t.toolCalls.map((c) => c.name).filter((name) => !allow.has(name)),
        ),
      ];
      if (offenders.length === 0)
        return ok(`agent used only declared tool(s): ${declared}`);
      return no(
        `agent used tool(s) outside its declared set: ${offenders.join(", ")} ` +
          `(declared: ${declared})`,
      );
    },
    toJSON: () => ({ kind: "onlyTools", allowed: [...allowed] }),
  };
}

/**
 * The skills a trace says fired. A trace from a runner carries the ADAPTER's
 * answer in `skills`; one built by hand, or by a runner older than that field,
 * is read the way this check always read it — `Skill` tool calls — so no
 * existing test changes meaning.
 */
function skillFactsOf(t: Trace): SkillFacts {
  if (t.skills !== undefined) return t.skills;
  return {
    observable: true,
    fired: t.toolCalls.flatMap((c) => {
      if (c.name !== "Skill") return [];
      const id =
        typeof c.input === "object" && c.input !== null && "skill" in c.input
          ? c.input.skill
          : undefined;
      return [
        {
          id: typeof id === "string" ? id : "?",
          isError: c.isError,
          resultText: c.resultText,
        },
      ];
    }),
  };
}

/**
 * A skill resolved to this id without erroring — `<plugin>:<skill>` on Claude
 * Code, the skill's directory name on Codex. Reads `trace.skills`, which the
 * harness's adapter fills, so the same check works on every harness. When the
 * adapter cannot observe skills in the run, the check FAILS naming the harness
 * and why — never as "did not fire", which would be a claim about the skill
 * the run has no evidence for.
 */
export function skill(id: string): Check<Trace> {
  return {
    kind: "skill",
    eval: (t) => {
      const facts = skillFactsOf(t);
      if (!facts.observable)
        return no(
          `cannot tell whether skill "${id}" fired: skill activations are not observable on ${facts.harness} in this run (${facts.why})`,
        );
      const fire = facts.fired.find((f) => f.id === id);
      if (fire !== undefined && !fire.isError)
        return ok(`skill "${id}" resolved`);
      if (fire !== undefined)
        return no(
          `skill "${id}" was invoked but errored: ${fire.resultText.slice(0, 200) || "(no result text)"}`,
        );
      const ids = facts.fired.map((f) => f.id);
      return no(
        `expected skill "${id}" to resolve; it did not (skills invoked: ${ids.length > 0 ? `[${ids.join(", ")}]` : "none"})`,
      );
    },
    toJSON: () => ({ kind: "skill", id }),
  };
}

/**
 * The options of `check.output`.
 *
 * @public
 */
export interface OutputOptions {
  /**
   * Hold the matcher against EVERY reply of the run, not only the final output
   * — for a rule about each reply ("end with a status block"). Reads
   * `trace.replies`; a run that recorded none, or wrote none, FAILS, because
   * there is nothing the rule held for.
   *
   * @experimental The matcher may grow a function form, and a check may come to
   * be attached to a spec rule (vigiles#323).
   */
  readonly eachReply?: boolean;
}

/**
 * The agent's final output contains a substring / matches a RegExp — or, with
 * `{ eachReply: true }`, every reply of the run does.
 */
export function output(
  matcher: string | Readonly<RegExp>,
  opts: OutputOptions = {},
): Check<Trace> {
  if (opts.eachReply === true) return eachReply(matcher);
  const isRe = typeof matcher !== "string";
  return {
    kind: "output",
    eval: (t) => {
      const pass = matches(matcher, t.output);
      return pass
        ? ok(`output matched ${show(matcher)}`)
        : no(
            `expected output to ${isRe ? "match" : "contain"} ${show(matcher)}; got "${truncate(t.output) || "(empty)"}"`,
          );
    },
    toJSON: () => ({ kind: "output", matcher: show(matcher), regex: isRe }),
  };
}

/** `check.output(matcher, { eachReply: true })`: every reply matched. */
function eachReply(matcher: string | Readonly<RegExp>): Check<Trace> {
  return {
    kind: "output",
    eval: (t) => {
      if (t.replies === undefined) return no(NO_REPLIES);
      if (t.replies.length === 0) return no("the run wrote no replies");
      const miss = t.replies.findIndex((r) => !matches(matcher, r));
      return miss === -1
        ? ok(`all ${String(t.replies.length)} replies matched ${show(matcher)}`)
        : no(
            `reply ${String(miss + 1)} of ${String(t.replies.length)} did not match ${show(matcher)}: "${truncate(t.replies[miss] ?? "") || "(empty)"}"`,
          );
    },
    toJSON: () => ({
      kind: "output",
      matcher: show(matcher),
      regex: typeof matcher !== "string",
      eachReply: true,
    }),
  };
}

/**
 * A hook fired for this event (`"PreToolUse"`, `"Stop"`) or with this label
 * (`"PreToolUse:Edit"`). `check.hook` also takes a RegExp and
 * `{ blocked }`.
 */
export function hookFired(event: string): Check<Trace> {
  return hookFiredCheck(event);
}

/**
 * The one run of a hook a `runHook` result describes — the fields
 * `check.hook` reads from it.
 */
type HookRun = Pick<HookRunResult, "ran" | "blocked" | "exitCode" | "event"> &
  Partial<Pick<HookRunResult, "decision">>;

/** What `check.hook` judges: an agent run's hooks, or one hook run. */
type HookTarget = Pick<Trace, "hooks"> | HookRun;

/** The hooks a run fired, by label, with the hint an empty list needs. */
const hooksSeen = (t: Pick<Trace, "hooks">): string =>
  t.hooks.length > 0
    ? `[${[...new Set(t.hooks.map((h) => h.name))].join(", ")}]`
    : "none (did you set transcript: true?)";

/**
 * The options of `check.hook`.
 *
 * @public
 */
export interface HookFiredOptions {
  /**
   * `true`: a matching hook also BLOCKED the event (exit 2 / deny / block / a
   * halted turn). `false`: a matching hook fired and NONE of them blocked — it
   * let the event through. Omitted: firing is enough.
   */
  readonly blocked?: boolean;
}

/**
 * `check.hook`: a hook fired for this event (`"PreToolUse"`) or with this
 * label (`"PreToolUse:Edit"`, `Event:Matcher`); a RegExp is tested against
 * both. With `{ blocked: true }` a matching hook must also have blocked; with
 * `{ blocked: false }` none of them may have.
 *
 * It reads both kinds of result: an agent run (`runHarnessTest` / an eval
 * trial — its `hooks`), and ONE hook run (`runHook` — its `event`, `ran` and
 * `blocked`). On a hook run, "fired" means the process RAN: a hook whose
 * declared condition did not match never ran, so it neither blocked nor
 * allowed anything, and every form of this check fails on it.
 */
function hookFiredCheck(
  event: string | Readonly<RegExp>,
  opts: HookFiredOptions = {},
): Check<HookTarget> {
  const label = typeof event === "string" ? event : show(event);
  return {
    kind: "hook",
    eval: (t) =>
      "hooks" in t
        ? firedInRun(t, event, label, opts)
        : firedAlone(t, event, label, opts),
    toJSON: () => ({
      kind: "hook",
      event: label,
      ...(typeof event !== "string" && { regex: true }),
      ...(opts.blocked !== undefined && { blocked: opts.blocked }),
    }),
  };
}

/** " and blocked" / " and allowed" / "" — what the check demanded beyond firing. */
function verdictText(opts: HookFiredOptions): string {
  if (opts.blocked === undefined) return "";
  return opts.blocked ? " and blocked" : " and allowed";
}

/** `check.hook` over an agent run: any matching hook among `hooks`. */
function firedInRun(
  t: Pick<Trace, "hooks">,
  event: string | Readonly<RegExp>,
  label: string,
  opts: HookFiredOptions,
): CheckResult {
  const fired = t.hooks.filter(
    (h: HookFire) => nameIs(event, h.event) || nameIs(event, h.name),
  );
  if (fired.length === 0)
    return no(
      `expected a hook to fire for ${label}; hooks that fired: ${hooksSeen(t)}`,
    );
  if (opts.blocked === true && !fired.some((h) => h.blocked))
    return no(
      `expected a hook for ${label} to block, but none did; hooks that fired: ${hooksSeen(t)}`,
    );
  const blocker = fired.find((h) => h.blocked);
  if (opts.blocked === false && blocker !== undefined)
    return no(
      `expected the hooks for ${label} to allow, but "${blocker.name}" blocked (exit ${String(blocker.exitCode)})`,
    );
  return ok(`hook for ${label} fired${verdictText(opts)}`);
}

/** `check.hook` over one `runHook` result: it ran, for this event, and decided so. */
function firedAlone(
  r: HookRun,
  event: string | Readonly<RegExp>,
  label: string,
  opts: HookFiredOptions,
): CheckResult {
  if (r.event === undefined)
    return no(
      `cannot tell whether the hook fired for ${label}: the run named no event (give the input a \`hook_event_name\`)`,
    );
  if (!nameIs(event, r.event))
    return no(
      `expected the hook to run for ${label}, but it ran for "${r.event}"`,
    );
  if (!r.ran)
    return no(
      `expected the hook to fire for ${label}, but it never ran (its condition did not match), so it decided nothing`,
    );
  if (opts.blocked === true && !r.blocked)
    return no(
      `expected the hook to block ${label}, but it allowed (exit ${String(r.exitCode)})`,
    );
  if (opts.blocked === false && r.blocked)
    return no(
      `expected the hook to allow ${label}, but it blocked (exit ${String(r.exitCode)}${r.decision === undefined ? "" : `, decision ${r.decision}`})`,
    );
  return ok(`hook fired for ${r.event}${verdictText(opts)}`);
}

/**
 * The agent ran shell command `program` — `runs("git push")`, `runs("git push",
 * { force: true })` for a force push in any spelling (`-f`, `--force`, a quoted
 * flag, `sudo`, `bash -c '…'`). Reads `ToolCall.shell`, the command text the
 * harness's adapter records (Claude Code's `Bash`, Codex's command execution),
 * and asks the compiled-hook shell parser — the same `runs()` a Bash gate uses,
 * so a test and a gate can never disagree about what a command does. Never a
 * pattern over the command string. Reached as `check.runs`.
 */
function runs(
  program: string,
  opts: { readonly force?: boolean } = {},
): Check<Trace> {
  if (program.trim() === "")
    throw new Error('runs: give the program to look for, e.g. "git push"');
  const what = `"${program}"${opts.force === true ? " with --force" : ""}`;
  return {
    kind: "runs",
    eval: (t) => {
      const shells = t.toolCalls.flatMap((c) =>
        c.shell === undefined ? [] : [c.shell],
      );
      const hit = shells.find((cmd) =>
        parseShellCommand(cmd).runs(program, opts),
      );
      if (hit !== undefined)
        return ok(`agent ran ${what}: ${truncate(hit, 80)}`);
      return no(
        shells.length === 0
          ? `expected the agent to run ${what}, but the run recorded no shell command (tools: ${usedTools(t.toolCalls)})`
          : `expected the agent to run ${what}; shell commands run: [${shells.map((c) => truncate(c, 60)).join("; ")}]`,
      );
    },
    toJSON: () => ({
      kind: "runs",
      program,
      ...(opts.force === true && { force: true }),
    }),
  };
}

/**
 * A named custom check — any predicate over the result, so a rule the
 * vocabulary does not spell still reports, serializes and scores like every
 * other check (the role vitest's `toSatisfy` plays). `check("every Edit was
 * preceded by a Read", (t) => …)`. A predicate that throws fails the check with
 * what it threw. Each evaluation counts toward the script's check count, the
 * same as a run does. Called as `check(name, fn)`.
 */
function customCheck<T>(name: string, fn: (target: T) => boolean): Check<T> {
  if (name.trim() === "")
    throw new Error(
      "check: give the check a name — it is what a failure prints",
    );
  return {
    kind: "check",
    eval: (target) => {
      recordCheck();
      try {
        return fn(target)
          ? ok(`check "${name}" held`)
          : no(`check "${name}" failed${toolsOf(target)}`);
      } catch (e) {
        return no(
          `check "${name}" threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    toJSON: () => ({ kind: "check", name }),
  };
}

/** For a failed {@link check} over a run, the tools it used — the context a
 *  custom tool-call rule needs to be debugged. Empty for any other target. */
function toolsOf(target: unknown): string {
  if (typeof target !== "object" || target === null || !("toolCalls" in target))
    return "";
  const calls: unknown = target.toolCalls;
  if (!Array.isArray(calls)) return "";
  const list: readonly unknown[] = calls;
  return list.every(isToolCall) ? `; tools used: ${usedTools(list)}` : "";
}

/** A value shaped like a {@link ToolCall} — enough to print its name. */
function isToolCall(c: unknown): c is ToolCall {
  return (
    typeof c === "object" &&
    c !== null &&
    "name" in c &&
    typeof c.name === "string"
  );
}

/**
 * The model RECEIVED text matching `matcher` in some request — i.e. it actually
 * reached the model. Covers **slash-command expansion** (a `commands/` file
 * expands into the user prompt) and **injected context** (a SessionStart hook's
 * text). Reads `modelRequests`, which the harness/mock tier captures; the eval
 * tier drives the real API and captures none, so use this on `runHarness`.
 */
export function received(matcher: string | RegExp): Check<Trace> {
  const isRe = matcher instanceof RegExp;
  return {
    kind: "received",
    eval: (t) => {
      const text = t.modelRequests
        .map((r) => `${r.system} ${r.messages.map((m) => m.text).join(" ")}`)
        .join(" ");
      const pass = matches(matcher, text);
      return pass
        ? ok(`the model received ${String(matcher)}`)
        : no(
            `expected the model to receive ${String(matcher)} (a slash-command expansion or injected context); ${t.modelRequests.length === 0 ? "no requests captured (eval tier captures none — use runHarness)" : `${String(t.modelRequests.length)} request(s) captured, got "${truncate(text)}"`}`,
          );
    },
    toJSON: () => ({ kind: "received", matcher: String(matcher), regex: isRe }),
  };
}

/**
 * The options of `check.turns`: a bound, and optionally which turns count.
 *
 * @public
 */
export interface TurnsOptions {
  /** At least this many turns (or matching replies). */
  readonly min?: number;
  /** At most this many turns (or matching replies). */
  readonly max?: number;
  /**
   * Count only the turns whose REPLY contains this substring / matches this
   * RegExp — `{ matching: /## Status/, max: 1 }` is "at most one status block
   * for one user message", which a Stop hook that makes the agent reply again
   * can break while `output` still shows one. Reads `trace.replies`; a run that
   * recorded none FAILS rather than counting zero.
   *
   * @experimental See {@link OutputOptions.eachReply}.
   */
  readonly matching?: string | Readonly<RegExp>;
}

/**
 * The agent took a number of model turns in range — a **multi-turn** observable
 * (`{ min: 2 }` asserts a back-and-forth happened, not a one-shot answer; `{ max }`
 * caps runaway loops). The deterministic harness scripts the model turns; this
 * checks how many the agent actually took. With `matching`, only the turns
 * whose reply matches are counted.
 */
export function turns(opts: TurnsOptions): Check<Trace> {
  const problem = boundsProblem(opts);
  if (problem !== null) throw new Error(`turns: ${problem}`);
  if (opts.matching !== undefined) return replyTurns(opts.matching, opts);
  const bound = [
    opts.min !== undefined ? `≥ ${String(opts.min)}` : null,
    opts.max !== undefined ? `≤ ${String(opts.max)}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" and ");
  return {
    kind: "turns",
    eval: (t) => {
      const n = t.turns;
      const pass =
        (opts.min === undefined || n >= opts.min) &&
        (opts.max === undefined || n <= opts.max);
      return pass
        ? ok(`${String(n)} turn(s) (${bound})`)
        : no(`expected ${bound} turn(s), got ${String(n)}`);
    },
    toJSON: () => ({ kind: "turns", min: opts.min, max: opts.max }),
  };
}

/** `check.turns({ matching, min, max })`: how many replies match, within bounds. */
function replyTurns(
  matcher: string | Readonly<RegExp>,
  opts: TurnsOptions,
): Check<Trace> {
  return {
    kind: "turns",
    eval: (t) => {
      if (t.replies === undefined) return no(NO_REPLIES);
      const n = t.replies.filter((r) => matches(matcher, r)).length;
      const pass =
        (opts.min === undefined || n >= opts.min) &&
        (opts.max === undefined || n <= opts.max);
      const bound = `min ${String(opts.min ?? "-")}, max ${String(opts.max ?? "-")}`;
      const says = `${String(n)} of ${String(t.replies.length)} replies matched ${show(matcher)} (${bound})`;
      return pass ? ok(says) : no(`expected ${bound}; ${says}`);
    },
    toJSON: () => ({
      kind: "turns",
      matching: show(matcher),
      regex: typeof matcher !== "string",
      min: opts.min,
      max: opts.max,
    }),
  };
}

/**
 * A path in a `check.writes` list: a string is an EXACT path relative to the
 * work dir; a RegExp is tested against each path the run wrote.
 *
 * @public
 */
export type WritePath = string | Readonly<RegExp>;

/**
 * The options of `check.writes`, on a run that RECORDED its writes — a
 * confined `runHook` / `runScript` result, whose `filesWritten` lists every
 * file the run wrote. At least one is required.
 *
 * @public
 */
export interface WritesOptions {
  /** Every file the run wrote matches one of these — nothing else was written. */
  readonly only?: readonly WritePath[];
  /** No file the run wrote matches any of these. */
  readonly none?: readonly WritePath[];
  /** Each of these matches a file the run wrote. */
  readonly include?: readonly WritePath[];
}

/**
 * The options of `check.writes` that an agent run can answer too. An agent run
 * (a `Trace`) cannot list every file it wrote — it can only look a path up in
 * the work dir — so it takes exact paths, and no `only`: "nothing but these"
 * needs the full list. Passing `only` or a RegExp makes the check one that
 * only a recorded run satisfies, which a `Trace` target then rejects at
 * compile time.
 *
 * @public
 */
export interface PathWritesOptions {
  /** Not on an agent run: "nothing but these" needs the full list of writes. */
  readonly only?: undefined;
  /** No file is at any of these paths. */
  readonly none?: readonly string[];
  /** A file is at each of these paths. */
  readonly include?: readonly string[];
}

/** A run that recorded its writes (`filesWritten`; `undefined` = never recorded). */
type HasWrites = Pick<HookRunResult, "filesWritten">;

/* eslint-disable no-redeclare -- TypeScript function overloads (the base
   no-redeclare rule, unlike @typescript-eslint/no-redeclare, flags them) */
/**
 * `check.writes`: what the run wrote, on either kind of run.
 *
 * - An agent run (`runHarnessTest` / an eval trial): `include` / `none` take
 *   exact paths, looked up in the work dir at the end of the run — a file
 *   there counts, whoever made it.
 * - A hook or script run (`runHook` / `runScript`, confined so it records
 *   `filesWritten`): `only` / `none` / `include`, a string an exact path and a
 *   RegExp a pattern. A run that never recorded writes FAILS rather than
 *   passing having inspected nothing.
 */
function writes(
  opts: PathWritesOptions,
): Check<HasWrites | Pick<Trace, "file">>;
function writes(opts: WritesOptions): Check<HasWrites>;
function writes(opts: WritesOptions): Check<HasWrites | Pick<Trace, "file">> {
  const given = (["only", "none", "include"] as const).filter(
    (k) => opts[k] !== undefined,
  );
  if (given.length === 0)
    throw new Error("writes: give `only`, `none` or `include`");
  return {
    kind: "writes",
    eval: (t) =>
      "file" in t ? writesInWorkDir(t, opts) : writesRecorded(t, opts),
    toJSON: () => ({
      kind: "writes",
      ...Object.fromEntries(given.map((k) => [k, (opts[k] ?? []).map(show)])),
    }),
  };
}
/* eslint-enable no-redeclare */

/** A written path, as both sides spell it: no leading `./`. */
const plainPath = (p: string): string => p.replace(/^(\.\/)+/, "");

const pathIs = (want: WritePath, path: string): boolean =>
  typeof want === "string"
    ? plainPath(want) === plainPath(path)
    : new RegExp(want).test(path);

/** The failures a list of problems makes, or a pass with `passing`. */
function verdictOf(
  problems: readonly (string | null)[],
  passing: string,
): CheckResult {
  const found = problems.filter((x): x is string => x !== null);
  return found.length === 0 ? ok(passing) : no(found.join("; "));
}

const UNRECORDED =
  "writes cannot be judged: this result never recorded file writes, so " +
  "passing it would assert nothing. Writes are captured by diffing the work " +
  'dir, which only a CONFINED run does — pass `{ sandbox: "auto" }` (or ' +
  '`"strict"`) to record them. Note confinement needs Linux + bubblewrap.';

/** `check.writes` over a run that recorded `filesWritten`. */
function writesRecorded(r: HasWrites, opts: WritesOptions): CheckResult {
  const written = r.filesWritten;
  if (written === undefined) return no(UNRECORDED);
  const listed = (list: readonly WritePath[]) => (f: string) =>
    list.some((w) => pathIs(w, f));
  const outside =
    opts.only === undefined
      ? []
      : written.filter((f) => !listed(opts.only ?? [])(f));
  const forbidden = written.filter(listed(opts.none ?? []));
  const missing = (opts.include ?? []).filter(
    (w) => !written.some((f) => pathIs(w, f)),
  );
  return verdictOf(
    [
      outside.length > 0
        ? `wrote outside \`only\`: ${outside.join(", ")}`
        : null,
      forbidden.length > 0
        ? `wrote what \`none\` forbids: ${forbidden.join(", ")}`
        : null,
      missing.length > 0
        ? `wrote nothing matching ${missing.map(show).join(", ")} (wrote: ${written.join(", ") || "nothing"})`
        : null,
    ],
    `the run's writes held (${String(written.length)} file(s) written)`,
  );
}

const ONLY_ON_A_TRACE =
  "writes cannot be judged on an agent run with `only` or a RegExp: the run " +
  "can look a path up in the work dir but cannot list every file written. " +
  "Give exact paths in `include` / `none`, or check a confined hook/script run.";

/** The exact paths of a `check.writes` an agent run can answer, or null when it cannot. */
function exactPaths(opts: WritesOptions): {
  readonly none: readonly string[];
  readonly include: readonly string[];
} | null {
  const none = opts.none ?? [];
  const include = opts.include ?? [];
  const exact = (l: readonly WritePath[]): l is readonly string[] =>
    l.every((w) => typeof w === "string");
  return opts.only === undefined && exact(none) && exact(include)
    ? { none, include }
    : null;
}

/** `check.writes` over an agent run: exact paths looked up in the work dir. */
function writesInWorkDir(
  t: Pick<Trace, "file">,
  opts: WritesOptions,
): CheckResult {
  // The types keep `only` and patterns off an agent run; a JavaScript caller
  // can still pass them, and a check that cannot look must say so, not pass.
  const paths = exactPaths(opts);
  if (paths === null) return no(ONLY_ON_A_TRACE);
  const present = paths.none.filter((p) => t.file(p) !== null);
  const absent = paths.include.filter((p) => t.file(p) === null);
  return verdictOf(
    [
      present.length > 0
        ? `expected the agent NOT to leave ${present.join(", ")}, but it exists`
        : null,
      absent.length > 0
        ? `expected the agent to create ${absent.join(", ")}, but it does not exist`
        : null,
    ],
    `the work dir held what \`writes\` asked (${[...paths.include, ...paths.none].join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// Subagent — a `Task` run as a nested trace. Run checks over what the SUBAGENT
// did, not just that `Task` fired. Composes the whole vocabulary recursively.
// ---------------------------------------------------------------------------

/** Wrap a subagent's tool calls + returned text as a minimal `Trace` so checks
 * (incl. `output()` over the sub's RETURN — where a result() vigiles:ok/err block
 * lands) run over it. */
function subTrace(sub: SubagentTrace): Trace {
  return {
    toolCalls: sub.toolCalls,
    hooks: [],
    output: sub.output,
    modelRequests: [],
    turns: 0,
    subagents: [],
    file: () => null,
  };
}

/** The named subagent (`Task` `subagent_type`) ran and passed every nested check. */
export function subagent(
  name: string,
  checks: readonly Check<Trace>[],
): Check<Trace> {
  return {
    kind: "subagent",
    eval: (t) => {
      const subs = t.subagents ?? [];
      // A `--plugin-dir` agent's `subagent_type` is namespaced `plugin:agent`
      // (e.g. "reviewer-spec:code-reviewer"), but callers pass the bare agent name
      // — so match the full id OR its last `:`-segment. Non-namespaced (harness
      // mock) names match exactly as before.
      const bare = (n: string) =>
        n.includes(":") ? n.slice(n.lastIndexOf(":") + 1) : n;
      const sub = subs.find((s) => s.name === name || bare(s.name) === name);
      if (!sub) {
        return no(
          `expected subagent "${name}" to run; subagents that ran: ${subs.length > 0 ? `[${subs.map((s) => s.name).join(", ")}]` : "none"}`,
        );
      }
      const failures = checks
        .map((c) => c.eval(subTrace(sub)))
        .filter((r) => !r.pass);
      return failures.length === 0
        ? ok(`subagent "${name}" passed ${String(checks.length)} check(s)`)
        : no(
            `subagent "${name}": ${failures.map((f) => f.message).join("; ")}`,
          );
    },
    toJSON: () => ({
      kind: "subagent",
      name,
      checks: checks.map((c) => c.toJSON()),
    }),
  };
}

// ---------------------------------------------------------------------------
// MCP — a tool call is just a name in the Trace; MCP tools are `mcp__srv__tool`
// ---------------------------------------------------------------------------

/** The agent used an MCP tool `<server>/<tool>` (CC names it `mcp__server__tool`). */
export function mcp(server: string, toolName: string): Check<Trace> {
  const full = `mcp__${server}__${toolName}`;
  return {
    kind: "mcp",
    eval: (t) =>
      t.toolCalls.some((c) => c.name === full)
        ? ok(`used MCP tool ${server}/${toolName}`)
        : no(
            `expected MCP tool ${server}/${toolName} (${full}), but the agent used ${distinctToolNames(t.toolCalls)}`,
          ),
    toJSON: () => ({ kind: "mcp", server, tool: toolName }),
  };
}

// ---------------------------------------------------------------------------
// Model-graded — `judged` (LLM rubric). Closes the promptfoo `llm-rubric` /
// DeepEval `GEval` gap: a subjective check that composes into measure/toJUnit
// like any other. The Check.eval is sync (judge() blocks via spawnSync), so it
// fits the same interface; the `judge` fn is injectable for testing.
// ---------------------------------------------------------------------------

/**
 * A model-graded judge: grades `output` against a `rubric` → score in [0,1].
 *
 * @public
 */
export type JudgeFn = (opts: {
  output: string;
  rubric: string;
  threshold?: number;
}) => { score: number; pass: boolean; reason?: string };

/**
 * A model-graded check: the agent's `output` scores ≥ `min` against `rubric`,
 * judged by a model. Unlike the deterministic checks this one calls a model
 * (cost), so it's for the scored `measure` tier; the `judge` fn is injectable
 * (default: the real `judge()`), so the logic is unit-testable with a fake.
 *
 * @public
 */
export function judged(
  rubric: string,
  opts: { min?: number; judge?: JudgeFn } = {},
): Check<Trace> {
  const min = opts.min ?? 0.5;
  const judgeFn: JudgeFn = opts.judge ?? ((o) => runJudge(o));
  return {
    kind: "judged",
    eval: (t) => {
      const r = judgeFn({ output: t.output, rubric, threshold: min });
      const pass = r.score >= min;
      const tail = r.reason ? ` — ${r.reason}` : "";
      return {
        pass,
        score: r.score,
        message: pass
          ? `judge ${r.score.toFixed(2)} ≥ ${String(min)}${tail}`
          : `judge ${r.score.toFixed(2)} < ${String(min)} for "${rubric}"${tail}`,
      };
    },
    toJSON: () => ({ kind: "judged", rubric, min }),
  };
}

// ---------------------------------------------------------------------------
// Resource checks — over a run's usage (cost / latency / tokens). Only the
// eval tier (`RunContext`) carries usage, so these are `Check<UsageTrace>`,
// usable in `measure` but not over a plain harness `Trace` (which has none).
// ---------------------------------------------------------------------------

interface UsageTrace {
  readonly usage: {
    readonly costUsd: number;
    readonly durationMs: number;
    /** Fresh (uncached) input tokens, billed at full input price. */
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Tokens written to the prompt cache this run (~1.25× input price). */
    readonly cacheCreationTokens: number;
    /** Tokens served from the prompt cache this run (~0.1× input price). */
    readonly cacheReadTokens: number;
  };
}

/** The run cost at most `maxUsd`. */
export function cost(opts: { maxUsd: number }): Check<UsageTrace> {
  return {
    kind: "cost",
    eval: (t) => {
      const v = t.usage.costUsd;
      return v <= opts.maxUsd
        ? ok(`cost $${v.toFixed(4)} ≤ $${String(opts.maxUsd)}`)
        : no(`expected cost ≤ $${String(opts.maxUsd)}, got $${v.toFixed(4)}`);
    },
    toJSON: () => ({ kind: "cost", maxUsd: opts.maxUsd }),
  };
}

/** The run took at most `maxMs` of wall-clock time. */
export function latency(opts: { maxMs: number }): Check<UsageTrace> {
  return {
    kind: "latency",
    eval: (t) => {
      const v = t.usage.durationMs;
      return v <= opts.maxMs
        ? ok(`latency ${String(v)}ms ≤ ${String(opts.maxMs)}ms`)
        : no(`expected latency ≤ ${String(opts.maxMs)}ms, got ${String(v)}ms`);
    },
    toJSON: () => ({ kind: "latency", maxMs: opts.maxMs }),
  };
}

/**
 * The token budget of a run, every class in one check. Each bound is checked
 * only when given, and the check passes when every given bound holds:
 *
 * - `max` — total input + output tokens;
 * - `maxInput` — fresh (uncached) input tokens, the honest input side of a cost
 *   claim (a skill or CLAUDE.md injection adds input every turn, so a
 *   "compression" win on output can be erased here);
 * - `maxOutput` — output tokens, the generation side;
 * - `maxCache` — prompt-cache tokens, written plus served.
 *
 * @public
 */
export type TokenBudget =
  | {
      readonly max: number;
      readonly maxInput?: number;
      readonly maxOutput?: number;
      readonly maxCache?: number;
    }
  | {
      readonly max?: number;
      readonly maxInput: number;
      readonly maxOutput?: number;
      readonly maxCache?: number;
    }
  | {
      readonly max?: number;
      readonly maxInput?: number;
      readonly maxOutput: number;
      readonly maxCache?: number;
    }
  | {
      readonly max?: number;
      readonly maxInput?: number;
      readonly maxOutput?: number;
      readonly maxCache: number;
    };

/** One bound of a {@link TokenBudget}: which class, what it measured, its cap. */
interface TokenBound {
  readonly key: "max" | "maxInput" | "maxOutput" | "maxCache";
  readonly what: string;
  readonly read: (u: UsageTrace["usage"]) => number;
}

const TOKEN_BOUNDS: readonly TokenBound[] = [
  { key: "max", what: "tokens", read: (u) => u.inputTokens + u.outputTokens },
  { key: "maxInput", what: "input tokens", read: (u) => u.inputTokens },
  { key: "maxOutput", what: "output tokens", read: (u) => u.outputTokens },
  {
    key: "maxCache",
    what: "cache tokens",
    read: (u) => u.cacheCreationTokens + u.cacheReadTokens,
  },
];

/** The run stayed inside its token budget — see {@link TokenBudget}. */
export function tokens(budget: TokenBudget): Check<UsageTrace> {
  const given = TOKEN_BOUNDS.flatMap((b) => {
    const cap = budget[b.key];
    return cap === undefined ? [] : [{ ...b, cap }];
  });
  return {
    kind: "tokens",
    eval: (t) => {
      const over = given.find((b) => b.read(t.usage) > b.cap);
      if (over !== undefined) {
        return no(
          `expected ≤ ${String(over.cap)} ${over.what}, got ${String(over.read(t.usage))}`,
        );
      }
      return ok(
        given
          .map((b) => `${String(b.read(t.usage))} ${b.what} ≤ ${String(b.cap)}`)
          .join(", "),
      );
    },
    toJSON: () => ({
      kind: "tokens",
      ...Object.fromEntries(given.map((b) => [b.key, b.cap])),
    }),
  };
}

// ---------------------------------------------------------------------------
// A subagent's railway result — the vigiles:ok / vigiles:err block a worker
// with a `result()` contract ends its turn with (src/core/agent-result.ts).
// ---------------------------------------------------------------------------

/**
 * What `check.experimental_agentResult` demands of the result block: the
 * success track, the error track, or any predicate over the parsed outcome.
 *
 * @public
 */
export type AgentResultExpectation =
  | "ok"
  | "err"
  | ((r: ParsedAgentResult) => boolean);

/**
 * `check.experimental_agentResult`: the run's output ends with a result block
 * on the expected track — `"err"` proves the worker reported failure with
 * detail (not that it crashed or returned prose), `"ok"` that it succeeded, a
 * predicate checks rich detail (`(r) => r.kind === "ok" && r.value.files.length
 * > 0`). With a `contract`, the block is validated against its shape first; a
 * block that does not match is `malformed` and fails every expectation but a
 * predicate that accepts it. Reads `output`, so inside `check.subagent(name,
 * [...])` it reads that subagent's return.
 *
 * To USE the success value, call `experimental_assertAgentOk` (`vigiles/spec`)
 * instead: it throws, so TypeScript narrows the result after it.
 *
 * @experimental It reads `experimental_agent`'s result contract, so it is no
 * more settled than that contract.
 */
function experimental_agentResult(
  expect: AgentResultExpectation,
  contract?: OutputContract,
): Check<Pick<Trace, "output">> {
  const want =
    typeof expect === "string"
      ? `an ${expect} result`
      : "a result that satisfies the predicate";
  return {
    kind: "agentResult",
    eval: (t) => {
      const r = parseAgentResult(t.output, contract);
      const detail = r.kind === "malformed" ? ` (${r.reason})` : "";
      const held = holds(expect, r);
      if (typeof held === "string")
        return no(`the agent-result predicate threw: ${held}`);
      return held
        ? ok(`the subagent returned ${want}`)
        : no(`expected ${want} from the subagent, got ${r.kind}${detail}`);
    },
    toJSON: () => ({
      kind: "agentResult",
      expect: typeof expect === "string" ? expect : "predicate",
      ...(contract !== undefined && { contract: true }),
    }),
  };
}

/** Does the parsed result meet the expectation? A predicate that throws yields its message. */
function holds(
  expect: AgentResultExpectation,
  r: ParsedAgentResult,
): boolean | string {
  if (typeof expect === "string") return r.kind === expect;
  try {
    return expect(r);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------------------------------------------------------------------------
// `check` — the vocabulary as ONE callable object
// ---------------------------------------------------------------------------

/**
 * The check vocabulary as one object: call it for a named custom check, reach
 * every built-in one as a member.
 *
 * ```ts
 * import { check, assertChecks } from "vigiles";
 *
 * assertChecks(trace, [
 *   check.tool("Read"),
 *   check.tool("Write", { max: 1 }),            // a bound: at most one Write
 *   check.toolSequence(["Read", "Edit"]),        // in this order, gaps allowed
 *   check.runs("git push", { force: true }),     // the shell parser, any spelling
 *   check.skill("my-plugin:greet"),              // asks the harness's adapter
 *   check("every Edit follows a Read", (t) => …), // anything else, named
 * ]);
 * ```
 *
 * One form for every assertion: each member is data that evaluates to
 * pass/fail with an actionable message and serializes for reports, so the same
 * line asserts on one run and scores a rate across many (`measure`, `fired:`).
 * Members that also exist as plain functions (`tool`, `skill`, …) are the same
 * checks; the members accept more where noted (a RegExp name, `{ min, max }`,
 * `{ blocked }`).
 *
 * @public
 */
// eslint-disable-next-line functional/immutable-data -- a callable with members, built the way experimental_stub and experimental_agent are
export const check = Object.assign(customCheck, {
  tool: toolCheck,
  onlyTools,
  toolSequence,
  runs,
  skill,
  output,
  received,
  hook: hookFiredCheck,
  turns,
  writes,
  subagent,
  mcp,
  cost,
  latency,
  tokens,
  // what a hook or script run did beyond its decision (src/effect-checks.ts)
  delivered,
  egress,
  // a subagent's railway result block, read as a check
  experimental_agentResult,
});
