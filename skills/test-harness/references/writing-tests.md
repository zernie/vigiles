# Writing the test for the chosen tier

Read this once the tier is picked. Covers the per-tier skeleton and the one
mistake that silently swallows failures.

## Write the test for the chosen tier

**Unit (`runHook`)** — hand a hook a synthesized event, assert the decision:

```ts
import { runHook, assertHookBlocked } from "vigiles";

const r = runHook(hookCommand, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git commit --no-verify" },
});
assertHookBlocked(r); // exit 2 / decision:"block" / permissionDecision:"deny"
```

Testing a hook you didn't write (a vendored third-party script)? Mark it
`{ trusted: false }` and it runs confined under bubblewrap by default (read-only
host, cleared env, no network egress). Add `{ recordEgress: true }` to also
**record** what it tries to reach — `r.egress` plus `assertNoEgress(r)` /
`assertEgressOnly(r, [...])` — the supply-chain check for "what does this skill
phone home to / install from?". When the hook's setup needs a _real_ install,
`{ egress: { allow: ["registry.npmjs.org"] } }` lets it reach only that
allowlist (a packet-layer `nft` wall, so a raw socket off-list is dropped too) →
`r.egress` (allowed hosts) + `r.egressDropped`. Be precise about the boundaries:
see
[`docs/sandboxing.md`](../../docs/sandboxing.md) (it blocks destruction and
egress, but does NOT isolate reads of host files, and only under bwrap).

**Deterministic (`runHarnessTest`)** — load the real plugin, drive a scripted
mock model, assert the hook fired (or the context landed):

```ts
import {
  runHarnessTest,
  assertHookFired,
  assertRequestContains,
} from "vigiles";
// `scriptModel` is the Claude-Code TRANSPORT, deliberately not re-exported from
// the harness-agnostic root surface — import it from the harness package:
import { scriptModel } from "vigiles/claude-code";

const r = await runHarnessTest({
  pluginDir: "./", // or { settings: { hooks: {...} } }
  transcript: true,
  model: scriptModel([{ text: "ok" }]),
});
assertHookFired(r, "SessionStart");
assertRequestContains(r, "expected injected text"); // did it actually land?
```

**Eval — absolute (`paid_measure` + `paid_judged`)** — testing _one_ skill, the usual case:
score its output directly against a rubric. No on/off baseline — this is the
"is it any good?" oracle (what promptfoo/DeepEval lead with), and the right
default when there's nothing to compare against:

An eval file **describes** its eval — it must never run one at the top level,
because importing such a file spends real money. Write `<name>.eval.mjs`:

```ts
import { defineEval, skill, assertRates } from "vigiles";
import { paid_judged } from "vigiles/eval"; // a Check whose default judge bills

export default defineEval({
  measure: {
    pluginDir: "./",
    task: "…a task the skill should handle…",
    checks: [
      skill("my-plugin:my-skill"), // it fired
      paid_judged("the answer correctly does X and avoids Y"), // …and the output is good
    ],
    trials: 6,
  },
  assert: (report) => assertRates(report, { min: 0.8 }), // each check ≥ 80% of trials
});
```

Run it with `npx vigiles eval <file>` — never `node <file>`, which refuses.

**Eval — relative (`paid_runEval` + `assertSignificant`)** — when the question is
_lift over no-skill_ (regression, or proving a change isn't noise): A/B the
change on vs off and gate on significance, not eyeballing:

```ts
import { defineEval, assertSignificant } from "vigiles";

export default defineEval({
  runEval: {
    env: { kind: "ephemeral" }, // required: a throwaway HOME, or { kind: "inherit", reason }
    arms: { off: {}, on: { pluginDir: "./" } },
    task: "…a task the harness change should affect…",
    measure: (ctx) => ({ ok: /* a bare predicate over the trace */ true }),
    trials: 6,
    cache: "readwrite",
  },
  assert: (report) =>
    assertSignificant(report, { baseline: "off", arm: "on", metric: "ok" }),
});
```

### Never hand-roll the runner — it silently eats stderr

Do **not** reach for `execFileSync` / `spawnSync` to drive the thing under test.
The failure is quiet and repeats: `execFileSync` returns **stdout only** on
success, while advisory output — including vigiles's own compiled-hook
`notice()` — is written to **stderr**. A hand-rolled runner therefore reports a
perfectly healthy react hook as **dead**, and an assertion about a warning can
never pass. (Observed three times in one repo, twice after the first fix.)

Every vigiles result already carries **both streams**, so the bug is
unrepresentable:

| Runner           | Result              | Carries                                             |
| ---------------- | ------------------- | --------------------------------------------------- |
| `runScript`      | `ScriptRunResult`   | `exitCode`, `stdout`, `stderr`, `filesWritten?`     |
| `runHook`        | `HookRunResult`     | all of the above, **plus** `blocked` / `decision`   |
| `runHarnessTest` | `HarnessTestResult` | `exitCode`, `stdout`, `stderr`, `cwd` + the `Trace` |

**Testing a plain helper script** (a bash/node/python program that isn't a hook)?
Use **`runScript`** — it runs any command and reports what it did:

```ts
import { runScript } from "vigiles";

const r = runScript("bash scripts/check-links.sh", { cwd: repoDir });
assert.equal(r.exitCode, 0);
assert.match(r.stderr, /0 broken links/); // advisory output lives HERE
```

`runHook` is exactly `runScript` plus the hook protocol (event → stdin, exit code
→ allow/deny). Pick by the question you're asking: a **hook** has a _decision_, a
**script** has _effects_. That's why `ScriptRunResult` has no `decision` field —
a field that is always meaningless is worse than no field.

⚠️ **Asserting what a script wrote requires confinement.** `filesWritten` is
recorded by diffing the work dir, which only a confined run does — so it is
`undefined` after a plain run. That is deliberately _not_ the same as `[]`
("recorded, wrote nothing"): `assertNoWrite` / `assertWroteOnly` **throw** on an
unrecorded result rather than pass having inspected nothing. Pass
`{ sandbox: "auto" }` (Linux + bubblewrap) to actually record writes.
