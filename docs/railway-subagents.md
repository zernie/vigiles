# Railway-oriented subagents — typed outcomes you can assert

> The README has the pitch; this is the full guide. A **subagent** is the one
> agent primitive with a real boundary — it runs in its own context and **returns**
> a result to the orchestrator. vigiles lets you type that return as a
> `Result<ok, err>`, so the orchestrator's control flow is **deterministic** and a
> test **asserts** the outcome instead of paying an LLM to judge prose.
>
> Where this fits the testing tiers: [`harness-testing.md`](harness-testing.md).

> **One import, one root.** Everything on this page hangs off `experimental_agent`:
> `.result()`, `.railway()`, `.delegate()`, `.pipe()`, `.pipeStep()`, `.needs()`,
> `.start()`, `.andThen()`. They are members rather than top-level exports because
> each is meaningless without a subagent, and because `result`/`needs`/`start`/`pipe`
> are far too generic to own a package-level name. Destructure them if you prefer the
> short spelling — `const { result, railway, delegate } = experimental_agent;` — the
> examples below do exactly that. See [STABILITY.md](../STABILITY.md#the-corollary-one-experimental-root-per-feature).

## Contents

- [Why railway, for subagents](#why-railway-for-subagents)
- [Declare a typed outcome](#declare-a-typed-outcome)
- [What it compiles to](#what-it-compiles-to)
- [Compose flat workers](#compose-flat-workers)
- [Typed composition — handoffs that must line up](#typed-composition--handoffs-that-must-line-up)
  - [Cross-file handoffs — the whole-harness registry](#cross-file-handoffs--the-whole-harness-registry)
- [Test the outcome deterministically](#test-the-outcome-deterministically)
- [Scope: subagents, not skills](#scope-subagents-not-skills)
- [See also](#see-also)

## Why railway, for subagents

A subagent does probabilistic work, but the orchestrator's question is binary:
**did it succeed, with the right result?** Normally that's a job for an LLM judge —
slow, metered, non-deterministic. A **typed Result contract** turns it into a
deterministic assert:

- The subagent finishes its turn with a typed block — `vigiles:ok` on the success
  track, `vigiles:err` on the error track.
- The orchestrator (or a test) **parses** that block into a discriminated union and
  knows, deterministically, which track it's on.

This is Scott Wlaschin's railway-oriented programming with a subagent as the step:
the agent's **work** stays probabilistic, its **control flow** becomes
deterministic. It also makes invalid states unrepresentable — "succeeded _and_
errored" and "ran past a failure unhandled" can't occur, because the outcome is one
typed value on one track.

## Declare a typed outcome

`result(okShape, errShape)` types the two tracks; attach it to an `agent()` as its
`output`. Field types are `"string" | "number" | "boolean" | "string[]"`.

```ts
import { experimental_agent, file, prose } from "vigiles/spec";
const { result } = experimental_agent;

export default experimental_agent({
  name: "implementer",
  description: "Implement the planned change and report what it touched.",
  tools: ["Read", "Edit", "Bash"],
  output: result(
    { files: "string[]", summary: "string" }, // success — rich detail
    { reason: "string", step: "string" }, // error — structured, not a bare bit
  ),
  body: prose`
    Implement the change described in the task. When done, finish your turn with
    the vigiles:ok block listing the files you changed; if you cannot, emit
    vigiles:err with the reason. See ${file("docs/spec-format.md")}.
  `,
});
```

## What it compiles to

`vigiles compile` renders the contract into the subagent's system prompt as an
`## Output contract` section — the literal blocks the worker must end its turn with:

````md
## Output contract

Finish your turn with exactly one fenced block — success or error.

On success:

```vigiles:ok
{ "files": string[], "summary": string }
```

On error:

```vigiles:err
{ "reason": string, "step": string }
```
````

The compiled markdown is the single source of truth; the integrity hash covers it,
so a hand-edit is detected.

## Compose flat workers

`railway()` sequences flat subagents into a success track with a bounded error
track — no loop combinator, so it always terminates and every `delegate()` target
is resolved against the real agent specs at compile time.

```ts
import { experimental_agent } from "vigiles/spec";
const { railway, delegate } = experimental_agent;

export default railway({
  name: "ship-pr",
  steps: [
    delegate("planner", "Plan the change"),
    delegate("implementer"),
    delegate("reviewer"),
  ],
  // bounded recovery: retry the failing step via a fixer, finitely
  recover: { step: delegate("fixer"), max: 2 },
  // exhausted failure routes to the error track
  onError: delegate("reporter"),
});
```

The success track flows worker → worker; the first `vigiles:err` short-circuits to
`recover` (up to `max` times), and an exhausted failure routes to `onError`. The
whole thing is a finite tree — termination is readable off the value, the thing an
ultra-plan's generated script can't guarantee. See the runnable dogfood:
[`examples/railway/ship-pr.md.spec.ts`](../examples/railway/ship-pr.md.spec.ts).

`railway()` + `delegate("name")` resolve each step **by name** against the sibling
agent specs at compile time — a value-level cross-reference. It checks that every
delegate target is a real agent, the steps are non-empty, and recovery is bounded.
What it **cannot** see is the **data handoff**: a string name carries no type, so a
producer's `result()` shape is invisible to the consumer. That's what typed
composition adds.

## Typed composition — handoffs that must line up

> **Your multi-agent pipeline doesn't compile if the handoffs don't line up.**

`agent()` now **remembers** its `result()` shape at the type level. So a second,
typed composition surface — `experimental_pipe(...)` (or the `experimental_start` / `experimental_andThen` fold) over the
agent **objects** — checks at `tsc` time that **step N's `ok` output supplies step
N+1's declared `experimental_needs`**. A missing field, a wrong field type, or an out-of-order
step is a **compile error** at the mismatched step, naming the offending field. No
markdown or YAML railway can do this; it is a cross-reference only types can carry.

Each consumer declares the fields it reads from its predecessor with `experimental_needs(...)`,
paired to its agent via `experimental_pipeStep(agent, experimental_needs(...))`:

<!-- vigiles:check -->

```ts
import { experimental_agent } from "vigiles/spec";
const {
  result,
  pipe: experimental_pipe,
  pipeStep: experimental_pipeStep,
  needs: experimental_needs,
} = experimental_agent;

const planner = experimental_agent({
  name: "planner",
  description: "Plan the change.",
  output: result({ plan: "string", files: "string[]" }, { reason: "string" }),
});

const implementer = experimental_agent({
  name: "implementer",
  description: "Implement the plan.",
  output: result(
    { diff: "string", touched: "string[]" },
    { reason: "string", retryable: "boolean" },
  ),
});

const reviewer = experimental_agent({
  name: "reviewer",
  description: "Review the diff.",
  output: result({ approved: "boolean" }, { reason: "string" }),
});

// COMPILES — planner.ok ⊇ implementer.needs, implementer.ok ⊇ reviewer.needs.
export const shipPr = experimental_pipe(
  planner,
  experimental_pipeStep(
    implementer,
    experimental_needs({ plan: "string", files: "string[]" }),
  ),
  experimental_pipeStep(reviewer, experimental_needs({ diff: "string" })),
);
```

These three each **fail `tsc`** — the bug is caught at edit time, not at runtime:

```ts
// MISSING FIELD — nobody upstream produces `securityScan`.
experimental_pipe(
  planner,
  experimental_pipeStep(
    implementer,
    experimental_needs({ plan: "string", files: "string[]" }),
  ),
  experimental_pipeStep(
    reviewer,
    experimental_needs({ securityScan: "string" }),
  ), // ✗ won't compile
);

// TYPE MISMATCH — implementer produces diff:"string", reviewer needs diff:"string[]".
experimental_pipe(
  planner,
  experimental_pipeStep(
    implementer,
    experimental_needs({ plan: "string", files: "string[]" }),
  ),
  experimental_pipeStep(reviewer, experimental_needs({ diff: "string[]" })), // ✗ won't compile
);

// ORDER ERROR — reviewer before implementer never sees `diff`.
experimental_pipe(
  planner,
  experimental_pipeStep(reviewer, experimental_needs({ diff: "string" })), // ✗ won't compile
);
```

**Which surface gives the type check — and which still works.** Typed composition
(`experimental_pipe` / `experimental_start` / `experimental_andThen` over agent **objects**) is the **additive** path that
checks data handoffs. The string-based `railway({ steps: [delegate("name")] })`
path is **unchanged** and still works exactly as before — it's the name-resolution
backstop (`validateRailway` / `compileRailway`), and it's what compiles to the
orchestrator command today. A typed `experimental_pipe`/`Pipeline` carries an underlying
`railway` (`pipeline.railway`) for that compile step, so you get both: the
edit-time handoff check **and** the compiled orchestrator. Keep typed chains to a
handful of steps (deep type recursion is avoided by design — the handoff check is
shallow, one field-level pass per step); for longer pipelines, fold `experimental_andThen`
explicitly or fall back to the string `railway`.

The type-level proof (a correct pipeline + the three `@ts-expect-error` failures):
[`test/types/composition.ts`](../test/types/composition.ts).

### Cross-file handoffs — the whole-harness registry

`experimental_pipe(...)` checks handoffs **within one file** (the agent objects are in scope).
When each agent lives in its **own** `*.spec.ts` and a `railway()` composes them by
**name**, the same check is lifted to the **whole-harness registry** that
[`vigiles generate harness`](cli.md#generate-harness-dir-out) emits — so a
**cross-file** handoff mismatch is a `tsc` error too.

Declare the handoff with the optional 3rd argument of `delegate()` — the same
`experimental_needs(...)` builder `experimental_pipeStep` uses. The registry then asserts the **previous**
success-track step's agent `result().ok` SUPPLIES it:

```ts
import { experimental_agent } from "vigiles/spec";
const { railway, delegate, needs: experimental_needs } = experimental_agent;

// agents/planner.md.spec.ts emits result({ steps: "string[]" }, …)
// agents/implementer.md.spec.ts emits result({ files: "string[]" }, …)
export default railway({
  name: "ship-pr",
  steps: [
    delegate("planner"),
    delegate(
      "implementer",
      undefined,
      experimental_needs({ steps: "string[]" }),
    ), // planner.ok ⊇ { steps }
    delegate("reviewer", undefined, experimental_needs({ summary: "string" })), // implementer.ok ⊇ { summary }
  ],
});
```

Run `vigiles generate harness` over the agents directory; the generated
`harness.gen.ts` carries one shallow per-pair assertion
(`Handoff<OkOf<typeof registry["planner"]>, { steps: "string[]" }>`). If the
producer's `ok` is missing the field or has the wrong type, `tsc` rejects the gen
file naming it (`__handoff_error: { __missing: "steps" }` /
`{ __mismatch: "steps", expected: …, got: … }`) — **no vigiles run, across files,
in your editor**. The check is **opt-in per edge**: a `delegate()` with no `experimental_needs`
generates and behaves exactly as before. It's scoped to the **linear success
track** for now — `recover`/`onError` edges consume an `err`, not the prior `ok`,
so they're a noted follow-up. Worked dogfood:
[`examples/railway/ship-pr.md.spec.ts`](../examples/railway/ship-pr.md.spec.ts).

## Test the outcome deterministically

This is the payoff: a `result()` contract replaces
`paid_judged("did the worker succeed?")` with a **parse + assert** — no model,
no key.

```ts
import {
  experimental_agent,
  experimental_assertAgentOk,
  experimental_assertAgentErr,
  experimental_assertAgentResult,
} from "vigiles/spec";
const { result } = experimental_agent;

const implementer = result(
  { files: "string[]", summary: "string" },
  { reason: "string", step: "string" },
);

// r.output is the subagent's final text (a runHarnessTest turn, a Task sub-trace, or
// recorded output). Assert the OUTCOME, not prose:
const ok = experimental_assertAgentOk(r.output, implementer); // throws unless it's a valid ok block
assert.deepEqual(ok.files, ["src/parser.ts"]);

// Rich predicate over either track, still model-free:
experimental_assertAgentResult(
  r.output,
  (res) =>
    res.kind === "ok" && res.value.files.some((f) => f.endsWith(".test.ts")),
  implementer,
);
```

A worker that emits the wrong shape, or prose instead of a block, parses as
`malformed` — the honest third track, caught, never a silent pass. The parse is
pure (`text → Result<S, E>`), so most of this runs with **no model and no key**.
Full worked example (Part A pure, Part B a real scripted-mock turn):
[`examples/harness/railway-result.harness.mjs`](../examples/harness/railway-result.harness.mjs).

## Scope: subagents, not skills

Railway/Result is a **subagent** contract by design — not a skill one. A subagent
has a discrete call → isolated context → **return**, and that return is the
parse-point the contract asserts on. A **skill** runs inline in the main
conversation and never "returns" a value, so a typed outcome there is a category
error (for a knowledge skill) or has no parse-point (for a procedural one). The
bridge for a procedural skill that genuinely needs a typed outcome is Anthropic's
`context: fork` — it runs the skill as a forked subagent, at which point the
**subagent** contract applies. That bridge is modelled: a `skill()` may set
`context: "fork"` and carry an `output: result(...)`, and the **same** Output
contract renders. The gate is enforced at compile — an `output` without
`context: "fork"` is an error, because an inline skill has no return to type:

```ts
import { experimental_agent, experimental_skill } from "vigiles/spec";
const { result } = experimental_agent;

export default experimental_skill({
  name: "review",
  description: "Review a file and return structured findings.",
  context: "fork", // runs as a subagent → has a return boundary
  output: result(
    { defects: "string[]", summary: "string" },
    { reason: "string" },
  ),
  body: "Review the file under review and report defects.",
});
```

## See also

- [`harness-testing.md`](harness-testing.md) — the testing tiers; the
  "assert a subagent's typed outcome" section sits in the same family.
- [`spec-format.md`](spec-format.md) — the spec format reference (targets,
  sections, rules, reference helpers).
