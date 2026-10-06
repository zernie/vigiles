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
import { judge as runJudge } from "./judge.js";
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

/** The outcome of evaluating one check against one result. */
export interface CheckResult {
  /** Did the check hold? */
  readonly pass: boolean;
  /** 0..1 — `pass ? 1 : 0` for a boolean check; a fraction for graded ones. */
  readonly score: number;
  /** A human message: confirming on pass, actionable on failure. */
  readonly message: string;
}

/** A check's serialized form (for JSON/JUnit output and the promptfoo bridge). */
export interface CheckJSON {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/** A declarative check over a result of type `T` ({@link Trace} or {@link HookRunResult}). */
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

// ---------------------------------------------------------------------------
// Trace checks (an agent run — runHarness / runEval)
// ---------------------------------------------------------------------------

/** The agent invoked a tool by this name (regardless of result). */
export function tool(name: string): Check<Trace> {
  return {
    kind: "tool",
    eval: (t) =>
      t.toolCalls.some((c) => c.name === name)
        ? ok(`agent used tool "${name}"`)
        : no(
            `expected the agent to use tool "${name}", but it used ${distinctToolNames(t.toolCalls)}`,
          ),
    toJSON: () => ({ kind: "tool", name }),
  };
}

/**
 * The agent used tool `name` with at least one call whose `input` matches `args`
 * — the **argument** half of the tool-call spy. Asserts not just *that* a tool was
 * reached but *how* it was called (the image-request body carried the style suffix,
 * the panel spawn requested a non-expert), which a completion grader can't see.
 *
 * Cross-reference: ≈ promptfoo `is-valid-function-call` / DeepEval `ToolCorrectnessMetric`.
 */
export function toolWith(name: string, args: ArgMatcher): Check<Trace> {
  return {
    kind: "toolWith",
    eval: (t) => {
      const calls = t.toolCalls.filter((c) => c.name === name);
      const want = describeArgs(args);
      if (calls.length === 0) {
        return no(
          `expected the agent to use tool "${name}" (with ${want}), but it used ${distinctToolNames(t.toolCalls)}`,
        );
      }
      return calls.some((c) => matchesArgs(c.input, args))
        ? ok(`agent used "${name}" with ${want}`)
        : no(
            `agent used "${name}" but never with ${want} (saw ${calls
              .map((c) => truncate(stringifyValue(c.input), 60))
              .join("; ")})`,
          );
    },
    toJSON: () => ({ kind: "toolWith", name, args: serializeArgs(args) }),
  };
}

/**
 * The agent did NOT use tool `name` — the **safety / negative** assertion. With
 * `args`, only calls whose `input` matches are forbidden (so "did not push to
 * `main`" still allows pushing elsewhere; "no paid API call" forbids it outright).
 * This is the highest-value, most-overlooked check, and the one a
 * completion-grading eval structurally cannot make: it sees the agent's *decision*
 * to act, not just its final text.
 *
 * Cross-reference: this negative/safety assertion of a *decision not to act* has
 * no promptfoo / DeepEval / Inspect equivalent — they grade what the agent DID,
 * not what it correctly refrained from doing.
 */
export function notTool(name: string, args?: ArgMatcher): Check<Trace> {
  return {
    kind: "notTool",
    eval: (t) => {
      const calls = t.toolCalls.filter((c) => c.name === name);
      const offending = args
        ? calls.filter((c) => matchesArgs(c.input, args))
        : calls;
      const what = args ? `"${name}" with ${describeArgs(args)}` : `"${name}"`;
      const first = offending[0];
      if (!first) return ok(`agent never used ${what}`);
      return no(
        `expected the agent NOT to use ${what}, but it did (${truncate(stringifyValue(first.input), 60)})`,
      );
    },
    toJSON: () =>
      args
        ? { kind: "notTool", name, args: serializeArgs(args) }
        : { kind: "notTool", name },
  };
}

/**
 * The agent used **only** tools drawn from `allowed` — the white-list, and the
 * missing half of a symmetry the file surface already has:
 *
 * |       | "not this one"  | "nothing but these"    |
 * | ----- | --------------- | ---------------------- |
 * | files | `assertNoWrite` | `assertWroteOnly`      |
 * | tools | {@link notTool} | **`onlyTools`** (this) |
 *
 * Why the asymmetry mattered: `notTool` can only forbid the calls the test
 * author thought of, and the set of undeclared tools is unbounded — so "this
 * skill stayed inside the tools it declares" was not expressible, which is
 * exactly the claim a `SKILL.md` frontmatter makes in prose. See
 * `skillContract`, which builds this check from that declaration.
 *
 * **Fails closed on an empty trace.** A `Trace` records tool calls only when the
 * run captured the stream (`transcript: true` on the harness tier; always on the
 * eval tier), so an uncaptured run is indistinguishable from a tool-free one —
 * and passing it would assert nothing. Same discipline as `assertWroteOnly`
 * refusing a result that never recorded writes: "we didn't look" is not "it was
 * clean".
 *
 * 🔴 A `Tool(restriction)` DECLARATION IS MATCHED BY ITS BASE NAME. `allowed-tools:
 * Bash(git:*)` is the ordinary way to write a narrow grant, and `skillContract`
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
 * `skillContract` therefore does NOT use this directly: it wraps it in a window
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

/** A skill resolved to this id (`<plugin>:<skill>`) without erroring. */
export function skill(id: string): Check<Trace> {
  return {
    kind: "skill",
    eval: (t) => {
      const call = t.toolCalls.find(
        (c) =>
          c.name === "Skill" && (c.input as { skill?: string })?.skill === id,
      );
      if (call && !call.isError) return ok(`skill "${id}" resolved`);
      const skills = t.toolCalls
        .filter((c) => c.name === "Skill")
        .map((c) => (c.input as { skill?: string })?.skill ?? "?");
      return no(
        `expected skill "${id}" to resolve; it did not (skills invoked: ${skills.length > 0 ? `[${skills.join(", ")}]` : "none"})`,
      );
    },
    toJSON: () => ({ kind: "skill", id }),
  };
}

/** The agent's final output contains a substring / matches a RegExp. */
export function output(matcher: string | RegExp): Check<Trace> {
  const isRe = matcher instanceof RegExp;
  return {
    kind: "output",
    eval: (t) => {
      const pass = isRe ? matcher.test(t.output) : t.output.includes(matcher);
      return pass
        ? ok(`output matched ${String(matcher)}`)
        : no(
            `expected output to ${isRe ? "match" : "contain"} ${String(matcher)}; got "${truncate(t.output) || "(empty)"}"`,
          );
    },
    toJSON: () => ({ kind: "output", matcher: String(matcher), regex: isRe }),
  };
}

/** A matcher as the report prints it: the string, or the RegExp literal. */
const show = (matcher: string | Readonly<RegExp>): string =>
  typeof matcher === "string" ? matcher : `/${matcher.source}/${matcher.flags}`;

const matches = (matcher: string | Readonly<RegExp>, text: string): boolean =>
  typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);

