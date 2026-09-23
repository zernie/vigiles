# Stability

> vigiles's **major version is high and still climbing** — read that as _"still
> moving fast,"_ not _"battle-hardened."_ `semantic-release` cuts a **new major on
> every breaking API change**, and there have been a lot of them. The number is an
> artifact of how it ships, not a claim of maturity, so this page names no version:
> the badge on the README is always the current one. What follows is what I try
> hardest not to break, and what's still in motion.

The steadiest contract is the **CLI** — the commands you run, their flags, and
their exit codes. Most of the churn is in the library API underneath it.

## What's stable — depend on it

- **The CLI** — the verbs (`init`, `compile`, `eject`, `lint`, `test`, `eval`,
  `audit`, `generate`), their flags, and their **exit codes**
  (`0` clean / `1` warn / `2` error). This is the narrowest, steadiest contract
  and the surface almost everyone touches — including the GitHub Action, which wraps it.
- **The authoring + testing library entry points:**
  - `vigiles/linting` — what a spec author imports: the builders, the
    verified-reference constructors and their types. **Not the compiler**:
    `compileClaude`/`compileSkill`/`compileAgent`/`compileRailway` left the public
    surface in the major that ships #257 — compile with the CLI (`vigiles compile`).
  - `vigiles/spec` — the core builders (`enforce`, `guidance`, `instructionFile`,
    `file`, `cmd`, `ref`, `dir`, `glob`, `prose`, `result`,
    `delegate`, `railway`). Skill authoring is **not** on this list — see
    `experimental_skill` below, and neither is subagent authoring — see
    `experimental_agent`.
  - `vigiles` (the package root) — the free harness-test + check vocabulary,
    plus `defineEval`, which declares what a `*.eval.mjs` file measures.
    **`*.eval.*` FILE SHAPE IS A CONTRACT** and it changed in a major release —
    an eval file DESCRIBES its eval, it does not run one; see
    [eval files describe their eval](docs/harness-testing.md#eval-files-describe-their-eval)
    for the migration.
  - `vigiles/eval` — the model-calling measurement API; every runtime export
    carries a `paid_` prefix (`paid_runEval`, `paid_measure`, `paid_measureArms`,
    `paid_measureTriggerRate`, `paid_judge`, `paid_judged`,
    `paid_claudeEvalDriver`). Types are not prefixed.
  - `vigiles/claude-code`, `vigiles/codex` — the per-harness surfaces.
  - `vigiles/adapter` — the adapter-authoring kit. This is a **deliberate
    extension point**: third-party harness adapters are an intended use, so the
    kit is public before a named external adapter exists.
- **Compiled output contracts** — the `vigiles:sha256` integrity header and the
  emitted markdown/settings shapes a hook or spec compiles to.

A breaking change to any of the above is signalled with a Conventional-Commit
`!` and reflected in the version.

**What earns a public export.** A symbol is public only if (a) a named external
consumer uses it, or (b) it is a deliberate extension point listed above (the
adapter kit is the example). Everything else is internal by default; the
compiler (`compileClaude` & co.) left `vigiles/linting` on that rule. The
per-entry reports in `api-surface/` are the review point: `npm run api:check`
fails when the public surface changes without its report.

## What's still evolving — pin if you rely on it

- **The library API is 0.x.** Symbols outside the entry points above (and the
  internal modules under `dist/core/…` reached by deep import) may change in a
  minor release. Import from the published subpaths, not deep paths.
- **`vigiles/hook`** (compiled hooks) is exported and usable but **not yet
  frozen**. Its long-standing delivery caveat
  ([#34692](https://github.com/anthropics/claude-code/issues/34692) — a subagent's
  tool calls never reaching `PreToolUse`) is **fixed** as of Claude Code 2.1.241,
  measured on a stock install — headless `claude -p`, so interactive sessions are
  unmeasured — and pinned by a test that goes red if it regresses.
  A gate is still a strong default rather than an unbypassable wall, because a
  model can route around a tool entirely.

## Experimental — no stability promise

These are kept and worked on, but a launch user never needs them and they may
change or be removed **without** a major bump.

### The one rule

**If we export it and it isn't stable, its name starts with `experimental_`.**

That is the whole convention. Two supporting clauses:

- **`@experimental` in the TSDoc is how it's declared**, and the ESLint rule
  `local/experimental-name` fails CI if a tagged, exported declaration lacks the
  prefix — so the tag and the name cannot drift apart. It checks every exported
  declaration, internal ones included: an internal reader is still a reader who
  trusts the name.
- **`@internal` no longer means "unstable".** It answers a different question —
  _is this part of the API at all_ — and it is only correct on something we do
  **not** export. An `@internal` symbol that appears in `api-surface/*.api.md` is
  a contradiction, reported by a separate check (`npm run internal:check`)
  because that one needs the export graph rather than one file: the exports map
  ships it, so it is
  public whatever the tag says.

Why the name and not just a tag: a tag is invisible where it matters. You see a
name at every call site, in every diff, in every review, in autocomplete. Nobody
using `experimental_pipe(...)` can say they weren't told. We arrived at this the
hard way — `skill()` shipped under a stable name while its own documentation
opened with "`skill()` is experimental", and nothing caught it, because the
convention was a habit rather than a check.

Cost of the promise: renaming one of these is **not** a breaking change and does
not get a major bump. That is what "no stability promise" means.

### The corollary: one experimental ROOT per feature

The prefix answers "is this name stable?". It does not answer "is the name my
_stable_ symbol depends on stable?" — and that gap shipped: `railway()`,
`delegate()` and `result()` carried stable names while being meaningless without
`experimental_agent()`. A stable name resting on an unstable one promises more
than the feature can keep, and `local/experimental-name` cannot see it (it checks
tag-vs-name on one declaration, not the dependency between two).

So the vocabulary of an experimental feature hangs off ONE marked root:

```ts
experimental_agent({ … })                 // the builder
experimental_agent.result(ok, err)        // its outcome contract
experimental_agent.railway({ steps: […] })// the flat orchestrator
experimental_agent.pipe(a, b)             // the typed pipeline
```

The same chokepoint as `experimental_skill.input()`. Three things it buys, and
the first is the one the prefix alone could not:

1. **No stable name can rest on an unstable one** — there are no top-level names
   left to rest.
2. **Collision-prone words stop being global.** `result`, `needs`, `start`,
   `pipe` say nothing as package-level exports; on the root they are unambiguous.
3. **The warning survives destructuring.** `const { result } = experimental_agent`
   still names the root at the binding site — unlike a namespace OBJECT or an
   import subpath, which mark the import line and are out of view by the time
   anyone reads the call. That is why `vigiles/experimental` was retired rather
   than reused here.

TYPES stay top-level: a type annotation is not a call site, which is the same
reason the prefix rule excludes them.

Mechanically it is `Object.assign(fn, { … })`, not a TypeScript `namespace` —
`@typescript-eslint/no-namespace` is an error in this repo, and a namespace
merges only with `function` declarations (`experimental_skill` is a `const`).

### What's on the list

- **`experimental_skill()`** in `vigiles/spec` / `vigiles/claude-code` — skill
  authoring. Compiles, and its gates are verified, but no real skill corpus has
  been converted and a compiled `SKILL.md` has never been exercised as an
  installed skill. See `docs/skills.md` §Status.
  ⚠️ Known gap: its helper vocabulary — `input()` and `step()` — is used **only**
  by skill specs, yet is exported with no tag and no prefix, so nothing warns
  you. The check enforces "tagged ⇒ named", not "everything that should be
  tagged is". Treat both as carrying `experimental_skill`'s promise.
- **`experimental_agent()`** in `vigiles/spec` — subagent authoring. Moved off
  the stable list on 2026-08-21, and the reason matters because the evidence
  points the other way: a compiled `agents/code-reviewer.md` was loaded by real
  Claude Code, dispatched to and read, **100% of trials** (2026-06-20) — stronger
  end-to-end proof than `experimental_skill` has. What is unsettled is the
  **shape**, which is what this marker promises. `agent` stays as a `@deprecated`
  alias for one major.
- **Typed-composition combinators** in `vigiles/spec` — `experimental_pipe` /
  `experimental_pipeStep` / `experimental_needs` / `experimental_start` /
  `experimental_andThen`, and their helper types (`Supplies`, `Handoff`,
  `KnownAgentName`). The types stay unprefixed: the convention covers callables,
  since a type annotation is not a call site.
- **`experimental_effect()`** / effect-region (parked).
- The whole-harness codegen (`generate harness`) and capability lattice.
- Internal-only research/spike modules (`guards`, `hook-spec`, `evolve`) — not
  exported from any entry point.
- **Every export named `experimental_`**, wherever it lives. The prefix is the
  whole signal — there is no quarantined subpath any more. `vigiles/experimental`
  was deleted 2026-08-21: it marked the IMPORT LINE, which is out of view by the
  time anyone reads the call, and it split each draft feature across two doors
  (7 of the 20 experimental names were behind it; the other 13 already sat beside
  stable ones in `vigiles/spec` and `vigiles/hook`, so the subpath was not even a
  reliable place to look). The prefix marks every call site instead, and
  the ESLint rule `local/experimental-name` fails CI when a declaration tagged
  `@experimental` is not named for it. Today that covers the R3 disposable-service tier
  (`experimental_startServices`, … — on `vigiles`: it starts containers and calls
  no model, so it is not behind the paid `vigiles/eval` door, though it does have
  real side effects), the emit channel (`experimental_emitTool`, … — on `vigiles`), the
  compiled-hook entry points (`vigiles/hook`), and the spec builders
  `experimental_skill` / `experimental_agent` (`vigiles/spec`).

## How the surface is enforced

The public surface is tracked by **API Extractor**: a committed report per
entry point under [`api-surface/*.api.md`](api-surface/), checked in CI (`npm run api:check`),
so an export can't silently appear or change. See
[`docs/cli.md`](docs/cli.md) for the verbs and
[`docs/README.md`](docs/README.md) for the full doc index.
