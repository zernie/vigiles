# Functional Programming Techniques for Deterministic AI Code

## Framing

LLMs are nondeterministic by construction. Temperature 0 reduces variance but does not eliminate it. The practical question is not "how do we make the model deterministic" but "how do we **shape the code the model writes** so that nondeterminism is harmless." Functional programming has spent four decades answering this exact question for a different reason (human reasoning about concurrent/parallel/distributed code), and its tools transplant cleanly.

The thesis: **pure functions with total signatures and exhaustive pattern matches are the substrate on which agents fail loudest and recover fastest.** A pure function that returns the wrong value fails a property test. A function that throws produces a stack trace in production. Agents are much better at fixing the first one.

This doc surveys the FP techniques that have shown up in the 2025–2026 literature on AI code quality, notes the specific tooling available in the TS/JS ecosystem, and proposes 10 vigiles features that operationalize them.

## Why FP is a good fit for LLM output

Three properties make FP uniquely useful here:

1. **Totality.** A pure total function is a contract: "for every input in type A, I produce exactly one value in type B." Agents that write code under that contract cannot silently skip edge cases — unhandled cases become type errors. `ts-pattern`'s exhaustiveness check is the clearest example: the compiler refuses to build until every branch is handled.

2. **Referential transparency.** `f(x) === f(x)` for all x. This is what makes property-based testing work: you can generate 10,000 random inputs and assert an invariant without worrying about order or state. arxiv 2506.18315 ("Property-Generated Solver") showed a **23–37% pass@1 improvement** on code tasks when the harness generated properties first and let the model iterate against failing counter-examples. That only works on pure code.

3. **Composition.** Small building blocks with typed connectors force the agent into a local reasoning window. It is much easier for a model to write `pipe(x, validate, normalize, save)` correctly than it is to write a 200-line function that weaves the same steps through mutable state. Railway-oriented programming (Scott Wlaschin) is the cleanest articulation: every step is `A -> Result<B, E>`, errors short-circuit, success flows down the happy path.

## The counter-evidence

arxiv 2601.02060 ("FPEval") benchmarked code generation on **purely functional languages** (Haskell, OCaml, Elm) and found LLMs perform **15–40% worse** than on Python/TS. The reason is training-distribution: there is orders of magnitude more imperative code in the training set. So pure FP languages are not the answer.

The answer is **FP-style code in mainstream languages**, specifically TypeScript. The training set is huge, the type system is expressive enough, and the ecosystem has a cluster of libraries (Effect, neverthrow, ts-pattern, fast-check, Zod) that make FP idioms first-class without forcing a paradigm shift. vigiles can bundle those libraries into enforce-preset bundles and get the benefits without the performance hit.

## Ecosystem survey (TypeScript, 2025)

| Tool                                             | What it gives you                                                                               | Relevance                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `eslint-plugin-functional`                       | `no-throw-statements`, `immutable-data`, `no-let`, `no-loop-statements`, `prefer-readonly-type` | Direct `enforce()` targets            |
| `neverthrow`                                     | `Result<T, E>` + `ResultAsync` + `.map`/`.andThen`/`.mapErr`                                    | Railway-style error handling          |
| `Effect.ts`                                      | Full effect system: `Effect<R, E, A>`, managed concurrency, resources, retries                  | Heavier but complete                  |
| `fp-ts` / `ts-results`                           | Classical Either/Option/Task                                                                    | Smaller footprint than Effect         |
| `ts-pattern`                                     | Exhaustive pattern matching via `P.infer`, `.exhaustive()`                                      | Totality on tagged unions             |
| `monocle-ts` / `optics-ts`                       | Lenses, prisms, traversals                                                                      | Immutable deep updates                |
| `zod` / `valibot` / `@effect/schema`             | Parse-don't-validate at boundaries                                                              | Purity zones need these               |
| `fast-check`                                     | Property-based testing, shrinking                                                               | Matches 2506.18315 technique          |
| `@typescript-eslint/switch-exhaustiveness-check` | Compile-time exhaustive switch                                                                  | Cheap totality win                    |
| CodeQL (Datalog) / Flux / Liquid Haskell         | Refinement / dependent types                                                                    | Out of scope for us but worth knowing |

## How this interacts with vigiles

