# context-creep — keep the always-loaded context from growing

Context engineering starts with the part you pay for on every request: what the
harness loads **without being asked**. This rule fails when that gets heavier
than the weight the repository last recorded — context creep, one unremarkable
line at a time. A **ratchet**: the baseline is the repo's
own past, committed in `.vigiles/context-creep.json`, so a repo already
several times over the harness's budget starts green and stays green only while
it does not grow. Same measurement `vigiles audit` prints as
`Always-loaded instructions` and `always-loaded context`; the comparison is
`compareAlwaysLoadedToBaseline` in `src/core/instruction-baseline.ts`.

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

`.vigilesrc.json` `exclude` does **not** remove a file from this number:
`exclude` means "vigiles does not lint this", and the harness still loads it.
Use `claudeMdExcludes`, which is also what stops the harness loading it.
Line endings count as `\n`, so a CRLF checkout of the same commit weighs the
same. A rule's `paths:` scopes it only when it is a non-empty list of globs;
`paths: []` or a scalar leaves the rule always-loaded. Imports are read one hop
deep; any import the number does not include is listed on the line as
`N import(s) not followed`.

**Moving text does not help.** Cutting a section out of `CLAUDE.md` into an
always-loaded rules file leaves the sum unchanged, and the rule says `held`.
A per-file limit would have scored that move as a large improvement.

### The always-loaded context: output style and skill listing

Two more things load at session start before any decision, and the rule counts
them once you record them:

- **the output style** your committed settings select, when the repository
  holds it as a file — its body, frontmatter removed;
- **the skill listing** — one entry per skill in the folder a session at the
  repository root loads (Claude Code: one folder per skill; Codex: the folder
  walked up to six directories deep, `.`-folders skipped), rendered the way the harness renders it, with its
  per-entry cap (Claude Code `- dir: description - when_to_use`, with `<`
  and `>` escaped as `&lt;`/`&gt;` and the text cut to 1,536 characters or
  `skillListingMaxDescChars`; Codex `- name: description (file: path)`, the
  description cut to 1,024, and a skill Codex cannot parse — no frontmatter,
  no description — not listed). A skill folder that is a symlink counts like
  a real one — that is how `vigiles init` installs skills. A link back to a
  folder that contains it (a cycle) is not followed.

Together with the instructions this is the **always-loaded context**. The rule gates
its **sum**, so moving a section from `CLAUDE.md` into the selected style, or
into a skill's description, still reads `held` — and the line under the verdict
says where the weight moved:

```
✓ always-loaded context held at 38,062 chars (baseline)
  instructions 20,000 (-4,665) · output style 13,031 (+4,665) · skill listing 5,031
```

Not counted: a style selected only in a per-machine settings file, a selected
name no repository style declares (named in `audit`, size unknown), a plugin's
own `skills/` folder (its users load it, not a session here), user-level and
plugin skills, and the listing's overall budget — a share of the model's
context window, which depends on the model and is not a property of a commit.
Codex has no output styles; its part is `not-supported`, never written.

## What it reports

| state                                                                                                                      | result                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| no baseline file                                                                                                           | a one-line note naming the command to start; **never a finding**                                          |
| weight equals the baseline                                                                                                 | `✓ … held at N chars`                                                                                     |
| weight **grew**                                                                                                            | finding: the delta and every file that moved                                                              |
| weight **shrank**                                                                                                          | finding: lock the cut in, or the headroom can be regrown unnoticed                                        |
| baseline recorded by another measurement                                                                                   | finding: vigiles changed what counts — re-record, not a change in your files                              |
| baseline recorded in another unit                                                                                          | finding: re-record (the repo changed harness)                                                             |
| baseline file exists, bundle not in it                                                                                     | finding: weight nobody recorded                                                                           |
| baseline file is not valid                                                                                                 | finding; never read as empty                                                                              |
| version-1 file, output style or listing not empty                                                                          | a note per bundle naming each part; **never a finding** — the instructions still gate as before           |
| version-2 file, a part grew or appeared                                                                                    | finding: the always-loaded sum grew, and which part's file moved                                          |
| version-2 file, a part recorded by another measurement                                                                     | finding: re-record, naming the part                                                                       |
| version-2 file, a recorded part this run cannot measure (the adapter does not model it, or the selected style has no file) | carried at its recorded size and named on the line; never read as 0, never dropped by `--update-baseline` |

