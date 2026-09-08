# untested-skill

Flag a **skill** (`SKILL.md`) that ships without a test or eval. One of the
per-kind surface-coverage rules alongside
[`untested-subagent`](untested-subagent.md) and [`untested-hook`](untested-hook.md) —
together they replace the former umbrella `untested-surface` rule, so each kind
gets its own severity (a skill's "does it still fire and behave?" is a different
question from an agent's tool-contract or a hook's block/allow).

A skill with no test is a probabilistic-compliance gap hiding in the
deterministic layer — nothing measures whether it still does what it claims. A
skill does **not** need a `.spec.ts` (hand-written prose is a supported on-ramp);
it needs a way to know it still _works_ — a trigger eval (does the description
fire?), an outcome eval (is the result right?), or a colocated
`*.{harness,eval}.mjs`.

## Configuration

```json
{ "rules": { "untested-skill": "warn" } }
```

With options (ESLint-style tuple):

```json
{ "rules": { "untested-skill": ["error", { "include": ["**/*.eval.mjs"] }] } }
```

### Severity

| Value              | Behavior                                               |
| ------------------ | ------------------------------------------------------ |
| `"error"`          | `vigiles lint` exits non-zero when a skill is untested |
| `"warn"` (default) | Prints a warning, exits 0 — a nudge, not a gate        |
| `false`            | Skip skill coverage entirely                           |

### Options

| Option    | Type     | Description                                                                    |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `include` | string[] | Override which files count as tests (shared with the other `untested-*` rules) |
| `exclude` | string[] | Extra ignore globs                                                             |

## Scope

Scans `skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` (your plugin's own
skills — not vendored, fixture, or nested copies).

## What counts as "tested"

**Execution first, then the name, then nothing** — and the report says which of
the two answered.

### 1. A recorded run — `.vigiles/coverage.json`

When `vigiles test` / `vigiles eval` runs a script that exercises a surface, the
runner writes down which surface, which script, when, and the surface's content
hash at that moment. Coverage prefers that record over any file name, and prints
`MEASURED BY A RUN` instead of `colocated`.

The attribution is **derived, never declared**. `runScript` / `runHook` take it
from the command line they executed; the model tiers take it from the run's
transcript — the `Skill` call that actually resolved, not the set that happened
to be installed. There is deliberately no field you can fill in: that was
`vigiles:covers`, and it was removed for the reasons below.

Two things it will not do:

- **A run against older text grants nothing.** Edit the surface after measuring
  it and the record is reported as "measured, but not this version"; coverage
  falls back to the name until you re-run. A tick against a document somebody
  rewrote afterwards is not evidence.
- **One tier cannot answer for the other.** A `vigiles test` run satisfies the
  deterministic tier only — "nothing has measured whether this fires" still
  stands until an eval runs.

The file records one checkout at one moment, so **do not commit it**. A committed
one would credit coverage on a machine where nothing ran, which is precisely the
substitution this tier exists to remove.

**No artifact = the rule below, unchanged.** A fresh clone, CI, and anybody
else's repo see colocation exactly as they did before this tier existed — not one
extra finding, and not one fewer.

### 2. Colocation — the fallback, and the test must be NAMED after the surface

Placement says where a file sits; only the name says what it is about.

```
skills/foo/SKILL.md
skills/foo/foo.eval.mjs          <- covers it (free of config, like `foo_test.go`)
skills/foo/foo.harness.mjs       <- also covers it
skills/foo/bar-ablation.eval.mjs <- does NOT: it is a test about `bar`
skills/foo/tests/foo.eval.mjs    <- does NOT: a subdirectory is not beside it
```

One rule for all three kinds — an agent or a hook takes the same
**name-prefixed sibling**: `agents/bar.harness.mjs`, `hooks/pre-edit.harness.mjs`.

