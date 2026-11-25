# Honest expectations and cost

Read this before telling a user "we'll test it" — it fixes which bucket a surface
falls into (free / on your subscription / needs a container) and what to report
after a paid run.

## Set honest expectations (what's testable, and at what cost)

Be explicit with the user about which bucket each surface falls into — never let
"we'll test it" hide whether that's free, sub-priced, or needs a container. Every
surface sorts into one of three buckets:

- **A — Free & deterministic** (no model, runs in CI on every commit): a hook's
  block/allow decision (`runHook`), a tool-contract / "did NOT call the forbidden
  tool" check, structural facts (`vigiles audit`), and **record-replay** of any tool
  a skill shells out to (record the real result once, replay it via a PATH stub).
- **B — Model-gated, on your subscription** (real model, **no metered API**): does a
  skill's description **fire** (`measureTriggerRate`, recall + precision) **and**
  does its guidance actually **produce good output** (score it directly:
  `runEval({ checks: [judged(rubric)] })` + `assertRates` — the absolute oracle;
  use a `runEval` A/B on-vs-off only when you need the _relative_ lift). This is
  the half a **prose / guidance skill** lives in —
  its worth is behavioral, so only a model can judge it. That is **not** "uncovered"
  and **not** free: it's fully testable on the sub. State it that way.
- **C — Needs a real service** (a real browser / DB / redis / a11y runtime): vigiles
  **composes with a container** here; it does not fake real semantics. Name the
  service and hand off — don't pretend a cheap tier substitutes for it.

So a prose-skill library is roughly **~100% testable (some free, most on your sub),
~0% needs-a-container** — not "poorly covered." An accessibility/browser plugin is
the worst case, with a large bucket C. When you report coverage, give **two
numbers**: "% testable at all (free + sub)" vs "% that needs a container", and say
which surfaces are free vs sub-priced. The model-gated half is the **point** of the
eval pillar (affordable on the sub), not a gap — and testing a prose skill's
_behavior_ requires a real model for **everyone** (promptfoo, the SDKs, all of it);
vigiles just does it on your subscription instead of metered API.

### After a real-model run: TELL THE USER WHAT IT SPENT

Whenever you run a real-model eval (`runEval` / `measureTriggerRate`),
**surface the spend to the user in your reply** — don't let a paid run
be silent. `runEval` prints a cost block to stderr and every report carries `usage`
(`report.arms[*].usage`: `totalCostUsd` + token counts). Relay, in plain words:

- **tokens spent** and the **API-equivalent `$`** (`total_cost_usd` — what it _would_
  cost at metered API rates);
- **how it was billed** — "on your Claude subscription (**$0 metered**)" if you're
  logged in, or a **⚠ warning** if `ANTHROPIC_API_KEY` is set (that run was billed
  **per token** — tell them to unset it and `claude login` to run free).

We do **not** show "% of your subscription" — Anthropic doesn't expose a plan's
quota, so any percentage would be invented. Tokens + API-equivalent `$` + the
billed-to line is the honest, complete picture. Keep the user's cost visible, always.