```
✗ always-loaded instructions grew 30,000 → 31,225 chars (+1,225) over the
  recorded baseline. Changed: .claude/rules/moved.md +11,225 (new), CLAUDE.md
  -10,000. If the growth is intended, record it with
  `vigiles lint --update-baseline` — the diff of .vigiles/context-creep.json
  is the review.
```

A shrink is a finding for the same reason as ESLint's unpruned suppressions and
`betterer ci`: a baseline above the tree is headroom, and every character up to
the old number would pass. Recording the cut in the same change keeps the
baseline equal to the tree, so any growth at all shows up.

## Recording the baseline

```bash
npx vigiles lint --update-baseline
git add .vigiles/context-creep.json
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

Once the always-loaded context is recorded the line names it instead:
`always loaded: 38,062 chars (baseline 38,062, ±0)`.

## The file

```json
{
  "version": 1,
  "bundles": {
    ".": {
      "unit": "chars",
      "measure": 1,
      "total": 30000,
      "files": {
        "CLAUDE.md": 30000
      }
    }
  }
}
```

A repository whose output style or skill listing is not empty gets a
**version 2** file, where each entry also carries `parts`:

```json
{
  "version": 2,
  "bundles": {
    ".": {
      "unit": "chars",
      "measure": 1,
      "total": 24665,
      "files": { "CLAUDE.md": 24665 },
      "parts": {
        "output-style": {
          "measure": 1,
          "total": 8366,
          "files": { ".claude/output-styles/terse.md": 8366 }
        },
        "skill-listing": {
          "measure": 1,
          "total": 5031,
          "files": { ".claude/skills/review/SKILL.md": 5031 }
        }
      }
    }
  }
}
```

`total` stays the instructions' own total; the verdict is decided on `total`
plus every part's `total`. A part whose total is 0 is not written. Each part has
its own `measure`, so a change to how one part is measured asks you to re-record
that part by name.

One entry per scored bundle (`.` is the root; `--bundles=all` adds nested
ones). `files` names where the weight is, so a message can say which file grew;
the verdict is decided on `total`, which must equal the sum of `files`. `measure` names the measurement that produced the number; a vigiles release that changes what counts bumps it, and the rule then asks for a re-record instead of reporting growth. Keys are
sorted and there is no timestamp, so the diff shows only real movement.

### Upgrading from a version-1 file

1. **Upgrade vigiles, change nothing else.** A version-1 file is read as
   before: the instructions gate exactly as they did, and each part that is
   not empty adds one **note** (`output style (8,366 chars) and skill listing