Why a subdirectory does not count: colocation is worth having for exactly one
property — `ls` answers _"is this tested?"_ without running anything. Permit
`skills/foo/tests/` and it takes `find` instead, and two permitted shapes become
a choice at write time and a lookup at read time. A bundled script's own unit
test (`skills/foo/scripts/thing.test.mjs`) is a good test **of that script** and
not a test of the skill, which is the distinction the rule turns on.

**Which of the two names to use** — they are not synonyms, unlike `.test.` and
`.spec.` elsewhere in the JS world:

| file              | costs                               | answers                                    |
| ----------------- | ----------------------------------- | ------------------------------------------ |
| `foo.harness.mjs` | nothing, runs on every push         | does this gate still catch what it claims? |
| `foo.eval.mjs`    | real model calls, run on a schedule | does this skill fire at all?               |

A surface with only a harness is reported as never having had its firing
measured, which is a different gap with a different price — not a smaller one.

### Why the name has to match (changed 2026-08-11)

A skill used to be covered by ANY file under its directory, while agents and
hooks already required the name. Found by dogfooding: a repo's
`.claude/skills/paper-pipeline/` held six `*.eval.mjs`, exactly one about that
skill — the rest measured OTHER skills and sat there because the directory had
been the pipeline's home before tests moved next to their subjects. One was
literally `grade-paper-writing-ablation.eval.mjs`. The orchestrator scored as
covered and had no test of its own.

That is the same substitution the removed `mention` tier made — a name near a
test taken for a test.

### Migrating a test named `foo.test.mjs` (changed in 15.x)

**`*.test.*` and `*.spec.*` no longer count toward Tested.** They used to. If you
followed the older advice you have a `skills/foo/foo.test.mjs` today, it counts
for nothing now, and the skill is reported untested.

**The fix is a rename, not a config change:**

```
skills/foo/foo.test.mjs      ->  skills/foo/foo.harness.mjs
```

Nothing else changes — same file, same contents, same assertions.

**Why a rename and not `include`.** You _can_ point `include` back at
`**/*.test.mjs` and the count will come back, but that restores the number while
leaving the actual problem in place. A harness test is not a unit test: it calls
`runHarnessTest` / `measureTriggerRate`, which **spawn an agent**, and the paid
tier spends real model budget. Meanwhile `*.test.*` is what every third-party
runner collects by default:

| runner | default pattern                                                             |
| ------ | --------------------------------------------------------------------------- |
| vitest | `**/*.{test,spec}.?(c\|m)[jt]s?(x)`                                         |
| jest   | `**/?(*.)+(spec\|test).?([mc])[jt]s?(x)`, and every file under `__tests__/` |

Measured: a bare project containing only `package.json` and
`.claude/skills/foo/foo.test.mjs`, then `npx vitest run` at the repo root —
`Test Files 1 passed (1)`. Vitest descends into `.claude/`; its `defaultExclude`
is `node_modules` and `.git` and nothing else. So a file with that name is picked
up by your ordinary test command, on every push, and can spend model budget
nobody asked it to spend. `*.harness.mjs` and `*.eval.mjs` match **no**
third-party default, which is the whole reason those names were chosen.

`vigiles audit`/`lint` used to report such a file under its own finding
(`foreign-runner-test`), and **no longer does** — that check was removed on
2026-08-12. It tried to decide from a file's TEXT whether it drives an agent, and
over three corpora (4 554 js/ts files) it never once found a real one while
producing seven distinct false-positive shapes — each of which told an author to
rename a working test. The last was an ordinary offline test that injects a fake:
`function testDriver(runEval) { runEval(fake); }`.

Nothing is at risk, because the protection was never the warning. `vigiles`
refuses to spawn an agent at all when it detects it is running inside a foreign
test runner — see `refuseUnderForeignRunner`, which guards every spawn door. A
misnamed harness test cannot spend model budget under `npx vitest`/`npx jest`; it
simply refuses. What you lose is the early heads-up in the report, not the
safety. The reasoning and the measurements are recorded in
`src/core/foreign-runner.ts`.

