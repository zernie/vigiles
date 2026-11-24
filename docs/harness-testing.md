# Testing your harness

**You wired a hook — but does it actually block? Does your skill fire on the right
prompts and stay quiet on the wrong ones?** Your hooks, skills, settings, and
instruction file are **code**, and right now they're untested. vigiles tests they
do their job: hooks block, skills fire, the assembled agent does the task and not
the dangerous thing. The [README](../README.md) has the pitch; this is the how-to.
Testing is one of four reliability instruments — alongside
[verifying](verifying-instruction-files.md) references are true and
[guarding](compiled-hooks.md) with a compiled hook that can't be wrong (the
deterministic gate); this guide is the **test** instrument.

Most of it runs with **no model and no API key** — milliseconds, on every commit.
Only the real-model tier (evals) needs a model, and it runs on your own `claude`
CLI, not metered tokens.

> Want to know whether a skill or plugin actually **helps** — does it beat the
> no-skill baseline, and at what cost? That's the measurement layer on top of these
> tiers: see [Measuring skills & plugins](measuring-skills.md).

## Your first test

A hook is just a process: the harness pipes it a JSON event and reads back an exit
code (`2` = block). `runHook` drives exactly that — no harness binary, no model —
so a hook's logic is testable in milliseconds, in any runner:

```ts
import { runHook, check, assertChecks } from "vigiles";

const r = runHook(
  '"$GUARD"',
  {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit --no-verify" },
  },
  { env: { GUARD: guardPath } },
);

assertChecks(r, [check.hook("PreToolUse", { blocked: true })]); // exit 2 / decision:"block" / permissionDecision:"deny"
```

A red ✗ means your guard silently lets `--no-verify` through. That's the whole
idea: turn "did it fire?" into a real assertion.

**Or let the agent write it.** Paste into Claude Code, in any repo:

```text
Install vigiles and use its test-harness skill to write and run a harness test
for this project. If I didn't say what to test, pick something real from my
hooks / skills / settings yourself, choose the cheapest tier that fits, write
the test, and run it.
```

The `test-harness` skill scans your harness, picks the cheapest meaningful tier,
writes the test, and runs it. Prefer the CLI? `npx vigiles test` (deterministic,
no key) and `npx vigiles eval` (real model) discover and run `*.harness.mjs` /
`*.eval.mjs`.

## What do you want to test?

Start here. Pick the row that matches your question — each links to its section.

