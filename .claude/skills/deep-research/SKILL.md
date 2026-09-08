---
name: deep-research
description: Use when the user asks to research a topic in depth, map a competitive/market landscape, run a multi-source investigation, or "fan out" parallel research agents — anything where many findings must be gathered and then NOT lost. Enforces durable, detail-preserving research (write full findings to disk; keep a full appendix beside the synthesis).
disable-model-invocation: true
---

# Deep research — gather wide, lose nothing

The failure mode this skill exists to prevent: a big parallel research fan-out gathers
80–100K tokens of detail, each subagent returns a **trimmed summary**, the orchestrator
**compresses again** into a short brief, and the **raw findings live only in ephemeral
agent transcripts** (scratchpad task outputs) that vanish when the container is reclaimed.
Net: expensive research → a thin artifact, detail gone. Don't do that.

## The rule: two durable artifacts, never just one

Every nontrivial research effort produces, and SAVES to disk:

1. **A synthesis** — the brief / answer (tables, thesis, recommendation).
2. **A full appendix** — the per-source / per-company / per-angle DETAIL (raw numbers,
   funding histories, surfaces, dates, **verbatim source URLs**) the synthesis compressed.

If the saved synthesis is dramatically smaller than what was gathered, the appendix is how
you reconcile that — the detail must land **somewhere durable**, not only in chat or a
transcript. "I summarized it in chat" is not saved.

## Running a fan-out

1. **Plan the angles** — one subagent per distinct angle (company, source class, sub-question).
   Tell the user which model each runs on and why (the subagent-model-note rule).
2. **Mandate write-to-disk in the subagent prompt.** Every research subagent must WRITE its
   full findings to a durable file (e.g. the session scratchpad dir, one file per angle)
   **with sources verbatim**, and return only a short pointer + the headline findings. Do
   NOT rely on the agent's returned summary as the record — it is trimmed by construction
   and its transcript is ephemeral.
3. **Capture sources verbatim** — every claim carries [number] [source URL] [date]
   [reported vs estimate]. URLs are the first thing lost in compression; keep them.
4. **Synthesize from the files, not from memory** — read back the written files to build
   the synthesis, so nothing silently drops.
5. **Save both artifacts before declaring done** — commit/write the synthesis AND the
   appendix. Then it's saved.

## Where to save

- **Technical research about shipped behaviour** → a `docs/` page if a user needs it to
  act, otherwise a contributor note cited from `CLAUDE.md` keyFiles so it isn't an orphan
  doc. Which tier is decided by `public-vs-internal-docs` and `doc-tiers`.
- **Competitive, market, pricing, go-to-market or roadmap research** → **not into this
  repository, in any directory.** This repo is public and `no-product-strategy-here` is
  unconditional: a deleted file stays in history and on other branches. Hand the findings
  back in the answer and let the human place them somewhere private.
- When in doubt which, ask — but never let "unsure where" become "saved nowhere."

## Don't

- Don't present a one-paragraph chat summary as the deliverable for a 15-agent fan-out.
- Don't trim sources/URLs/dates to make the brief shorter — that detail goes in the appendix.
- Don't leave the only full copy in an ephemeral transcript or scratchpad you didn't commit.

<!-- vigiles:ignore-test — project-local workflow skill, not a shipped vigiles surface -->
