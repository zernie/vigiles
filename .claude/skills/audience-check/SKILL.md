---
name: audience-check
description: Read the README (or any front-door doc) through the eyes of several distinct audience personas and report what each would think, miss, or bounce on
disable-model-invocation: true
---

Re-read the README — or whichever front-door doc the user names — as **several
different readers in turn**, not as the author. The author knows what every line
means; a first-time reader does not. The job is to surface where a specific
audience gets confused, under-served, or bounces, and to propose concrete fixes.

This is an INTERNAL dev skill (not shipped to consumers). It complements the
`readme-brevity` and `docs-quality` rules: those govern length/polish; this checks
whether the content actually lands for who it's for.

## How to run it

1. **Read the target doc in full** (default: `README.md`; honor a path the user
   gives). Also skim the docs it links to, so "the README promises depth the doc
   doesn't deliver" is checkable.
2. **For each persona below, do a cold read** — adopt that reader's goals,
   vocabulary, and patience. Ask their questions, not yours.
3. **Produce the report** in the format at the end. Be specific: quote the exact
   line, name the exact fix. Vague notes ("could be clearer") are useless.

## The personas

Run all of these unless the user scopes to a subset.

### 1. Claude Code user (the primary audience)

Already lives in Claude Code; skimming on a laptop between tasks. Wants the WOW in
the first screen and a copy-paste install in seconds.

- Does the first screen land what vigiles does and why they'd care?
- Is the install path (`npx vigiles init`, the agent prompt) above the fold and
  obviously runnable?
- Does it speak their language (hooks, skills, CLAUDE.md, subagents) without
  over-explaining?

### 2. Codex user (the second-harness audience)

Uses OpenAI Codex / `AGENTS.md`, not Claude Code. Skeptical that this is "a Claude
thing."

- Is Codex support visible early, or buried/footnoted so they assume it's
  CC-only?
- Are the examples CC-only (CLAUDE.md, `claude` CLI) in a way that makes a Codex
  user feel like a second-class citizen?
- Would they know `vigiles/harness/codex` exists and what works vs. what's a documented
  follow-on?

### 3. Senior / staff engineer (the skeptic)

Scans for substance and differentiation in ~20 seconds; allergic to marketing
fluff. Will mentally compare to tools they know (promptfoo, ESLint, ast-grep).

- Is the differentiation concrete and credible, or hand-wavy? Does every
  load-bearing claim link to proof?
- Does the "deterministic, no API key / runs on your sub" cost angle come through
  as a real architectural fact, not a slogan?
- Anything that reads as overclaiming will cost trust — flag it.

### 4. Junior engineer (the newcomer)

New to agentic tooling; needs clarity, not jargon. Bounces on undefined terms.

- Which terms are used before they're defined (harness, eval, trigger-rate,
  subagent, dialect)?
- Is there a clear "what do I do first" path, or does it assume context they lack?

### 5. Engineering manager / decision-maker (adoption + ROI)

Won't run a command; deciding whether the team should adopt. Cares about cost,
risk, and effort.

- Is the cost story (free deterministic tiers, evals on the existing Claude sub
  vs. metered per-token competitors) legible to a non-runner?
- Is adoption framed as incremental/low-risk (start permissive, tighten later)?
- What's the "why now / why us" — is it answerable from the README alone?

### 6. QA / test engineer (the Test pillar)

Owns test infra; evaluates the testing story specifically.

- Does the **Test** pillar speak to them — `runHook`, `runHarnessTest`,
  `measureTriggerRate`, significance/regression gating — or is it all about
  linting?
- Is the deterministic-vs-real-model split clear (what runs in CI free vs. what
  needs a model)?
- Would they trust it next to promptfoo/DeepEval, and is the comparison honest?

## Output format

```
# README audience check — <file>

## <Persona> — verdict: ✅ lands / ⚠ rough / ✗ bounces
- **Reaction (cold read):** one or two sentences in this reader's voice.
- **Friction:** the specific line(s)/section(s) that confuse or under-serve them.
- **Fix:** the concrete change (move X above the fold, define Y on first use,
  link proof for claim Z, add a Codex example here).

… one block per persona …

## Cross-cutting patterns
The 2–4 issues that hurt MULTIPLE personas (these are the highest-leverage fixes).

## Ranked fixes
A short, ordered list — highest reader-impact first — each a one-line action.
```

Keep the report scannable and ACTIONABLE: every finding names a line and a fix.
Do not rewrite the README in place unless the user asks — this skill REPORTS;
applying the fixes is a separate, explicit step.
