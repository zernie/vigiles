# FP for the Agent Harness: Railway, Effects, and Skills

## Framing

The previous FP doc (`fp-for-deterministic-ai.md`) was about the code agents **produce** — pure zones, Result types, exhaustive pattern matches in TypeScript. This doc is about the different layer: applying FP structure to the **agent harness itself** — Claude Code's skills, hooks, tool-use loop, session state. The same techniques, aimed inward instead of outward.

The starting point is the half-joke from earlier: "what about railway programming structure for skills lol". It is not a joke. The Claude Code harness already has all the ingredients for an effect system and nobody has wired them up: skills are functions, hooks are effect handlers, tool calls are suspendable effects, the session transcript is event-sourced state. Structuring them with Railway / algebraic-effect idioms would make agent behavior **composable, inspectable, and replayable** — all three things that agents today are bad at.

Claude Code is not going to adopt Effect.ts as an implementation detail. But vigiles can ship the contracts, conventions, and verification that act **as if** skills and hooks were Railway pipelines — and get most of the benefit at the spec layer without changing the harness.

## What the harness already looks like

A Claude Code turn decomposes into something like:

```
Input (user message + transcript)
  ↓
SessionStart hooks (can inject context)
  ↓
Model turn → tool call
  ↓
PreToolUse hooks (can block / rewrite)
  ↓
Tool execution
  ↓
PostToolUse hooks (can transform result / error)
  ↓
Model continues with result
  ↓
Stop hooks / output
```

Each arrow is a place a function gets called with a typed input and returns a typed output (possibly augmented with a side channel of diagnostics). That is a Railway. The harness already **is** a pipeline; the opportunity is to make the pipeline shape explicit so users can reason about it, skills can be composed, and failure paths collect instead of drop.

## Ten ideas for FP applied to the harness

### 1. Railway-typed skills — NOT BUILT

Model a skill as `Skill<Ctx> = (Ctx) => Effect<Ctx, Diagnostic>` — it takes the current session context, returns either the next context or a list of diagnostics. Two skills compose with `.andThen`:

```ts
const reviewAndFix = review.andThen(runTests).andThen(fixFailures);
```

In Scott Wlaschin's formulation this is the two-track railway: the success track carries Ctx forward, the failure track carries Diagnostic short-circuited to the end. vigiles's contribution: a **spec-level declaration** of skill shape (`skill("review", { input: ..., output: ... })`) that compiles to a SKILL.md with the pipeline documented, and an audit check that each declared skill step actually exists. Users write skills any way they like; vigiles enforces the shape at the edges.

### 2. Validation applicative for rule audits — PARTIALLY SHIPPED (audit collects all diagnostics across stages, but no formal Validation type)