/** Why a reply check cannot run: the trace carries no replies to read. */
const NO_REPLIES =
  "the run has no `replies` (the harness does not tell replies apart, or the run was not streamed — pass `transcript: true`)";

/**
 * EVERY reply of the run contains a substring / matches a RegExp — for a rule
 * about each reply ("end with a status block"), where `output` sees only the
 * last one. A run with no replies fails: there is nothing the rule held for.
 */
export function eachReply(
  matcher: string | Readonly<RegExp>,
): Readonly<Check<Trace>> {
  return {
    kind: "eachReply",
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
      kind: "eachReply",
      matcher: show(matcher),
      regex: typeof matcher !== "string",
    }),
  };
}

/**
 * How many replies of the run match, within bounds — `{ max: 1 }` is "at most
 * one status block for one user message", which a Stop hook that makes the
 * agent reply again can break while `output` still shows one.
 */
export function replyCount(
  matcher: string | Readonly<RegExp>,
  opts: { readonly min?: number; readonly max?: number },
): Readonly<Check<Trace>> {
  return {
    kind: "replyCount",
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
      kind: "replyCount",
      matcher: show(matcher),
      regex: typeof matcher !== "string",
      min: opts.min,
      max: opts.max,
    }),
  };
}

/** A hook fired for this event (e.g. `"PreToolUse"`, `"Stop"`). */
export function hookFired(event: string): Check<Trace> {
  return {
    kind: "hookFired",
    eval: (t) => {
      const fired = t.hooks.filter((h: HookFire) => h.event === event);
      return fired.length > 0
        ? ok(`hook fired for ${event}`)
        : no(
            `expected a hook to fire for ${event}; hooks that fired: ${t.hooks.length > 0 ? `[${[...new Set(t.hooks.map((h) => h.event))].join(", ")}]` : "none"}`,
          );
    },
    toJSON: () => ({ kind: "hookFired", event }),
  };
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
      const pass = isRe ? matcher.test(text) : text.includes(matcher);
      return pass
        ? ok(`the model received ${String(matcher)}`)
        : no(
            `expected the model to receive ${String(matcher)} (a slash-command expansion or injected context); ${t.modelRequests.length === 0 ? "no requests captured (eval tier captures none — use runHarness)" : `got "${truncate(text)}"`}`,
          );
    },
    toJSON: () => ({ kind: "received", matcher: String(matcher), regex: isRe }),
  };
}

