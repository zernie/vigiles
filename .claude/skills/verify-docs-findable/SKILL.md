---
name: verify-docs-findable
description: Audit whether a repo's docs actually ANSWER the questions a reader has — by spawning fresh, cheap (Haiku) agents that cold-read ONLY the docs and measuring how fast they reach the answer, whether they hit dead-ends, whether they fall back to source code, and whether they cite docs that contradict each other. Use after a doc reorg, when docs "feel scattered," or when the same confusion keeps recurring. Surfaces findability gaps (a corpus can be COMPLETE — every doc indexed — yet not FINDABLE) plus a prioritized fix list. Works on any repo's docs, not just this one.
disable-model-invocation: true
argument-hint:
  [optional: a question, or "auto" to derive from recent confusions]
---

# verify-docs-findable — cold-read the docs with fresh eyes

The insight this operationalizes: **complete ≠ findable.** An index that lists every doc
(and even passes a "every doc is indexed" check) can still make a reader take 5 hops and
fall back to source code to answer a basic question. The only honest test is to give the
question to someone who has never seen the repo and watch how far they get **from the docs
alone.** A fresh cheap agent is that someone.

## Why HAIKU, and why "docs only"

- **Haiku (a small, cheap model), fresh (no session context).** The point is a naive cold
  reader, NOT a clever one. A strong model with your context will grep the source, reason
  around gaps, and _hide_ the doc problem. Haiku, told to use only the docs, exposes it.
- **"Use ONLY the docs, start at the index."** The moment a verifier has to open source code
  to answer, the docs have failed — that's the signal. Steps-from-index is the metric.

## Procedure

### 1. Get the questions (3–8)

Test the **recurring, load-bearing, and mis-stated** questions — the ones that actually cost
time. Sources, in order:

- What the user (or you) just got confused about this session — the highest-signal source.
- The "canonical answers" the docs _claim_ to provide (a docs corpus usually has ~5–8 facts
  it exists to convey; test those).
- If none given: ask the user for the questions, or infer them from the corpus's top-level
  topics. Don't invent trivia — test what a real contributor needs.

Phrase each as a **real question a reader would ask**, not a doc title.

### 2. Spawn one fresh Haiku verifier per question (in parallel)

Use the Agent tool with `model: "haiku"`, `run_in_background: true`, one per question. Give
each the SAME strict template (fill in `<QUESTION>`):

> You are a fresh engineer opening `<repo path>` for the first time. Answer using ONLY the
> repo's docs — START at the index (`<the index file(s)>`) and follow pointers; prefer docs
> over reading source code.
> QUESTION: `<QUESTION>`
> REPORT: (a) your answer; (b) the exact file(s) where you found it; (c) how many steps from
> the index (did a pointer take you straight there, or did you dig?); (d) clear/unambiguous
> or scattered/confusing? (e) did you have to read source code because the docs didn't say?
> Be honest — this tests whether the docs make this findable.

Run all in one message so they go concurrently. (Haiku + parallel = the audit is cheap.)

### 3. Score each answer

| Signal                  | Good                 | Gap                                                                     |
| ----------------------- | -------------------- | ----------------------------------------------------------------------- |
| **Correct?**            | matches ground truth | wrong/partial → the doc is wrong or missing                             |
| **Steps from index**    | 1–2                  | 3+ → no signposted pointer                                              |
| **Dead-ends**           | none                 | landed on a wrong-but-plausible doc first → title/scoping is misleading |
| **Needed source code?** | no                   | yes → the docs don't actually state it                                  |
| **Contradictions**      | —                    | cited two docs that disagree → a cohesion bug (fix immediately)         |

Verifiers surface contradictions **for free** — a cold reader citing two docs that say
different things is the cheapest contradiction-finder you have.

### 4. Fix the gaps

- **3+ steps / dead-end** → add a **question→doc pointer** at the index entry point (a
  "Canonical answers: question → the ONE doc" block). Naming the answer is what turns 5 hops
  into 1.
- **Needed source code** → the fact isn't in prose; write it into the one canonical doc.
- **Wrong answer** → the doc is stale/incorrect; fix it (append-don't-erase if it records a
  decision).
- **Contradiction** → reconcile the docs; keep the historical decision, mark it superseded.
- **Scattered across N docs** → consolidate into ONE doc per question; make the others point
  to it.

### 5. Re-verify (measure, don't assume)

Re-run the **worst** question(s) against the fixed docs. Confirm the number moved (e.g.
5 steps → 2). A fix you didn't re-measure is a guess.

## Output

A short findability scorecard (question | correct | steps | needed-source | verdict) + a
prioritized fix list. Report the before/after on any question you fixed and re-verified.

## Notes

- This is orthogonal to "is every doc indexed?" completeness checks — it measures the layer
  above: can a stranger _reach_ the answer. Run it after any doc reorganization.
- Keep the question set in the repo (e.g. a `docs-findability-questions.md`) so the audit is
  repeatable and the canonical answers stay honest as the corpus grows.
- Scales down (1 question, 1 agent, to spot-check one fix) and up (the full canonical set).