If the file really is an ordinary offline unit test of a bundled script — no
agent, no model — it is not a harness test at all, and it never counted toward
Tested even under the old rule. Leave it where it is.

### Why only one (changed 2026-08-11)

There used to be three — a `vigiles:covers` **declaration**, **colocation**, and a
**content-reference** that credited any test whose code named the surface. They
were never three strengths of evidence; they were three naming conventions, all
answering _"does this surface's name appear near a test?"_ and none answering
_"did anything run against it?"_.

Measured on vigiles's own repository before the change, the content-reference
tier supplied **9 of 10** covered surfaces, and at least three of those were
false — including two shipped hooks credited by the coverage detector's **own**
test suite, which names them as fixtures. A declaration fared no better in
practice: its first real use declared a conformance _lint_ over 21 skills as
coverage _of_ those 21 skills, moving a repo from 31 untested to 16 while nothing
new was tested.

Colocation is kept because it cannot drift by construction. The test lives with
the surface, so deleting the skill deletes its test, renaming moves both, and
`ls` answers "is this tested?" without running anything.

**The cost, stated plainly:** a good test that lives somewhere else now counts
for nothing until you move it next to its surface. That is the intended
pressure — a per-surface test belongs with its surface.

> ⚠️ **What colocation still does not prove.** It says the file **exists**, not
> that it **ran**: an empty `foo.eval.mjs` counts, and the report says so on every
> run. That is why the execution tier above sits on top of it rather than beside
> it — a surface answered by `colocated` is one that nothing has ever been run
> against.

## Counting an external test suite (promptfoo, a home-grown eval loop)

If you already test your skills through a **separate loop** — a
`promptfooconfig.yaml`, a home-grown `evals.json` benchmark, a Python harness —
point `include` at those files **and place them beside the skill they cover**:

```json
{
  "rules": {
    "untested-skill": [
      "warn",
      {
        "include": ["**/*.{harness,eval}.mjs", "skills/*/promptfooconfig.yaml"]
      }
    ]
  }
}
```

A file in `include` counts only where it sits. One central config naming every
skill covers none of them — that is the content-reference rule that was removed.

### A centralized layout: the `{surface}` placeholder

If your suites live in a **central tree** rather than beside each skill —
`tests/<skill>/evals/promptfooconfig.yaml` is the common shape — write the
placeholder `{surface}` where the skill's name goes:

```json
{
  "rules": {
    "untested-skill": [
      "warn",
      { "include": ["tests/{surface}/evals/promptfooconfig*.yaml"] }
    ]
  }
}
```

`{surface}` is replaced with each skill's own name before matching, so
`tests/mysql-designer/evals/promptfooconfig.yaml` covers `mysql-designer` — and
nothing else.

**An `include` entry WITHOUT `{surface}` still credits nothing on its own.**
It widens what counts as a _test file_ but says nothing about which _surface_ a
file is for, and inferring that from a substring is exactly the
content-reference rule that was removed for crediting surfaces no test had
touched.

**What it costs, so you can decide honestly:** `ls` beside the skill no longer
answers "is this tested?" — you have to know where the project keeps its tests.
That is the property colocation was chosen for, which is why this is opt-in per
repo rather than a second default. If your suites are already centralized, you
have paid that cost anyway.

Where both exist, **colocation wins** and is what the report names, regardless of
the order of your `include` array.

## Exemptions

**Every** skill is held to this — invocation mode does **not** exempt anything. A
command-only skill (`disable-model-invocation: true`) still _does_ something when
invoked, and that behaviour is worth a test (a trigger eval is meaningless for it,
but a behavioural/outcome test isn't). The only opt-out is an explicit
`<!-- vigiles:ignore-test -->` marker in the `SKILL.md`, reported as `exempt` so
the skip is visible, never silent.

## Why

vigiles's second layer is testing the harness as the assembled machine it ships
as. This rule closes the loop for skills: every activatable skill should have
_something_ that measures it. Warning-by-default keeps adoption gradual; flip to
`"error"` to gate CI.