(5,031 chars) load at session start but are not in the baseline…`). Notes
   never count toward the exit code, so CI stays green.
2. **Upgrade vigiles wherever `lint` runs** — every CI job and every
   teammate's pinned version.
3. **Then record:** `npx vigiles lint --update-baseline` writes version 2, and
   from then on the gate is the sum.

The order matters because version 1 was a strict format: an **older vigiles
cannot read a version-2 file**. It reports
`.vigiles/context-creep.json cannot be read` — loud, never silent, but a
finding at the rule's severity. A repository with no output style and no listed
skill keeps writing version 1, which every release reads. A file that is
already version 2 stays version 2, even after its last skill or its style is
removed: re-adding one is then growth of the gated sum, not a note.

**Committed, unlike `.vigiles/coverage.json`.** Coverage records what ran on one
machine; this records a property of the commit, computed only from committed
files.

## The baseline file's old name

The rule was called `instruction-weight` and its baseline lived in
`.vigiles/instruction-weight.json`. The rule id is now `context-creep` and the
file `.vigiles/context-creep.json`. Nothing breaks on upgrade as far as the file
goes:

| On disk           | `lint` reads | And says (a note, never a finding, exit code untouched)               |
| ----------------- | ------------ | --------------------------------------------------------------------- |
| the new file only | the new file | nothing                                                               |
| the old file only | the old file | `git mv .vigiles/instruction-weight.json .vigiles/context-creep.json` |
| both              | the new file | the old one is stale: `git rm .vigiles/instruction-weight.json`       |
| neither           | nothing      | the usual "no baseline recorded" note                                 |

`--update-baseline` writes only the new path. `vigiles lint --summary` — the
line the shipped session-start hook injects into the agent — carries the same
note as one extra line while the old file exists, so the agent renames it.

A `.vigilesrc.json` that still names `rules.instruction-weight` is refused by
the strict config schema; rename the key to `context-creep`.

## Configuration

```json
{ "rules": { "context-creep": "error" } }
```

| Value               | Behavior                                                      |
| ------------------- | ------------------------------------------------------------- |
| `"error"` (default) | `vigiles lint` exits 2 when the weight moved off the baseline |
| `"warn"`            | Prints the finding, exits 0                                   |
| `false`             | Skip the check                                                |

On by default because a repo with no baseline file gets a note and nothing
else: committing the file is the opt-in.

### `max`: an opt-in absolute ceiling

```json
{ "rules": { "context-creep": ["error", { "max": 40000 }] } }
```

The ratchet only stops growth, so a repo four times over the harness's budget
stays green for as long as it does not get heavier. `max` is the way to say
"no further than this, whatever the baseline holds": a positive integer in the
harness's own unit (characters for Claude Code, bytes for Codex), checked against
the instructions' total, per bundle. It caps the instructions only — the output
style and the skill listing are gated by the ratchet, not by `max`.

- **Over `max`** → a finding at the rule's severity, independent of the baseline
  (it fires with no baseline file, and when the ratchet says `held`). It names
  the total, the max, how far over, and the largest files:

  ```
  ✗ always-loaded instructions are 157,814 chars, max 40,000 — 117,814 over.
    Largest: CLAUDE.md 120,300, .claude/rules/engineering.md 31,200. Cut
    content; moving text to another always-loaded file does not help, and
    re-recording the baseline does not lift the ceiling.
  ```

- **At or under `max`** → silent.
- **`vigiles lint --update-baseline` refuses** to record a baseline above `max`:
  it writes nothing and exits non-zero (even at `"warn"`), because re-recording
  is the one move that would otherwise loosen the ceiling.
- **Without `max`** the rule behaves exactly as described above; `max` is never
  on by default, for the reason in [Why not a fixed budget](#why-not-a-fixed-budget).

Use it once the content has been cut to a size you intend to keep: set `max` at
or just above today's number, so the ratchet keeps catching small regrowth and
the ceiling catches the baseline being raised past it. `max` must be a positive
integer; `0`, a fraction, or a string is a config error.

## Why not a fixed budget

`vigiles audit` reports the weight against a budget: 40 000 characters for
Claude Code, 32 KiB for Codex. For Codex that is the harness's own cut-off. For
Claude Code it is stricter than the harness on purpose. Claude Code warns when
one instruction file passes 5% of the model's context window in characters
(never below 40 000), or when all of them together pass 120 000 (or the
per-file limit, if higher), so on a 1M-token model a single file can reach
about 200 000 characters before any warning. vigiles keeps the floor, which
is Claude Code's threshold for a 200K-token window: every character is re-read
on each request, whatever the window. Still, the budget cannot gate: measured
repos sit several times over it, and a check that fails every repo on day one
is switched off on day one. A ceiling on each rule's length fails the same way — and
rewards splitting text into more files, which costs exactly as much. The
repository's own recorded sum is the one number that is green on day one and
still catches the regrowth.

## Known limits

### Codex lists a skill whose frontmatter has an unquoted colon

```yaml
---
name: deploy
description: Build for AWS: ECS
---
```

The second `: ` makes that `description` line invalid YAML.

- **Codex** repairs this one case: it quotes the value and parses the block
  again, so the skill is listed.
- **vigiles** does not repair it. It reads the frontmatter as invalid and
  leaves the skill out of the listing.

**Effect on the number:** for Codex, the skill listing is under-counted by that
skill's whole entry (`- deploy: Build for AWS: ECS (file: …)`), and so is the
always-loaded total.

**Fix:** quote the description. Both read it the same way then:

```yaml
description: "Build for AWS: ECS"
```

## See also

- [`vigiles audit`](../cli.md) — the full weight report: per-file sizes, the
  budget, and what the harness does when over it.
- [skill-description-budget](skill-description-budget.md) — a per-description
  length heuristic for skills.