vigiles is a spec-to-markdown compiler with a linter-cross-reference engine. It does not write code. But it decides **which rules the agent is told to follow**, and it verifies those rules against real linter config. That makes it the natural home for a curated set of FP presets: instead of forcing every team to discover `neverthrow` and configure `eslint-plugin-functional` from scratch, vigiles can ship a `pureZone()` builder that encodes the whole bundle.

Crucially, this is not reimplementing a linter. Every rule still runs in ESLint / TypeScript / ts-pattern. vigiles just decides **where** they apply, tells the agent in prose, and verifies the wiring.

## Ten vigiles ideas

### 1. FP Determinism Preset — DROPPED (just an eslint-plugin-functional wrapper, no moat)

A named bundle: `fpDeterminism()` returns an array of `enforce()` calls covering the minimum viable FP-for-agents rule set. Target:

- `functional/no-throw-statements`
- `functional/no-let`
- `functional/immutable-data`
- `functional/no-loop-statements` (allows `map`/`filter`/`reduce`)
- `@typescript-eslint/switch-exhaustiveness-check`
- `@typescript-eslint/no-floating-promises`

Users write `...fpDeterminism()` in a spec section and inherit the entire preset. Upgrading the preset upgrades every downstream spec at once.

### 2. Pure zones — NOT BUILT

Builder: `pureZone("src/core/**", { allow: ["date-fns"] })`. Compiles to a section in the target markdown saying "inside `src/core/**`, no I/O, no throws, no globals, no Date.now / Math.random / fetch / fs." Backed by `eslint-plugin-functional` + a focused ESLint override for that glob. The agent sees "you are in a pure zone" in context; the linter enforces it for real. Two-layer defense: prose for reasoning, lint for deterministic rejection.

### 3. Rule combinator API — NOT BUILT