| I want to check…                                                    | Use                                                                   | Needs               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------- |
| my **helper script** does what it claims                            | [`runScript`](#test-a-plain-program-runscript)                        | nothing             |
| my **hook** blocks/allows an event                                  | [`runHook`](#test-a-hook-in-isolation-runhook)                        | nothing             |
| my **safety hook** really blocks `rm -rf`, force-push, `curl \| sh` | [`runGuardrail`](#prove-a-guard-actually-blocks-the-disaster-battery) | nothing             |
| my hook/skill is **wired in** and actually fires                    | [`runHarnessTest`](#test-the-assembled-machine-runharnesstest)        | harness CLI, no key |
| my **output style** loads, and what each reply printed              | [`runHarnessTest({ outputStyle })`](testing-output-styles.md)         | harness CLI, no key |
| my **skill fires** on the right prompts (recall + precision)        | [`measureTriggerRate`](#test-a-skill-fires-measuretriggerrate)        | a real model        |
| a change **moves the agent's behaviour** (A/B, with stats)          | [`runEval`](#test-a-change-moves-behaviour-runeval)                   | a real model        |
| the **references** my CLAUDE.md cites are real                      | [`vigiles lint`](verifying-instruction-files.md)                      | nothing             |

The first four are **deterministic** — assert pass/fail, run on every commit,
free. The model tiers **measure** (a rate ± error across trials) — run them
occasionally on a keyed job, never gate a single run. Every name has its
reference on the page of the entry it is imported from: [API by entry](api/README.md).

## Test a plain program (`runScript`)

Your harness is not only hooks and skills — it's also the helper scripts they
shell out to. `runScript` runs any program and reports **what it did**: exit
code, **both** streams, and (when confined) what it wrote and what it reached.

```ts
import { runScript } from "vigiles";

const r = runScript("bash scripts/check-links.sh", { cwd: repoDir });
assert.equal(r.exitCode, 0);
assert.match(r.stderr, /0 broken links/); // advisory output lives on STDERR
```

> ⚠️ **Don't hand-roll this with `execFileSync`.** It returns **stdout alone** on
> success, so advisory output — including vigiles's own compiled-hook `notice()`
> — silently vanishes, and a perfectly healthy react hook reports as **dead**.
> Every vigiles runner returns both streams, which makes that bug
> unrepresentable.

**`runScript` vs `runHook`.** `runHook` _is_ `runScript` plus the hook protocol
(serialize the event to stdin, read the exit code as allow/deny). Pick by the
question: a **hook** has a _decision_, a **script** has _effects_. That is why
`ScriptRunResult` carries no `decision` field — an always-meaningless field
teaches the reader the field means nothing.

**Asserting what it wrote needs confinement.** `filesWritten` comes from diffing
the work dir, which only a confined run does, so it is `undefined` after a plain
run — deliberately not `[]` ("recorded, wrote nothing"). `check.writes`
**fails** on an unrecorded result rather than pass having looked at nothing:

```ts
const r = runScript("bash scripts/build.sh", { cwd: repoDir, sandbox: "auto" });
assertChecks(r, [check.writes({ only: [/^dist\//] })]); // meaningful: writes were actually recorded
```

## Test a hook in isolation (`runHook`)

`runHook` is the base of the pyramid and the only tier that reaches **every** event
— including `Edit` / `Write` / `PreCompact` / `SessionEnd` that the assembled mock
can't synthesize, because _you_ hand it the event JSON. It proves the hook's
**logic**; it does _not_ prove the hook is wired in (that's the next tier — use
both).

```ts
import { runHook, check, assertChecks } from "vigiles";

const r = runHook(hookCmd, {
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "README.md" },
});
assertChecks(r, [check.hook("PreToolUse", { blocked: false })]); // ran, and let it through
```

### Assert a nudge reaches the model (`check.delivered`)

A hook that _prints_ a warning has not _delivered_ it. Which stream the model
reads depends on the event and the exit code, and the commonest mistake is
invisible to a test that reads `r.stderr`: a `PostToolUse` hook that writes to
stderr and exits 0 reaches nobody. Claude Code's hooks docs, verbatim:

> Claude never sees stderr from a hook that exits 0. [...] To surface a warning to
> Claude from a `PostToolUse` or `PostToolUseFailure` hook, exit 2 instead so
> Claude sees the stderr even though the tool already ran.
> — [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks#exit-code-0)

`runHook` judges this for you: every result carries `delivery`, and
`check.delivered()` fails unless some of the hook's text reached the model.

```ts
import { runHook, check, assertChecks } from "vigiles";

const r = runHook(lintHookCmd, {
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "notes/a.md" },
});
assertChecks(r, [check.delivered()]);
// ✗ expected the hook's output to reach the model, but none did (exit 0):
//   - 37 bytes on stderr: stderr from a hook that exits 0 reaches no channel the
//     model reads. Emit JSON `hookSpecificOutput.additionalContext` on stdout, or
//     exit 2 (`PostToolUse` feeds that stderr back to the model).
```

`r.delivery.kind` is one of five, and each failure names its own cause:

| `kind`        | meaning                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `delivered`   | text reached the model — `via` lists how (`additional-context`, `plain-stdout`, `exit-code-feedback`, …)   |
| `undelivered` | text was printed, none reached the model — `stranded` names each stream, its bytes, and the cure           |
| `blocked`     | the hook vetoed the action; a block is not a nudge — use `check.hook(event, { blocked: true })`            |
| `silent`      | nothing addressed to the model (or the hook never ran — see `r.ran`)                                       |
| `unknown`     | the harness's capability table has no row for this event, so delivery is not judged — and the assert fails |

The verdict reads the harness's **event capability table** (what each event
honours), so it is only as good as that table: Claude Code's records nine events,
and an event outside it is `unknown`, never guessed. On another harness pass its
table as `capabilities` (`runHook(cmd, event, { protocol, capabilities })`); a
harness with no table (Codex today) is judged only where its protocol proves
delivery (`additionalContext` on its injectable events) and is `unknown` elsewhere.

**Why this is a test-time check and not a lint rule for shell hooks.** Whether a
shell script writes to stderr and which code it exits with is a property of its
_run_, not its text — `echo "$msg" >&2` may sit behind any branch, wrapper or
`exec`. A static guess would be wrong in both directions, so `vigiles` does not
make one; run the hook and assert. [Compiled hooks](compiled-hooks.md) are
different: there the compiler knows the event and the emit path, so a `notice()`
is emitted as `additionalContext` on an event that injects, and `vigiles compile`
warns when a react sits on an event that does not.

**Testing a hook you don't trust?** Mark it `trusted: false` and it runs confined
under bubblewrap by default (no egress, scrubbed env — it can't read your API key),
refusing rather than running unconfined where no sandbox exists:

```ts
runHook(vendoredHookCmd, event, { trusted: false, env: { GUARD: guardPath } });
```

See [Sandboxing](sandboxing.md) for the confinement model and the `egress` option.

**Testing a hook that remembers something?** A throttled hook ("nag at most
once a day") only behaves interestingly against an **old** recorded fact.
`experimental_hookState` on `vigiles/hook/testing` seeds one through the same
store the runtime writes:

```ts
import { experimental_hookState } from "vigiles/hook/testing";

const st = experimental_hookState(hookFile, { cwd });
st.seed("retro.nagged", { ago: "4d" }); // → the hook speaks
runHook(hookCmd, event, { cwd });
```

[The handle and its caveats →](api/hook-testing.md#seed-a-fact-a-hook-remembers-experimental_hookstate)

## Prove a guard actually blocks (the disaster battery)

A guard that looks like it blocks and silently does not is the most expensive
hook bug: nothing fails, so nothing tells you. The **disaster battery** on
`vigiles/hook/testing` sends your guard seven destructive commands (force-push,
`reset --hard`, `rm -rf /`, `commit --no-verify`, reading `~/.ssh/id_rsa`,
`curl … | sh`), each in many other spellings that must also block, and each
as harmless data (a commit message, a heredoc, an `echo` argument) that must
be allowed. A compiled hook is checked exactly; a command string is run the way
the harness runs it.

```ts
import { assertChecks } from "vigiles";
import { guardrail, runGuardrail } from "vigiles/hook/testing";

assertChecks(runGuardrail("bash hooks/safety-guard.sh"), [guardrail()]);
```

Each failure names the case, for example `force-push~12`, the twelfth spelling
of `force-push`. A command-string hook runs 199 cases, so give the test a 30 to
60 second timeout; a compiled hook takes about a second.

The same entry covers the rest of the job:

- **Your own disasters**, or only some categories: pass `disasters({ events, categories, spellings, harmless })`.
- **A guard that reads repository state** ("no force push while on `main`"):
  `experimental_crossRepo` builds real temporary repositories and aims the
  command at another one. The command in the event is never executed; your hook
  runs as it is, unconfined unless you pass `sandbox`.
- **Every hook a repository declares**, each with its own event, matcher and
  `if` condition: `experimental_runPluginGuards(".")`.

[Full reference, with what each half catches, the cross-repository forms and the sweep's statuses →](api/hook-testing.md#prove-a-guard-blocks-every-disaster)

## Test the assembled machine (`runHarnessTest`)

Right logic ≠ wired in correctly _and_ reaching the model. `runHarnessTest` spawns
the **real** harness binary against a **scripted mock model** — real hooks fire,
model turns are fixed, no key, no cost. The unit under test is the _assembled_
plugin: hooks + settings + instruction file + skills together.

```ts
import { runHarnessTest, check, assertChecks } from "vigiles";

const r = await runHarnessTest({
  plugin: "./", // load THIS repo's real hooks + instruction file + skills
  prompt: "refactor the billing module",
  transcript: true, // capture the event stream
  model: [{ text: "on it" }], // the scripted model turns
});

assertChecks(r, [
  check.hook("UserPromptSubmit"), // it actually fired
  check.output(/on it/), // …and the run completed
]);
```

The result is a `Trace` — the observable record of the run (`toolCalls`, `hooks`,
`output`, `modelRequests`, `turns`, `file(p)`). Assert on it with checks in
`assertChecks`, or read its fields directly. The fields are in
[the `Trace` model](testing-api.md#the-trace-model); the check vocabulary is on
[the `vigiles` page](api/vigiles.md#the-members-of-check).

## Assert a subagent's typed outcome (railway / Result)

"Did the subagent succeed, with the right result?" is normally a job for a model
judge. A **`result()` contract** makes it a deterministic assert: the subagent
ends its turn with a typed `vigiles:ok` or `vigiles:err` block, and
`experimental_assertAgentOk` (on `vigiles/spec`) validates it and returns the
success value. Prose instead of a block, or the wrong shape, is `malformed` and
fails.

```ts
import { experimental_agent, experimental_assertAgentOk } from "vigiles/spec";
const { result } = experimental_agent;

const implementer = result(
  { files: "string[]", summary: "string" },
  { reason: "string", step: "string" },
);
const ok = experimental_assertAgentOk(r.output, implementer); // throws unless a valid ok block
```

The error track and predicates are `check.experimental_agentResult`:
[`vigiles/spec` reference](api/spec.md#assert-a-subagents-outcome-without-a-model-judge).
The contract end to end: [railway subagents](railway-subagents.md).

## Assert a side-effect boundary (`check.writes` / `check.tool(…, { max: 0 })`)

The other half of a typed contract is _where a unit writes/calls_. A skill that
declares it writes only `out.txt` and never pushes should be **asserted to stay
inside that surface** — not eyeballed, and not handed to a model judge. The check
vocabulary is the seam:

```ts
import { check, assertChecks } from "vigiles";

assertChecks(r, [
  check.writes({ include: ["out.txt"] }), // produced the artifact it promised
  check.writes({ none: ["secrets.env"] }), // left NOTHING outside the declared surface
  check.tool("Bash", { with: { command: /git push/ }, max: 0 }), // never reached for a forbidden effect
]);
```

`check.writes` reads the real post-run work dir; `check.tool(…, { max: 0 })` reads the decision
to act (a check a completion-grader structurally cannot make — it sees the agent's
final text, not the tool call it _almost_ made). All three are **deterministic** —
the scripted mock model only does what the script says, so a `Write` either landed
or it didn't.

These checks **verify** behaviour; a `purity:` floor (`pure`/`bounded`) on the
`experimental_skill()`/`experimental_agent()` spec **enforces** it — a `PreToolUse` rail that _denies_ the
bad call at runtime. They're different layers, not a double-check: the floor makes
the action impossible in the loop, the test proves the good behaviour happens (and
is how you catch a _prose_ instruction leaking when there's no floor to lean on).
See [Enforce vs. verify](spec-format.md#enforce-vs-verify).

## Test a skill fires (`measureTriggerRate`)

A skill's whole value is its description **activating on the right task** — the #1
skill-authoring pain, and a property only a real model decides. The deterministic
tiers prove the _wiring_; this proves the _activation_.

`greet.eval.mjs` — a file that **describes** the measurement; `vigiles eval` runs
it (see [Eval files describe their eval](#eval-files-describe-their-eval)):

```ts
import { defineEval, check } from "vigiles";
import { assertRates } from "vigiles/eval";

export default defineEval({
  measureTriggerRate: {
    skillsDir: ".claude/skills", // loose repo skills — auto-packaged
    stubSkillBodies: true, // measure SELECTION only (stub bodies → much cheaper)
    prompts: ["…≥10 varied tasks the skill should handle…"], // recall
    irrelevantPrompts: ["…≥10 unrelated tasks it should ignore…"], // precision
    fired: check.skill("my-plugin:greet"),
    trials: 2,
  },
  // the report is printed for you — this is the part only you can write
  assert: (report) => assertRates(report, { min: 0.8, maxFalsePositive: 0.1 }),
});
```

```bash
npx vigiles eval greet.eval.mjs   # trigger-rate: 80% (10 runs)
```

`prompts` measures **recall** (does it fire when it should); `irrelevantPrompts`
adds **precision** (a too-broad description that hijacks unrelated work fails too).
Three things keep it cheap and honest, on by default: bodies are stubbed (firing is
a frontmatter property, decided before the body loads), a diversity gate rejects a
copy-pasted prompt set before spending a token, and it runs on the realistic
selector model (`sonnet`). Every knob — `fixture`, `installSet`, `concurrency`,
`minModel` — is in the **[reference](api/eval.md#measuretriggerrate-options)**.

> **Whole plugin at once:** `vigiles audit <plugin>` measures recall / precision
> for every model-invocable skill (auto-generated probes) and prints it as the
> behavioral column of the audit report (interactive); for automation call this directly.
> Same engine, batch front-end.

### When it reports 0% on everything, suspect the wiring first

A total zero looks exactly like a result — the run executed, the report is
well-formed, every line reads `0.00` — and it is usually a setup mistake. The
report now says so and lists the three causes, in the order they bite:

1. **the id in `fired`** — `check.skill` matches the **namespaced** id
   (`<plugin>:<skill>`); a bare name silently never matches;
2. **the install field** — a loose `.claude/skills` directory needs `skillsDir`,
   not `pluginDir` (which wants a full plugin manifest);
3. **the `fixture`** — a run starts in an **empty** cwd, so a prompt about a file
   that does not exist is one the model is right to decline.

`measure` / `measureArms` print the same note when every `check.skill()` check is at
0%, and their `CheckReport.namespace` names the installed namespace the way
`TriggerRateReport.namespace` does.

All three were hit in one afternoon building a real suite, and two were briefly
written up as findings about the skills before being caught. A _partial_ rate is
left alone: it is a real measurement, and a tool that hedges on good data gets
ignored.

### Is a cheaper model a valid floor? (`compare(before, after)`)

The obvious economy is to measure on the weakest model — if a description fires
there it fires on a stronger one, the way you test against the oldest supported
runtime. That holds only if

```
fires on the weak model  =>  fires on the strong one
```

and that is not obvious, because selection is **routing**, not raw capability: a
stronger model can legitimately route elsewhere, doing the work itself or picking
a more specific sibling.

**Measured 2026-08-11 — it does not hold.** 21 skills × 4 prompts, one trial
each, whole-harness against 37 competing skills: of 84 shared prompts, **3 fired
on haiku and not on sonnet**, and one skill scored **haiku 1.00 against sonnet
0.75**. That is enough to reject the argument — it needs containment to hold, not
to usually hold — and not enough to claim it breaks often. Hence the `sonnet`
floor. Run the same set on both and `compare` the two trigger-rate reports,
prompt by prompt:

```ts
import { compare } from "vigiles/eval";

const { lost, gained } = compare(weak, strong);
// lost   — fired on the weak model, not the strong one (counterexamples)
// gained — fired on the strong model only (expected under-selection)
```

The same call answers "which prompts did my description edit break?":
`compare(before, after).lost`. It keeps the two directions apart, which is the
point:

- **weak-only** (`lost`) — fired on the weak model, not the strong one. Each is a
  **counterexample**: the weak model is not a floor, it is a different router.
- **strong-only** (`gained`) — fired on the strong model only. **Expected, not a failure** —
  this is the under-selection the `sonnet` floor exists for.

⚠️ At one trial per prompt each cell is a single observation, so one weak-only
prompt is noise rather than a counterexample. And where firing is **inferred**
rather than observed — Codex emits no skill-selection event, which is why its
trigger-rate is flagged experimental — the comparison inherits that uncertainty
and can manufacture counterexamples out of it.

## Test a change moves behaviour (`runEval`)

When the question is the **lift** a change buys — does this hook/skill/rule
actually change what the agent does? — run an A/B. `runEval` drives the real model
N trials × arm and aggregates **mean ± se** with **significance**, so you can tell
a real gap from sampling noise:

```ts
import { defineEval } from "vigiles";

export default defineEval({
  runEval: {
    env: { kind: "ephemeral" },
    fixture: { "src/billing.ts": "export function chargeCard() {}" },
    arms: {
      vanilla: {},
      gated: { settings: { hooks: { PostToolUse: [refsHook] } } },
    },
    task: "Document chargeCard in SKILL.md, referencing it by name.",
    measure: (ctx) => ({
      marked: ctx.sh("grep -c vigiles:symbol SKILL.md") !== "0",
    }),
    trials: 6,
  },
});
// vanilla marked=0.00   gated marked=0.50±0.20   ($0.07 · 1.2s/run)
```

> **Testing _one_ skill with no on/off variant?** Don't force an A/B — score the
> output directly with `measure({ checks: [judged(rubric)] })` + `assertRates`.
> That's the right oracle for "is this skill any good?"; A/B is for "does it _move_
> behaviour vs off?". Both are in the [reference](api/eval.md#runeval-measure-measurearms).

> **Note:** `runEval` is shipped and proven for Claude Code; for Codex it's a
> documented follow-on — use the deterministic `runHarnessTest` tier there.

## Keep eval results fresh in CI (the lock)

Real-model evals run on your subscription, so they run **on your machine, never in
CI**. That leaves one classic bug: you tweak a skill, forget to re-run the eval,
and ship stale numbers. The **eval lock** catches it — a small committed file that
CI checks **with no model and no API key**.

You mostly won't touch this by hand. The `test-harness` skill records the lock
when it runs an eval, and a hook reminds the agent to refresh it after an edit.
Here's the whole loop:

```
  YOU / the test-harness skill            CI  (no model, no key)
  ────────────────────────────            ─────────────────────
  run the eval  ─────────────┐
                             ▼
            vigiles eval --update           vigiles eval --check
            writes the lock file  ──commit──►  re-hashes the inputs
            (.vigiles/eval-locks/)                    │
                                          same inputs? ├─ yes ─► ✅ pass (replays)
                                                       └─ no ──► ❌ "stale, re-run --update"
```

What each command does:

| Command                 | Runs where   | Needs a model?    | Does                                                   |
| ----------------------- | ------------ | ----------------- | ------------------------------------------------------ |
| `vigiles eval --update` | your machine | ✅ yes (your sub) | records the result to a committed lock                 |
| `vigiles eval --check`  | CI           | ❌ no             | verifies the committed result still matches the inputs |

It's the `npm ci` / `cargo-insta` pattern. `--check` hashes the eval's inputs
(skill text, prompts, model) and fails if they changed without a re-run. You review
the committed diff — `recall: 0.90 → 0.65` is the quality gate.

Two things keep it low-noise:

- ✅ **Change a threshold** in your test → valid replay, no model call. Your own
  `assertRates` / `assertImproves` re-run against the saved numbers.
- ❌ **Change an input** (skill text, prompts) → stale → re-run `--update`.

ℹ️ **Honest scope:** the lock proves "your saved numbers match your current
inputs," not "they reflect today's model." Re-run `--update` when you want fresh
numbers. In CI it's `command: eval-check`. It fails until you commit your first lock
(there is nothing to verify before that). `vigiles init` scaffolds the job as
`npx vigiles eval --check --min=0`, so a repo with no eval file yet stays green and
the first eval file turns it red until its lock is committed.

### Three files, three different jobs

An eval leaves up to three artifacts behind and they are easy to confuse — the
product's own author could not tell the lock from the cache, which is what
prompted this table.

| Artifact                     | What question does it answer?                                  | Where                                  | Who writes it                        | Committed?                            |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------- |
| **Ledger** (flight recorder) | "what did my harness actually do, locally, over time?"         | `.vigiles/runs.jsonl`                  | every run, automatically             | ❌ local only — vigiles ignores it    |
| **Cache**                    | "can I re-score this eval without paying for the model again?" | `.vigiles/eval-cache/`                 | `cache: "readwrite"` on an eval spec | ❌ local only — vigiles ignores it    |
| **Lock**                     | "do my committed numbers still match my current inputs?"       | `.vigiles/eval-locks/<name>.lock.json` | `vigiles eval --update`              | ✅ **yes — this is the one CI reads** |

**The lock is the only one that leaves your machine.** Run a hundred evals and
commit no lock, and CI can verify nothing: the ledger and the cache are both
gitignored by design — vigiles keeps them in `.vigiles/.gitignore` itself, so
there is nothing to add to yours. `vigiles audit` says so out loud when it finds
eval runs in the ledger and no committed lock.

The one design difference worth knowing: **the cache keys on the harness binary
version and the lock deliberately does not.** The cache's key is strict because
replaying a recorded model call under a different `claude` build would not be an
honest replay. The lock's key is loose on purpose — CI pins one `claude` version
and your laptop has another, so folding that in would fail `--check` on every PR
without a single input having changed.

**How the agent gets reminded** is the same on both harnesses — the hook injects the
nudge as `additionalContext` (Claude Code and Codex both honor it). See the per-harness guides:
[Claude Code](harness-testing-claude-code.md#keeping-eval-results-fresh--the-nudge-claude-code)
· [Codex](harness-testing-codex.md#keeping-eval-results-fresh--the-nudge-codex).

## Advanced

These ride on the eval tier — reach for them when the basic measure isn't enough.
Each has its full API on the [`vigiles/eval` page](api/eval.md).

- **[Significance](api/eval.md#significance--regression-gating)** — `compare` reports, and `assertImproves({ significant: true })` throws unless, the gap clears the (computed) noise floor: disjoint Wilson intervals for a 0/1 metric, Welch's t-test for any other. A `no-signal` verdict means raise `trials`.
- **[Regression gating](api/eval.md#significance--regression-gating)** — record a committed baseline, then fail CI when an arm×metric moves significantly in the bad direction (`assertNoRegression`). Jest snapshots for agent behaviour, with a real noise floor.
- **Cost / caching / concurrency** — `concurrency`, `maxCostUsd`, and `cache: "readwrite"` (record/replay: editing your `measure` re-scores for free). See [reference](api/eval.md#runeval-measure-measurearms).
- **LLM-as-judge** — when the metric isn't a regex, grade it with a model inside `measure` via `judge({ output, rubric })`. Deliberately thin; for dashboards use Braintrust/DeepEval.

## Run it in CI

Two surfaces, both dogfooded in this repo's own [`ci.yml`](../.github/workflows/ci.yml):

**The CLI** discovers and runs scripts, no runner needed — name them
`*.harness.mjs` / `*.eval.mjs` (JS **or** TS):

```bash
vigiles test            # *.harness.mjs — deterministic, no key (runs in CI free)
vigiles eval --trials=6 # *.eval.mjs — real model, on a keyed job only
```

### Eval files describe their eval

A `*.harness.mjs` is a **program**: it is free, so running it is the point. A
`*.eval.mjs` is a **description**: it spends real money, so it must not be able
to run itself.

```js
import { defineEval, check } from "vigiles";
import { assertRates } from "vigiles/eval";

export default defineEval({
  measure: {
    pluginDir: ".",
    task: "…",
    checks: [check.skill("me:greet")],
    trials: 3,
  },
  assert: (report) => assertRates(report, { min: 0.6 }),
});
```

Exactly one measurement — `runEval` · `measure` · `measureArms` ·
`measureTriggerRate` · `paid_measureSelectionMatrix`, keyed by the runner's own name —
plus two optional hooks: `skipIf()` returns a reason to skip (a loud `⊘ SKIPPED`,
never a silent green) and `assert(report)` says what the report has to show.
`vigiles eval` runs the measurement, prints the report with the right formatter,
fails a run that executed zero trials, and then calls your `assert`.

**Why not just call the runner at the top of the file?** Because in ESM `import`
IS execution, so the cheapest imaginable question — "does this file even parse?"
— spends money when asked with `import()`. That happened here, and was paid for.
No guard can close it: under `node -e 'import(f)'` there is no `process.argv[1]`,
so nothing distinguishes it from a legitimate runner doing the same import. A
description has nothing to run, which is a different kind of answer.

Three consequences worth knowing up front:

- **`node x.eval.mjs` now fails loudly** and tells you to run `vigiles eval`. It
  does not quietly do nothing, which would be the same defect in a new place.
- **`node --check x.eval.mjs`** is the free syntax check. It never executes.
- **`trials` comes from the spec**, and `vigiles eval --trials=N` overrides it.
  No eval file reads `process.argv` or `VIGILES_TRIALS` any more.

#### Migrating an existing eval file (BREAKING, one major version)

Take the runner call out of the module body and make it a key. Everything else
is deletion. In `x.eval.mjs`, replace

```js
const trials = Number(process.env.VIGILES_TRIALS || process.argv[2] || 3);
const report = await paid_measureTriggerRate({ …spec…, trials });
console.log(formatTriggerRateReport(report));
if (report.n === 0) throw new Error("no runs executed");
assertRates(report, { min: 0.8 });
```

with

```js
export default defineEval({
  measureTriggerRate: { …spec…, trials: 3 },
  assert: (report) => assertRates(report, { min: 0.8 }),
});
```

— dropping the `vigiles/eval` import, the trials line, the `format…` print and
the `report.n === 0` check, because the runner now does all four. The key is the
runner's own name (`runEval` · `measure` · `measureArms` · `measureTriggerRate` ·
`paid_measureSelectionMatrix`); declare exactly one. A capability probe that used to
sit at the top of the file becomes `skipIf()`. `paid_measureSelectionMatrix`'s
directory argument becomes a `pluginDir` field, and
`measureTriggerRate(spec, { evalDriver })`'s second argument becomes a top-level
`evalDriver` key. Run with `vigiles eval x.eval.mjs`; a file left on the old
shape fails with a message naming this section, never silently.

All 19 eval files in this repository were migrated in the same change.

A skip is **loud** (`⊘ SKIPPED`, tallied separately), never a silent green; pass
`--no-skip` in a job that asserts the capability is present.

So is a file that **verified nothing**: a script that exits clean having recorded
**zero** checks reports `∅ … 0 CHECKS`, tallied separately from `passed`. The
shape this catches is a harness that _defines_ tests and never calls them —

```js
export default { "never runs": () => assert.equal(1, 2) }; // exits 0, asserts nothing
```

— which an exit code alone cannot tell from a real pass. The tiers (`runHook`,
`runHarnessTest`, `runEval`, the in-process compiled-hook assertions) count
themselves, so an ordinary harness needs no extra call; if yours asserts some
other way, `recordCheck()` from `vigiles` reports those. It is **not** a
failure — it never turns a build red — and a script that doesn't import
`vigiles` cannot report at all, so it stays a plain pass.

**The composite action** encapsulates the per-tier setup (bubblewrap, the egress
connector) so you don't re-derive it:

```yaml
- uses: actions/checkout@v4
- uses: zernie/vigiles/.github/actions/harness-tier@main
  with: { tier: unit } # or: integration (adds bwrap + CLI) / e2e (adds egress)
```

The **eval** axis is separate: real-model evals run **locally on your
subscription** (`vigiles eval --update`), not on every PR. What CI runs is the
deterministic [staleness gate](#keep-eval-results-fresh-in-ci-the-lock) —
`vigiles eval --check` (or `command: eval-check`) — which verifies your committed
eval results with no model.

## What's covered today

How far each tier reaches, by surface (Claude Code, the reference adapter):

| Surface                                               | Unit / static                | Integration (no key)        | Eval (real model) |
| ----------------------------------------------------- | ---------------------------- | --------------------------- | ----------------- |
| Hooks — Bash / SessionStart / Stop / UserPromptSubmit | ✅ logic                     | ✅ fires                    | ✅                |
| Hooks — Edit / Write                                  | ✅ logic                     | ✅ fires                    | ✅                |
| Hooks — PreCompact / Notification / SessionEnd        | ✅ logic                     | — (mock can't trigger)      | 🟡                |
| Instruction file (CLAUDE.md / AGENTS.md)              | ✅ refs                      | 🟡 present, not behaviour   | ✅ behaviour      |
| Skills                                                | ✅ loads + description       | ✅ resolves via `pluginDir` | ✅ activation     |
| Subagents (`agents/`)                                 | ✅ tool rail                 | 🟡 rail not live-armed      | ✅ via Task       |
| MCP servers                                           | ✅ tool refs (`vigiles:mcp`) | 🔴                          | 🔴                |
| settings.json                                         | 🟡 assert merged             | ✅ applied                  | ✅                |

✅ shipped · 🟡 partial · 🔴 gap · — n/a.

## How vigiles compares

The eval ecosystem — [promptfoo](https://github.com/promptfoo/promptfoo),
DeepEval, Braintrust, Inspect — evaluates a **model/agent on a dataset**. vigiles
tests **the harness** (your hooks / settings / instruction file / skills, loaded
exactly as they ship), and is built to be deterministic and cheap where those
tools are real-model-only.

The difference is **cost by construction**: every one of their runs is a real
model call by design; vigiles answers most harness questions — does this hook
block? is it wired in? does the skill resolve? — with no model and no key at all,
paying for a real model only at the eval tier.

## Runnable examples

- [`hook-unit.harness.mjs`](../examples/harness/hook-unit.harness.mjs) — `runHook`, no harness CLI (the cheap base).
- [`policy-gate.harness.mjs`](../examples/harness/policy-gate.harness.mjs) — a PreToolUse Bash gate + SessionStart setup, deterministic.
- [`plugin-cohesion.harness.mjs`](../examples/harness/plugin-cohesion.harness.mjs) — load a whole plugin, assert multiple hooks fire together.
- [`railway-result.harness.mjs`](../examples/harness/railway-result.harness.mjs) — assert a subagent's typed outcome (`experimental_assertAgentOk`/`Err`/`Result`), deterministic, no key.
- [`effect-boundary.harness.mjs`](../examples/harness/effect-boundary.harness.mjs) — assert a unit stayed inside its declared write surface (`check.writes` / `check.tool(…, { max: 0 })`), deterministic, no key.
- [`skill-trigger-rate.eval.mjs`](../examples/harness/skill-trigger-rate.eval.mjs) — does a skill's description _fire_? (`measureTriggerRate`)
- [`skill-outcome.eval.mjs`](../examples/harness/skill-outcome.eval.mjs) — does a skill change the agent's output?

## Per-harness guides

The runners are harness-agnostic; the transport (mock wire format, plugin layout,
sandbox) is per-harness. Pick yours:

- **[Claude Code](harness-testing-claude-code.md)** — the default adapter: the
  oh-my-claudecode walkthrough, `${CLAUDE_PLUGIN_ROOT}` / `hooks.json` /
  `pluginDir` / the `Skill` tool, the Anthropic Messages mock, the sandbox.
- **[Codex](harness-testing-codex.md)** — driving real `codex exec` against the
  OpenAI Responses mock, keyless; what maps and what doesn't.

## See also

- [API by entry](api/README.md) — one page per package entry: what each name is for, typical calls, every export.
- [Testing API overview](testing-api.md) — picking a runner, the `Trace` model, imports, and the migration tables.
- [Testing output styles](testing-output-styles.md) — the three tiers for a style, `replies`, and the per-harness table.
- [API reference (generated)](https://zernie.github.io/vigiles/api/) — the exhaustive symbol-level reference for every entry point, incl. the `vigiles` root and `vigiles/eval`.
- [Compiled hooks](compiled-hooks.md) — author a hook that can't be wrong (a pure typed function vigiles compiles); the gate instrument beside these test tiers.
- [Verifying your instruction files](verifying-instruction-files.md) — the linting layer.
- [`docs/harnesses.md`](harnesses.md) — how you pick a harness (by import) + the capability matrix.
- [`docs/sandboxing.md`](sandboxing.md) — what the sandbox isolates vs records.
- [`docs/testing-matrix.md`](testing-matrix.md) — every use case mapped to its tier + file.
- [`railway-subagents.md`](railway-subagents.md) — the railway/Result subagent contract end to end (typed outcome, compose flat workers, assert deterministically).
