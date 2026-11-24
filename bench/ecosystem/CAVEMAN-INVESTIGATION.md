<!-- vigiles:ignore-file -->

# Caveman benchmark — the investigation record

The full research trail behind the corrected caveman measurement (the numbers live in
[`FINDINGS.md`](./FINDINGS.md); the raw data + Welch/cost-share snapshot in
[`results-archive/`](./results-archive/)). This file is the _narrative_: what we set out to
measure, the bug that invalidated the first pass, how it was caught, and the corrected result.
It exists so the next person doesn't re-derive any of it.

## The question

Two of the most-starred "token-saving" skills for Claude Code claim big cuts: **Caveman**
(~84k★, README "65% output-token cut" by writing telegraphically) and a **token-efficient
CLAUDE.md** (~5.7k★, "63%"). Do those claims survive a real, multi-turn coding session measured
in **dollars** (not output-token count), with a **correctness** gate?

## The bug that invalidated pass 1

The first run delivered caveman as a bare `SKILL.md` written into the run's cwd (an eval arm's
`files`). **Claude Code never registers a bare `SKILL.md` as a skill** — skills load only from a
plugin (`--plugin-dir`) / `.claude/skills` layout, or via a hook that injects them. So the
"caveman" arm ran against an inert, unread file: it measured _nothing_, and the caveman numbers
(a noisy "−37% growth") were an artifact. The token-efficient arm was fine — it ships a
`CLAUDE.md`, which **does** auto-load as project memory. (That asymmetry is exactly why the bug
hid: one of the two arms was valid.)

**How it was caught.** An adversarial review (a `fable` agent asked to find the strongest attack a
reviewer would make) flagged, as its #1 finding, that a loose `SKILL.md` in cwd is not a Claude
Code surface and there was no activation check proving the skill was ever in context. Reading
caveman's own README confirmed the mechanism: on Claude Code it is **"on from message one, no
command needed,"** achieved by a **SessionStart hook** (`src/hooks/caveman-activate.js`) that reads
`SKILL.md` and injects the full ruleset as session context.

**The fix (both in the tool and the benchmark).**

- **vigiles** now warns when a run arm delivers a `SKILL.md` where it can't register
  (`unregisteredSkillFiles` in `src/eval.ts`, high-precision, tested) — the exact footgun, caught
  for anyone using the harness.
- **The benchmark** installs caveman the real way: a `--plugin-dir` plugin
  ([`skills/caveman-plugin/`](./skills/caveman-plugin/)) **with** a faithful reproduction of its
  SessionStart activation hook. Verified telegraphic (3.4 vs ~7–12 articles-per-100-words vs
  baseline) before trusting a single number.

## The corrected result (7 tasks × 5 trials, sonnet, faithful install)

- **Caveman genuinely cuts output** — mean ~6%, with two individually-significant task cuts
  (bugfix −31% p=.002, regex −28% p=.006). It is not vaporware.
- **But the bill is flat** — pooled dollars across the whole run move −1% (not significant),
  because output is only **~20% of the dollar bill** (measured: output tokens × $15 ÷ real
  `costUsd` = 19.9%; cache-read is 50× cheaper) and caveman's own +1–1.5k input tokens/turn eat
  the little it saves. A _perfect_ 65% output cut caps the bill saving at ~13%.
- **Token-efficient** grows output (−29%) and its bill runs **+10%** — the one result that
  reproduces cleanly across every run.
- **0 correctness regressions** anywhere.

## The fair companion: caveman's input tools

Caveman knows output is the small lever and ships input-side tools. We tested the strongest,
`/caveman-compress` (rewrites a memory file to cut input "every session after," claims ~46%). We
compressed a verbose `CLAUDE.md` **68%** (beating the claim), kept every rule, and A/B'd the same
task. **Result:** the file shrank 68%, but the session saw **no significant cost change** (cache
−2% p=.87, cost −14% p=.36) — a ~500-token memory file is a rounding error against a ~105k-token
session — and **no correctness cost** (rule-adherence 1.00 both ways). `caveman-shrink` (MCP
tool-definition compression) needs a live MCP server and was not tested. Same shape as the output
tool: a real cut of a small thing.

## Second adversarial pass + the reader panel

A 5-persona audience-test (mid-level dev, senior sharer, caveman power-user, curmudgeon, evals
expert) on the rewritten article returned a median ~55% front-page / +0.5 sentiment (a large
improvement over the pre-fix Run 1's "−1, eaten alive"). The evals expert caught one remaining
real flaw: the "~20% of the bill" figure read as a napkin derivation, but the naive model
(1% output / 99% cache-read) prices to ~34% — so it had to be stated as **measured** (it is
19.9% from the real cost data, lower than naive because real sessions also pay input +
cache-creation). Fixed. Full panel record: the article's `.audience-test-results.md` ledger (Run 3)
in the `zernie/zernie.github.com` repo.

## The lesson for vigiles

Never assume a skill was in context because a file was on disk. Verify activation — a
`check.skill` check, or a deterministic style marker (here: articles-per-100-words) — before
trusting a benchmark number. The tool now warns on the specific delivery footgun that caused this.
