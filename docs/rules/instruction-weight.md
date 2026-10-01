# instruction-weight

Fail when the instructions the harness loads **without being asked** get
heavier than the weight the repository last recorded. A **ratchet**: the
baseline is the repo's own past, committed in `.vigiles/instruction-weight.json`,
so a repo already several times over the harness's budget starts green and
stays green only while it does not grow. Same measurement `vigiles audit`
prints as `Always-loaded instructions`; the comparison is `compareToBaseline` in
`src/core/instruction-baseline.ts`.

## What it measures

The **sum** of everything loaded at launch that a teammate on the same commit
also loads — the instruction file, its imports, an always-loaded rules
directory (Claude Code's `.claude/rules/*.md` without `paths:`), in the
harness's own unit: **characters** for Claude Code, **bytes** for Codex.

Not counted: files loaded on demand (`paths:`-scoped rules, nested `CLAUDE.md`
files), files removed by the repo's committed `claudeMdExcludes`, and
per-machine files (`CLAUDE.local.md`, a gitignored settings sibling). That last
exclusion is what makes the number the same on every clone of a commit, and so
comparable in CI.

**Moving text does not help.** Cutting a section out of `CLAUDE.md` into an
always-loaded rules file leaves the sum unchanged, and the rule says `held`.
A per-file limit would have scored that move as a large improvement.

## What it reports

| state                                  | result                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| no baseline file                       | a one-line note naming the command to start; **never a finding**   |
| weight equals the baseline             | `✓ … held at N chars`                                              |
| weight **grew**                        | finding: the delta and every file that moved                       |
| weight **shrank**                      | finding: lock the cut in, or the headroom can be regrown unnoticed |
| baseline recorded in another unit      | finding: re-record (the repo changed harness)                      |
| baseline file exists, bundle not in it | finding: weight nobody recorded                                    |
| baseline file is not valid             | finding; never read as empty                                       |

```
✗ always-loaded instructions grew 30,000 → 31,225 chars (+1,225) over the
  recorded baseline. Changed: .claude/rules/moved.md +11,225 (new), CLAUDE.md
  -10,000. If the growth is intended, record it with
  `vigiles lint --update-baseline` — the diff of .vigiles/instruction-weight.json
  is the review.
```

A shrink is a finding for the same reason as ESLint's unpruned suppressions and
`betterer ci`: a baseline above the tree is headroom, and every character up to
the old number would pass. Recording the cut in the same change keeps the
baseline equal to the tree, so any growth at all shows up.

## Recording the baseline

```bash
npx vigiles lint --update-baseline
git add .vigiles/instruction-weight.json
```

`lint` never writes the file on its own — a read never writes. The flag is the
only writer, the same shape as `eslint --suppress-all` and `jest -u`. Raising
the baseline is allowed: growth is not forbidden, it becomes a reviewed diff of
a committed file instead of passing in silence.

`vigiles compile` prints the weight after it writes, against the baseline, so
the author sees the effect at the moment of change:

```
always-loaded: 28,210 chars (baseline 30,000, -1,790)
```

## The file

```json
{
  "version": 1,
  "bundles": {
    ".": {
      "unit": "chars",
      "total": 30000,
      "files": {
        "CLAUDE.md": 30000
      }
    }
  }
}
```

One entry per scored bundle (`.` is the root; `--bundles=all` adds nested
ones). `files` names where the weight is, so a message can say which file grew;
the verdict is decided on `total`, which must equal the sum of `files`. Keys are
sorted and there is no timestamp, so the diff shows only real movement.

**Committed, unlike `.vigiles/coverage.json`.** Coverage records what ran on one
machine; this records a property of the commit, computed only from committed
files.

## Configuration

```json
{ "rules": { "instruction-weight": "error" } }
```

| Value               | Behavior                                                      |
| ------------------- | ------------------------------------------------------------- |
| `"error"` (default) | `vigiles lint` exits 2 when the weight moved off the baseline |
| `"warn"`            | Prints the finding, exits 0                                   |
| `false`             | Skip the check                                                |

On by default because a repo with no baseline file gets a note and nothing
else: committing the file is the opt-in.

## Why not a fixed budget

The harness's own threshold (40 000 characters for Claude Code, 32 KiB for
Codex) is reported by `vigiles audit`, but it cannot gate: measured repos sit
several times over it, and a check that fails every repo on day one is switched
off on day one. A ceiling on each rule's length fails the same way — and
rewards splitting text into more files, which costs exactly as much. The
repository's own recorded sum is the one number that is green on day one and
still catches the regrowth.

## See also

- [`vigiles audit`](../cli.md) — the full weight report: per-file sizes, the
  budget, and what the harness does when over it.
- [skill-description-budget](skill-description-budget.md) — a per-description
  length heuristic for skills.
