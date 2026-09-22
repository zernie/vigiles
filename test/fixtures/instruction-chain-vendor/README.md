# Vendor observations behind the Claude Code instruction chain

Two lines in `src/adapters/claude-code/instruction-chain.ts` rest on what the
real harness does rather than on what its documentation says, because in both
places the documentation composes two of its own rules and never says what
happens when they meet. These are the fixtures that answered it, the runner
that re-answers it, and the transcript of the run the source cites.

```
./measure.sh            # all cases
./measure.sh c1 c2      # or just these
```

Needs the vendor CLI on `PATH`; each case costs one short non-interactive turn.

## What was observed — Claude Code 2.1.278, 2026-09-22

| case        | files                                         | settings                                | recited       | hook logged                                              |
| ----------- | --------------------------------------------- | --------------------------------------- | ------------- | -------------------------------------------------------- |
| `c0`        | `CLAUDE.md`(ALPHA) `AGENTS.md`(BETA)          | —                                       | **ALPHA**     | `CLAUDE.md`                                              |
| `c2`        | `AGENTS.md`(BETA)                             | —                                       | **BETA**      | _nothing_                                                |
| `c1`        | both                                          | `claudeMdExcludes: ["**/CLAUDE.md"]`    | **BETA**      | _nothing_                                                |
| `c1-probe`  | both + `.claude/rules/probe.md`(ZETA)         | same as `c1`                            | **BETA ZETA** | `.claude/rules/probe.md`                                 |
| `c3`        | both + `.claude/CLAUDE.md`(GAMMA)             | `claudeMdExcludes: ["**/c3/CLAUDE.md"]` | **GAMMA**     | `.claude/CLAUDE.md`                                      |
| `q2-import` | `CLAUDE.md` importing `@pkg/CLAUDE.md`(DELTA) | —                                       | **DELTA**     | `CLAUDE.md`, then `pkg/CLAUDE.md` `load_reason: include` |

Reading it:

- `c0` is the control for supersede itself. ALPHA alone means a `CLAUDE.md`
  does turn `AGENTS.md` off, so `c1` is a comparison and not a lone data point.
- **`c1` is the finding.** BETA and no ALPHA: with the `CLAUDE.md` excluded,
  the `AGENTS.md` **loads**. `supersederOf` therefore asks whether a candidate
  is present _and not excluded_.
- **`c3` fixes the shape of that fix.** GAMMA alone: a _surviving_ candidate
  still supersedes, so the answer is a predicate over candidates, not a bypass
  that drops supersede whenever anything is excluded. It is also why the
  directory name matters — see the warning in `measure.sh`.
- **`q2-import` is the second finding.** An imported subdirectory instruction
  file loads at session start, with the reason the vendor names. It is why the
  chain's subdirectory pass runs _after_ the imports pass rather than before.

## 🔴 The instrument that looks right and is blind

An `InstructionsLoaded` hook is the obvious tool here, and on the file this
whole set is about it reports nothing: `c2` holds only an `AGENTS.md`, plainly
loads it — the model recites BETA — and the hook stays silent.

So hook silence is not evidence. Read on the hook alone, `c1` says "nothing
loaded" and the conclusion reverses. `c1-probe` is what separates the two
readings: the same exclusion, plus a `.claude/rules/` file that must load
regardless. The hook fires for the rule file, so it is alive — and still says
nothing about the `AGENTS.md` beside it.

The runner therefore reports BOTH instruments for every case, and `c2` stays
in the set as the one that tells them apart.

## What these do NOT settle

- **One build.** The vendor reversed a neighbouring fact (`AGENTS.md`
  auto-load) at v2.1.277, so the version is part of every claim above.
- **The canary proves the text reached the model, not which mechanism put it
  there.** Tools are denied on the canary turn, which rules out the model
  going to read the file; it does not distinguish, say, an import from a root
  load. That is what the hook is for on the cases where the hook can see.
- **Mode.** All runs are the default `claude-md-or-agents-md`. The setting is
  not readable from a project, so a repository scan cannot confirm it — the
  limit is restated at `supersederOf`.