Expose `Rule<A, B>` as a public plugin type so users can compose their own rules: `pipe(spec.rules, strengthen("no-console"), restrictGlob("src/core/**"))`. Internally this is the same data the compiler already works with; externally it turns vigiles into a spec-programming library rather than a config file. Enables `fpDeterminism()` (#1) and every other preset to be built out of the same primitives users can use.

### 4. PBT coverage check — NOT BUILT

Audit-time assertion: for every file matching `src/**/*.ts` that exports a pure function (no `Promise`, no parameter of type `unknown`, no `void` return), require a colocated `*.property.test.ts`. Dovetails directly with arxiv 2506.18315 — properties catch the failure modes tests miss, and agents iterate on property failures faster than they iterate on hand-written tests. `fast-check` already handles the runtime. vigiles just makes coverage visible.

### 5. Content-addressed compile cache — NOT BUILT

Hash every spec by its AST + transitive imports; cache the compiled markdown by that hash. Re-running `vigiles compile` on an unchanged spec becomes a no-op. Bazel-style memoization. The reason this belongs in an FP doc: it only works because the compiler is itself a pure function from spec AST to markdown. The more we lean on FP internally, the cheaper incremental work gets.

### 6. Refinement at boundaries via schema libraries — NOT BUILT

New `enforce()` target category: `zod/strict-object`, `valibot/parse-not-safeParse`, `@effect/schema/decodeUnknown`. vigiles verifies the schema library is in the project and the rule is enabled. The spec then tells the agent "all external input must be parsed via Zod before it enters a pure zone." Parse-don't-validate is the single most effective technique for containing AI-generated input handling code — it converts runtime surprises into boundary errors.

### 7. Exhaustiveness-checking preset — NOT BUILT

One-liner: `enforce("@typescript-eslint/switch-exhaustiveness-check")` + `enforce("ts-pattern/exhaustive")`. Ships as a standalone mini-preset because it is by far the highest leverage single rule: it turns every `switch` on a discriminated union into a type-level guarantee. LLMs drop cases constantly; this catches every single one at compile time, not review time.

### 8. Result/Either error handling preset — NOT BUILT

Banned: `throw`, `try/catch` outside top-level handlers, `.catch(() => null)`. Required: return types shaped `Result<T, E>` via neverthrow (or Effect.ts if the project already uses it). vigiles verifies the project has neverthrow in `package.json` and that the relevant eslint-plugin-functional rules are on. Agent sees "errors are values; use `.mapErr` to transform them." This is the single largest departure from standard TS agent output, so the preset needs to be loud in the compiled markdown — but the payoff is that error paths become testable.

### 9. Immutable-by-default preset — NOT BUILT

Bundle: `no-let`, `immutable-data`, `no-loop-statements`, `prefer-readonly-type`, plus a `check()`-equivalent that greps for `.push(`, `.splice(`, `Object.assign`, and direct array index assignment. Not every project can adopt this wholesale, which is why it ships as a separate preset applied via `pureZone()`. Inside a pure zone, the agent is forced into `[...xs, y]` and `{...obj, k: v}` — which it handles fine.

### 10. Lens recommendation detector — NOT BUILT

Audit-time scan: detect the pattern `{...a, b: {...a.b, c: {...a.b.c, d: value}}}` (spread nesting ≥ 3) and suggest switching to `monocle-ts` or `optics-ts`. Pure diagnostic — vigiles does not rewrite the code. But it does catch the single ugliest FP anti-pattern LLMs produce when asked to "update this field immutably": nested spreads that nobody can read and nobody tests. Flagging them directs the agent toward the lens library the project presumably already has.

### 11. Immutability as a security property — NOT BUILT

The 15+ defensive-copy fixes from PR #16 proved that shared mutable references are not just a style concern — they're **bypass vectors** in proof-gated systems. Every live reference the engine returned (rules, history nodes, receipts, allowWeaken Set) was a surface where a caller could mutate state without running proofs. Ship this insight as a rule: `enforce("functional/immutable-data")` in evolve.ts and proofs.ts themselves, documented with the rationale "immutability is tamper prevention, not taste." Dogfood vigiles on vigiles.

### 12. Budget-aware fitness with a cliff — NOT BUILT

The current fitness formula (`coverage × (1 - redundancy) × (1 - budgetPressure)`) penalizes ANY token growth linearly, which makes `acceptNeutral` nearly useless: adding a rule always increases tokens, always decreases fitness, always gets rejected. A better formula: `coverage × (1 - redundancy) × min(1, maxTokens / tokens)` — score is flat at 1.0 until you exceed the token budget, then drops off a cliff. This lets useful additions pass while still enforcing the hard cap. Simple change, fixes a real design bug discovered during the `proposeAll` test rewrite.

### 13. Deterministic seed for property tests in CI — NOT BUILT

`propertyTest()` in proofs.ts accepts a `seed` option, but nothing in the CI pipeline uses it. Ship a convention: `vigiles audit --pbt-seed=$GITHUB_SHA` so property-based tests are deterministic per commit (reproducible failures) but vary across commits (explore the search space over time). Combines the benefits of deterministic CI (no flakes) with the coverage of randomized testing (different inputs each push).

## Railway-oriented programming for skills

Tangent worth noting: the same Result-pipe pattern applies to vigiles's own internal surface. If every audit step, every compile step, every linter-verification step is typed as `(Input) => Result<Output, Diagnostic[]>`, the whole compiler is one `pipe()` chain from spec AST to final output. Errors collect instead of throwing; the top-level command decides whether to short-circuit or aggregate. This is how Effect.ts pipelines are structured, and it would make the compiler's own behavior under partial failure **provably** correct instead of "seems to work in tests." A good reason to adopt neverthrow internally even before we ship it as a preset.

## What we are NOT doing

- Not adopting Haskell. FPEval says no. TypeScript FP presets are the sweet spot.
- Not shipping our own `Result` type. neverthrow is a single small dependency and is already the community default.
- Not rewriting the compiler in Effect.ts. Too much churn. neverthrow + pipe is enough.
- Not building a refinement-type system. Liquid TypeScript does not exist yet and Flux is Rust-only; Zod at boundaries is 90% of the value for 5% of the cost.

## Priority

1. **#1 fpDeterminism preset** + **#7 exhaustiveness preset** — single day of work, zero new dependencies beyond what users opt into, immediate win
2. **#2 pureZone + #6 schema boundaries** — the core pair; these define where the other presets apply
3. **#4 PBT coverage check** — wires into audit, no new subsystem, matches the strongest academic signal
4. **#3 rule combinator API** — enables plugins, unlocks user-contributed presets, 1–2 days of refactor
5. **#8 Result preset + #9 immutable preset + #10 lens detector** — powerful but opinionated; ship after the first four land so adopters have the machinery to opt in surgically
6. **#5 content-addressed cache** — pure performance work; ship when compile times become a complaint

The TL;DR is: we do not need to change the compiler to get the benefit of FP for AI code. We need to ship curated rule bundles, verify them against real linters (which vigiles already does), and let `pureZone()` and `fpDeterminism()` carry the reasoning load for users.