Today `vigiles audit` collects problems across stages (stale refs, dead enforcements, duplicates, coverage gaps) but each stage is written imperatively and short-circuits on its own. Switch to the Validation pattern: every check returns `Validation<OK, Diagnostic[]>` and the whole audit is `checks.map(run).sequence()`, collecting **all** failures across **all** checks in one pass. Contrast with Either monad: Either short-circuits at the first error. For audits you want the opposite — run everything, collect everything. This is a one-library change (neverthrow's `Result.combineWithAllErrors`) and makes audit output dramatically more useful per invocation.

### 3. Hooks as algebraic effect handlers — NOT BUILT

Reframe Claude Code hooks as handlers for algebraic effects. Tool use in the agent becomes `perform EditFile(path, content)` — a suspension, not a side effect. The harness interprets it by running registered handlers in order (PreToolUse handlers first, then the real tool, then PostToolUse). Each handler is a pure function `Request -> Handled | Rewrite | Continue`. This is what Effect.ts `provide` does. vigiles cannot change the harness, but it **can** ship a spec-time model of hooks with the same semantics, and a linter that catches hook ordering bugs. The payoff is: you can reason about hook stacks the way you reason about middleware, not the way you reason about shell scripts.

### 4. Skill combinators: retry, fallback, parallel, race — NOT BUILT

Once skills are typed as `Skill<Ctx>`, combinators fall out:

- `retry(n, skill)` — run up to n times, return first success
- `fallback(a, b)` — if `a` fails, try `b` with the same input
- `parallel([...skills])` — fan-out/fan-in where all branches must succeed
- `race([...skills])` — first to return a Result wins, others canceled
- `timeout(ms, skill)` — bound wall-clock
- `tap(log, skill)` — pre/post instrumentation without touching the skill body

These are exactly the combinators `Effect.retry`, `Effect.orElse`, `Effect.all`, `Effect.race`, `Effect.timeout`, `Effect.tap` ship today for arbitrary computations. Porting them to skills gives users composable retry/fallback without hand-rolling control flow in bash. vigiles ships them as spec builders that compile to prose explaining the combinator in the target SKILL.md.

### 5. Event-sourced session state — PARTIALLY SHIPPED (Merkle history is event-sourced with append-only chain + verify(); no fork/replay exposed)

Treat the session transcript as an **event log**: each user message, model response, tool call, hook fire is an event. Session state at any point is `events.reduce(step, initial)`. Two properties fall out for free:

- **Replay**: re-run `reduce` from event N to reconstruct state at turn N. Debugging a weird agent decision becomes point-in-time inspection.
- **Fork**: `events.slice(0, n).concat(newEvent)` forks the session at turn n with a different branch. Lets you A/B a prompt change without losing the prefix.

This is what Redux/Elm do and what Effect's `Fiber` model does internally. The harness already persists the transcript on disk; vigiles's role is a **spec-level invariant** that every rule produces deterministic output from the same input prefix — so replays match. An audit check: "replay session X from transcript, compare final state to recorded — diverge = bug."

### 6. Lenses for settings.json — NOT BUILT

`settings.json` is the agent's config: hooks, tool permissions, env. Today editing it is read-JSON, mutate, write. That loses atomicity and composition. Optics-ts / monocle-ts lenses let you express edits as `over(settingsLens.hooks.preToolUse, prepend(newHook))(settings)` — pure function, fully composable, trivially reversible. vigiles can ship a lens-based settings editor that underlies `vigiles init --install-hooks`, guaranteeing that concurrent edits from different commands don't stomp each other. The generalization: Claude Code config is a product type, and product types are what lenses are for.

### 7. Skill type signatures in the spec — NOT BUILT

`skill("review-pr", { input: PrNumber, output: ReviewReport, may: [ReadRepo, PostComment] })`. The `may` clause is an **effect annotation**: this skill is allowed to read the repo and post comments, nothing else. Compiles to a permissions section in SKILL.md that Claude Code can parse at invocation time, and a PreToolUse hook that blocks anything outside the declared effect set. This is how Koka / Eff / Frank handle effect rows at the type level; porting it down to skill metadata means the harness can enforce effect bounds **per skill** instead of per-session globally.

### 8. Kleisli composition and `>=>` — NOT BUILT

If skills are `A -> Effect<B>`, the operator to compose them is **Kleisli composition** (`>=>` in Haskell, `>>` in PureScript): `(f >=> g) = \a -> f(a).andThen(g)`. This is just function composition in the Effect category. Why it matters for vigiles: if the spec lets you write `pipeline("ship-pr", review >=> fix >=> push)`, the compiler can statically check that the output type of `review` matches the input type of `fix`. Type-safe multi-skill workflows. Today these workflows are written as bash or as prose instructions that the agent interprets; Kleisli composition makes them **compile-time verifiable graphs**.

### 9. Reader monad for shared context — NOT BUILT

Every hook and skill gets the same `{cwd, env, transcript, user, project}` passed in. That is the Reader monad: `Reader<Env, A> = (Env) -> A`. The payoff: `Reader.ask` lets a deeply nested combinator access the environment without threading it through every intermediate function, and `local(f, reader)` lets a combinator run its body with a **locally modified** environment without mutating the real one. For hooks this means you can write a hook that scopes `cwd` to a subdirectory for its inner work and transparently restores it afterward. vigiles can declare Reader-shaped context in the spec and verify every hook/skill's signature conforms.

### 10. Pure replay harness for hook testing — NOT BUILT

Today, testing a hook means setting up a real Claude Code session, triggering the tool, and reading the output. That is slow and flaky. If hooks are pure functions of `(Request, Env) -> Response`, you can **unit test** them with `fast-check` — generate random requests, assert invariants like "PreToolUse never returns both Allow and Rewrite" or "PostToolUse output is either the original result or a Result value, never undefined." vigiles ships a `vigiles test-hooks` subcommand that loads `settings.json`, extracts each hook as a pure function, and runs property tests against it. Catches the silent-matcher-ignore and trailing-wildcard anti-patterns from the agent-integration doc with **100% coverage** because the property test tries every shape.

## Why Railway, specifically, for skills

Scott Wlaschin's railway pattern has one killer property: **errors and happy path have the same shape.** Both are `Result<T, E>`. Both flow through the same pipeline. The skill author writes code as if nothing can fail; the combinators handle the failure plumbing. Agents are spectacularly bad at writing correct error handling — they `try { ... } catch (e) { console.log(e); }` and move on. Railway removes the temptation entirely: there is no `try` to write because there is no `throw`. The skill returns `Result.err(Diagnostic.MissingFile(path))` and the caller either keeps going or bails at the boundary.

Concretely for a skill like "review a PR":

```ts
const reviewPr: Skill<PrCtx> = (ctx) =>
  fetchPr(ctx.prNumber)
    .andThen(loadDiff)
    .andThen(checkStyle)
    .andThen(runAudit)
    .andThen(postComment)
    .mapErr((diagnostic) => ({
      ...ctx,
      diagnostics: [...ctx.diagnostics, diagnostic],
    }));
```

Every step can fail. The failure type is the same for all of them. The success path reads top-to-bottom with no `if` branches. A model looking at this pipeline can extend it (`checkSecrets.andThen(postComment)`) by adding one line. A model looking at the try/catch equivalent has to find the right `catch` block, decide if the new step needs its own, and often forgets. Railway is not just nice for humans — it is **easier for agents to modify correctly** than nested try/catch, which is the whole point.

## What vigiles actually ships

None of the above asks Claude Code's harness to change. vigiles's leverage is the **spec layer**:

- `skill(name, { input, output, may, steps })` builder in `src/spec.ts`
- Compiles to a SKILL.md documenting the pipeline, effect set, and failure modes
- Audit check that every step referenced actually exists as a file or subskill
- Optional: a tiny runtime wrapper (`@vigiles/skill`) that provides the neverthrow-based `Skill<Ctx>` type and combinators, so users who want to adopt the pattern in their own tooling can import a shared definition
- Hook validation subcommand (`vigiles audit --hooks`) that treats hooks as pure functions and property-tests them

The runtime wrapper is optional. The spec layer is the thing. Everything else is documentation of the pattern with a compile-time check that the documentation matches reality.

### 11. Adversarial differential replay — NOT BUILT

Record the Merkle chain from a session (every mutation + proof receipt). Replay the same sequence through a different LLM (or different temperature) and compare: which mutations does each accept/reject? Divergence = the mutation is model-sensitive, which means the proof suite isn't strict enough (the deterministic gate should have caught it). This is differential testing applied to agent behavior, and the Merkle chain is already the exact replay log it needs.

### 12. Audit stage as a composable functor — NOT BUILT

Each audit stage today is an imperative function that mutates `silent` state and accumulates counters. Make each stage a pure `(AuditReport) → AuditReport` transformation. Stages compose via plain function composition. The `silent`/`loud` threading becomes a Reader effect; the counter accumulation is just field merges. Users could define custom audit pipelines in their spec: `auditStages: [verifyHashes, inlineRules, coverage]` — pick what runs, skip what doesn't apply.

### 13. Hook contract testing via fast-check — NOT BUILT

Treat each Claude Code hook (PreToolUse, PostToolUse, SessionStart) as a pure function of `(Request, Env) → Response` and property-test it with fast-check: generate random tool-use requests, assert invariants like "PreToolUse never returns both Allow and Block" or "PostToolUse output is always valid JSON." The existing hook scripts are bash, so the "function" is actually `echo $INPUT | bash hook.sh | read $OUTPUT` — property testing over that subprocess boundary catches the silent-matcher-ignore and trailing-wildcard anti-patterns from the agent-integration doc with machine coverage instead of manual audit.

## Priority

1. **`skill()` builder with typed input/output** — the smallest change, unblocks everything else. Write the builder, compile it to the existing SKILL.md format, audit for missing referenced files.
2. **Validation applicative for audit** — one-library refactor, immediate UX win ("audit reports 7 issues" instead of "audit failed at issue 1").
3. **Skill combinators as spec builders** — `retry()`, `fallback()`, `parallel()` that compile to prose. No runtime required, just better SKILL.md output.
4. **Hook property testing** — depends on having a spec model of hooks first, then layering fast-check.
5. **Effect annotations + lens-based settings editor** — the sharpest tools but the most design work. Ship last.

The short version: the previous FP doc was about TS code patterns for LLM output. This one is about applying the same shapes **one level up** to the agent runtime. Railway for skills is not a joke — it is the only way to compose agent pipelines that both humans and models can edit safely.