/**
 * The agent took a number of model turns in range — a **multi-turn** observable
 * (`{ min: 2 }` asserts a back-and-forth happened, not a one-shot answer; `{ max }`
 * caps runaway loops). The deterministic harness scripts the model turns; this
 * checks how many the agent actually took.
 */
export function turns(opts: { min?: number; max?: number }): Check<Trace> {
  return {
    kind: "turns",
    eval: (t) => {
      const n = t.turns;
      const pass =
        (opts.min === undefined || n >= opts.min) &&
        (opts.max === undefined || n <= opts.max);
      const bound = [
        opts.min !== undefined ? `≥ ${String(opts.min)}` : null,
        opts.max !== undefined ? `≤ ${String(opts.max)}` : null,
      ]
        .filter((x): x is string => x !== null)
        .join(" and ");
      return pass
        ? ok(`${String(n)} turn(s) (${bound || "any"})`)
        : no(`expected ${bound || "any"} turn(s), got ${String(n)}`);
    },
    toJSON: () => ({ kind: "turns", min: opts.min, max: opts.max }),
  };
}

/** The agent wrote (or left) a file at this path in the work dir. */
export function wrote(path: string): Check<Trace> {
  return {
    kind: "wrote",
    eval: (t) =>
      t.file(path) !== null
        ? ok(`file "${path}" exists`)
        : no(`expected the agent to create "${path}", but it does not exist`),
    toJSON: () => ({ kind: "wrote", path }),
  };
}

/**
 * The agent did NOT leave a file at this path — the **side-effect boundary**
 * negative: a skill that declares it writes only `out.txt` should leave nothing
 * at `secrets.env`. The symmetric sibling of `wrote()`; pairs with
 * `notTool(...)` to assert a unit stayed inside its declared write surface
 * deterministically (no model judge).
 */
export function didNotWrite(path: string): Check<Trace> {
  return {
    kind: "didNotWrite",
    eval: (t) =>
      t.file(path) === null
        ? ok(`file "${path}" was not created`)
        : no(`expected the agent NOT to create "${path}", but it exists`),
    toJSON: () => ({ kind: "didNotWrite", path }),
  };
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
// Hook-decision checks (a single hook — runHook)
// ---------------------------------------------------------------------------

/** The hook blocked the event (exit 2 / deny / block). */
export function blocked(): Check<HookRunResult> {
  return {
    kind: "blocked",
    eval: (r) =>
      r.blocked
        ? ok("hook blocked the event")
        : no(
            `expected the hook to block, but it allowed (exit ${String(r.exitCode)})`,
          ),
    toJSON: () => ({ kind: "blocked" }),
  };
}

/** The hook allowed the event through. */
export function allowed(): Check<HookRunResult> {
  return {
    kind: "allowed",
    eval: (r) =>
      r.blocked
        ? no(
            `expected the hook to allow, but it blocked (exit ${String(r.exitCode)})`,
          )
        : ok("hook allowed the event"),
    toJSON: () => ({ kind: "allowed" }),
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

/** A model-graded judge: grades `output` against a `rubric` → score in [0,1]. */
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

/** The run used at most `max` total (input + output) tokens. */
export function tokens(opts: { max: number }): Check<UsageTrace> {
  return {
    kind: "tokens",
    eval: (t) => {
      const v = t.usage.inputTokens + t.usage.outputTokens;
      return v <= opts.max
        ? ok(`${String(v)} tokens ≤ ${String(opts.max)}`)
        : no(`expected ≤ ${String(opts.max)} tokens, got ${String(v)}`);
    },
    toJSON: () => ({ kind: "tokens", max: opts.max }),
  };
}

/**
 * The run used at most `max` **fresh (uncached) input** tokens. The honest input
 * side of a cost claim: a skill or CLAUDE.md injection adds input every turn, so
 * a "compression" win on output can be erased here. (Cache reads are separate —
 * see `cacheTokens`.)
 */
export function inputTokens(opts: { max: number }): Check<UsageTrace> {
  return {
    kind: "inputTokens",
    eval: (t) => {
      const v = t.usage.inputTokens;
      return v <= opts.max
        ? ok(`${String(v)} input tokens ≤ ${String(opts.max)}`)
        : no(`expected ≤ ${String(opts.max)} input tokens, got ${String(v)}`);
    },
    toJSON: () => ({ kind: "inputTokens", max: opts.max }),
  };
}

/** The run used at most `max` **output** tokens — the generation side. */
export function outputTokens(opts: { max: number }): Check<UsageTrace> {
  return {
    kind: "outputTokens",
    eval: (t) => {
      const v = t.usage.outputTokens;
      return v <= opts.max
        ? ok(`${String(v)} output tokens ≤ ${String(opts.max)}`)
        : no(`expected ≤ ${String(opts.max)} output tokens, got ${String(v)}`);
    },
    toJSON: () => ({ kind: "outputTokens", max: opts.max }),
  };
}

/**
 * Bound the prompt-cache token classes a run uses. `maxCreation` caps tokens
 * **written** to the cache (the ~1.25× write premium — a fresh/cold prompt);
 * `maxRead` caps tokens **served** from cache (~0.1× input). Each constraint is
 * checked only when provided; the check passes when every provided bound holds.
 */
export function cacheTokens(opts: {
  maxCreation?: number;
  maxRead?: number;
}): Check<UsageTrace> {
  return {
    kind: "cacheTokens",
    eval: (t) => {
      const created = t.usage.cacheCreationTokens;
      const read = t.usage.cacheReadTokens;
      if (opts.maxCreation !== undefined && created > opts.maxCreation) {
        return no(
          `expected ≤ ${String(opts.maxCreation)} cache-creation tokens, got ${String(created)}`,
        );
      }
      if (opts.maxRead !== undefined && read > opts.maxRead) {
        return no(
          `expected ≤ ${String(opts.maxRead)} cache-read tokens, got ${String(read)}`,
        );
      }
      return ok(
        `cache tokens within bounds (created ${String(created)}, read ${String(read)})`,
      );
    },
    toJSON: () => ({
      kind: "cacheTokens",
      ...(opts.maxCreation !== undefined && { maxCreation: opts.maxCreation }),
      ...(opts.maxRead !== undefined && { maxRead: opts.maxRead }),
    }),
  };
}
