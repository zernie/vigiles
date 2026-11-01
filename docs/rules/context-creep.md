# context-creep — keep the always-loaded context within the harness's limits

Context engineering starts with the part you pay for on every request: what the
harness loads **without being asked**. This rule checks that against the
**harness's own limits**, one per part:

1. **Under every limit, nothing happens.** The context may grow freely up to
   the limit, and no file is needed.
2. **Over a limit, the size you accepted holds.** You record today's size once
   in `.vigiles/baseline.json`. From then on the check passes while the context
   stays at or below that size, and fails the day it grows past it.

So a repository far under the limits never pays for a gate it does not need,
and a repository already several times over starts green and fails only when
it gets heavier.

The rule itself is stateless: it measures and compares against the limit. The
baseline store is applied **after** the rule has produced its findings, the way
ESLint applies bulk suppressions: the rule never reads the store, and the store
never knows how the rule measures. `vigiles audit` prints the same measurement
under `Always-loaded instructions` and `always-loaded context`, against the
same limits; the detector is `checkAlwaysLoadedLimits` in
`src/core/always-loaded-limits.ts`.

## The limits

Each number is the one the harness itself publishes or acts on. vigiles does
not invent thresholds.

| part                                                  | Claude Code                                                               | Codex                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **instructions** (the selected output style included) | 40,000 characters: the floor of the CLI's large-file warning              | 32,768 bytes: `project_doc_max_bytes`, past which Codex **silently truncates**        |
| **skill listing**                                     | 6,000 characters: the listing budget, past which descriptions are dropped | 8,000 at thread start, past which descriptions are shortened and then skills left out |
| **output style**                                      | no limit of its own; counted with the instructions                        | not supported                                                                         |

Where the numbers come from:

- **Claude Code skill listing.** In the pinned release (2.1.187) the budget is
  `floor(context window × characters per token × skillListingBudgetFraction)`.
  The window is 200,000 tokens unless the model has a 1M window. The fraction
  defaults to 0.01. Characters per token is **4** for a fixed set of older
  models and **3** for every other model. vigiles uses the floor:
  200,000 × 3 × 0.01 = **6,000**.
- **Claude Code instructions.** The CLI warns per file at 5% of the window in
  characters, never below 40,000. vigiles uses that floor.
- **Codex skill listing.** At thread start Codex sizes the listing in
  characters with no model window, so the budget is the fixed 8,000. vigiles
  measures Codex in bytes, which is never fewer than characters, so a
  non-ASCII listing is reported over slightly early, never late.

### Committed settings that move a limit

A setting committed to the repository changes what every teammate's session
loads, so vigiles reads it:

| harness     | setting                                                                 | listing limit                                   |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code | `skillListingBudgetFraction` in `.claude/settings.json` (0 < value ≤ 1) | `floor(200,000 × 3 × value)`                    |
| Codex       | `max_context_tokens` under `[skills]` in `.codex/config.toml`           | `min(value, 10,000)` tokens × 4 bytes per token |

The message names the setting when one moved the limit.

**Not read:** per-machine environment variables that also move these numbers:
Claude Code's `SLASH_COMMAND_TOOL_CHAR_BUDGET` and
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, and the model a person picks. They are not a
property of the commit, so CI could not reproduce them.

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

### The always-loaded context: output style and skill listing

Two more things load at session start before any decision:

- **the output style** your committed settings select, when the repository
  holds it as a file — its body, frontmatter removed;
- **the skill listing** — one entry per skill in the folder a session at the
  repository root loads (Claude Code: one folder per skill; Codex: the folder
  walked up to six directories deep, `.`-folders skipped), rendered the way the harness renders it, with its
  per-entry cap (Claude Code `- dir: description - when_to_use`, the text cut
  to 1,536 characters or `skillListingMaxDescChars`; Codex `- name: description (file: path)`, the
  description cut to 1,024, and a skill Codex cannot parse — no frontmatter,
  no description — not listed). A skill folder that is a symlink counts like
  a real one — that is how `vigiles init` installs skills. A link back to a
  folder that contains it (a cycle) is not followed.

Together with the instructions this is the **always-loaded context**. The limits
are checked per part. Once a part is over, the baseline holds the **sum** of
all parts, so moving a section from `CLAUDE.md` into the selected style, or
into a skill's description, still reads as held. The line under the verdict
says where the weight moved:

```
✓ … Held at the recorded baseline (38,062 chars).
  instructions 20,000 (-4,665) · output-style 13,031 (+4,665) · skill-listing 5,031
```

Not counted: a style selected only in a per-machine settings file, a selected
name no repository style declares (named in `audit`, size unknown), a plugin's
own `skills/` folder (its users load it, not a session here), and user-level
and plugin skills. Codex has no output styles.

## A skill listing over its budget is a behaviour problem

Past the listing budget the harness does not just cost more. It **drops skill
descriptions** at session start, so some skills lose the text the model picks
them by, and may never trigger. `vigiles audit` says so in its always-loaded
block:

```
  limits (chars): instructions 10 of 40,000 · skill-listing 7,530 of 6,000
  ⚠ the skill listing is over the harness's listing budget by 1,530 chars: at
    session start the harness drops skill descriptions past it, so some skills
    lose the text they are picked by and may never trigger
```

The count covers the repository's skills only. In a real session the
harness's own bundled skills and your user and plugin skills share the same
budget, so the real listing is larger.

## What it reports

| state                                                                                    | result                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| every part at or under its limit                                                         | nothing; no file needed                                                                                      |
| a part over its limit, no baseline recorded                                              | a **note** naming the part, the limit, what the harness does past it, and the command; never a finding       |
| over, and the size equals the recorded baseline                                          | `✓ … Held at the recorded baseline`                                                                          |
| over, and it **grew** past the baseline                                                  | finding: the delta, every file that moved, and which part                                                    |
| over, and it **shrank** below the baseline                                               | finding: the size went down — record the new, lower number with the command                                  |
| under every limit again, with an entry in the baseline                                   | note: the entry is no longer needed — `--update-baseline` drops it and deletes an empty file                 |
| baseline recorded by another measurement, or in another unit                             | finding: re-record (vigiles changed what counts, or the repo changed harness)                                |
| the baseline has entries for this rule, but not this bundle                              | finding: weight nobody recorded                                                                              |
| `.vigiles/baseline.json` is not valid                                                    | finding; never read as empty                                                                                 |
| a part this run cannot measure (the adapter does not model it, or the style has no file) | carried at its recorded size; never read as 0                                                                |
| an old `.vigiles/context-creep.json` exists                                              | finding naming the file and the command that migrates it ([below](#migrating-from-vigilescontext-creepjson)) |

```
✗ always-loaded context is over the harness's limit: skill listing 7,530 chars,
  limit 6,000 (the harness's own) — 1,530 over; the harness drops skill
  descriptions past it, so some skills lose the text they trigger on
  Grew 7,578 → 7,598 chars (+20) over the recorded baseline. Changed:
  CLAUDE.md (instructions) +20.
  instructions 68 (+20) · skill-listing 7,530
  If the growth is intended, record it with `vigiles lint --update-baseline` —
  the diff of .vigiles/baseline.json is the review. If it is not: …
```

Going over a limit **never fails on its own**. It only switches the baseline
on, so a repository over the limit starts green.

A **shrink is a finding too**, until the lower number is recorded. A baseline
above the tree is headroom: every character up to the old number would pass,
and that is exactly where regrowth lands unnoticed. Recording the cut in the
same change keeps the baseline equal to the tree, so any growth at all shows
up. This is the rule PHPStan, Psalm, ESLint's unpruned suppressions and
`betterer ci` apply to a stale baseline entry.

```
✗ always-loaded context is over the harness's limit: skill listing 7,530 chars, …
  The size went down: 7,578 → 7,540 chars (-38), below the recorded baseline,
  which still allows the old size — headroom that can be regrown without a
  finding. Record the new, lower number with `vigiles lint --update-baseline`.
```

## Recording the baseline

You do not need to know the flag. **`vigiles init` records the baseline** on a
repository that is over a limit and has none, and says so:

```
✓ always-loaded context: skill-listing is 7,530 chars, over the limit of 6,000.
  Recorded .vigiles/baseline.json — commit it. CI now fails only if it grows past that size.
```

`init` under every limit writes nothing, and a rerun of `init` never
overwrites an existing baseline.

While a repository is over a limit with no baseline, `vigiles lint --summary`
— the line the shipped session-start hook injects into the agent — carries one
extra line naming the command, so the agent working in the repository records
it. In GitHub Actions the same note is a `notice` annotation on the run.

To record by hand, or to accept growth:

```bash
npx vigiles lint --update-baseline
git add .vigiles/baseline.json
```

`--update-baseline` writes the file **only while some part is over a limit**.
Once nothing is over, it deletes the file instead. Raising the baseline is
allowed: growth is not forbidden, it becomes a reviewed diff of a committed
file instead of passing in silence.

**`lint` never writes.** Every default lint path is a read, and CI must not
commit files. Over a limit with no baseline, `lint` stays a note that names the
command.

`vigiles compile` prints the size after it writes, against each limit:

```
always-loaded context: 7,598 chars — instructions 68/40,000 · skill-listing 7,530/6,000 (over a limit; grew past the baseline — `vigiles lint` fails)
```

## The file

`.vigiles/baseline.json` is one store for every rule that accepts a recorded
size, keyed by rule id and then by subject (here, the bundle; `.` is the
root):

```json
{
  "version": 1,
  "rules": {
    "context-creep": {
      ".": {
        "direction": "shrink-only",
        "unit": "chars",
        "measure": 1,
        "value": 7578,
        "parts": {
          "instructions": { "value": 48, "files": { "CLAUDE.md": 48 } },
          "skill-listing": {
            "value": 7530,
            "files": { ".claude/skills/review/SKILL.md": 1506 }
          }
        }
      }
    }
  }
}
```

- `value` is the accepted size, in `unit`. `direction: "shrink-only"` means it
  may hold or fall, never rise.
- `parts` must sum to `value`, and each part's `files` to its `value`; a
  hand-edited number that does not add up is refused. A part of 0 is not
  written.
- `measure` names the measurement that produced the number. A release that
  changes what counts bumps it, and the rule then asks for a re-record instead
  of reporting growth.
- Recording one rule never touches another rule's entries. Keys are sorted
  and there is no timestamp, so the diff shows only real movement.

**Committed, unlike `.vigiles/coverage.json`.** Coverage records what ran on one
machine; this records a property of the commit, computed only from committed
files and committed settings.

## Migrating from `.vigiles/context-creep.json`

Earlier releases kept this baseline in `.vigiles/context-creep.json` (and,
before the rule's rename, `.vigiles/instruction-weight.json`). **That file is
no longer read.** While it exists, `lint` reports a finding that names it and
the one command that migrates it:

```bash
npx vigiles lint --update-baseline
git add -A .vigiles   # the new file, and the old one's deletion
```

The command **keeps the recorded numbers**: it converts each old entry for a
bundle that is still over a limit, instead of re-measuring, so growth that
landed since the old file was recorded still fails. Parts a version-1 file
never recorded (the output style and the skill listing) are taken at today's
size, since they were never gated. Then it deletes the old file. Run
`--update-baseline` once more to accept the current size. `init` does not
migrate on its own; it prints the same command.

## Configuration

```json
{ "rules": { "context-creep": "error" } }
```

| Value               | Behavior                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| `"error"` (default) | `vigiles lint` exits 2 when a part over its limit grew past the baseline |
| `"warn"`            | Prints the finding, exits 0                                              |
| `false`             | Skip the check (and `init` records nothing)                              |

On by default because a repository under every limit sees nothing, and one
over a limit with no baseline sees a note.

### `limits`: override a harness limit

```json
{
  "rules": {
    "context-creep": [
      "error",
      { "limits": { "instructions": 60000, "skill-listing": 9000 } }
    ]
  }
}
```

Each value is a positive integer in the harness's own unit (characters for
Claude Code, bytes for Codex). A part left out keeps the harness's number. An
override can give a part a limit the adapter does not model. `0`, a fraction,
a string or an unknown key is a config error. Overrides apply to `lint`,
`compile` and `init`; `vigiles audit` reports against the harness's own limits.

### `max`: an opt-in absolute ceiling

```json
{ "rules": { "context-creep": ["error", { "max": 40000 }] } }
```

A limit switches the baseline on; `max` is a ceiling **no baseline lifts**. It
is checked against the instructions' total, per bundle, in the harness's unit.

- **Over `max`** → a finding at the rule's severity, whatever the baseline
  holds, naming the total, the max, how far over and the largest files.
- **`vigiles lint --update-baseline` refuses** to record while a bundle is over
  `max`: it writes nothing and exits non-zero (even at `"warn"`).
- `max` is never on by default.

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

### The listing is measured without separators

Both harnesses add a newline per entry when they measure the listing against
its budget, and Claude Code counts display width (a wide character counts as
2). vigiles sums the entries' lengths, so the listing is under-counted by about
one character per listed skill.

### Claude Code is modelled on one release

The Claude Code entry is rendered the way the release vigiles is validated
against renders it: **2.1.187**, the version vigiles's own CI runs. Newer
releases render more text per entry:

| Newer releases (measured on 2.1.316)                  | Per entry                     |
| ----------------------------------------------------- | ----------------------------- |
| escape `<` and `>` as `&lt;` and `&gt;`               | +3 characters per bracket     |
| add a frontmatter `name` that differs from the folder | `- dir (name):`, +3 plus name |
| replace control characters with spaces                | same length                   |

**Effect on the number:** on a newer Claude Code, the skill listing is
under-counted by those characters. A description with no `<`, `>` and no
differing `name` is counted exactly.

## See also

- [`vigiles audit`](../cli.md) — the full weight report: per-file sizes, the
  limits, and what the harness does when over them.
- [skill-description-budget](skill-description-budget.md) — a per-description
  length heuristic for skills.
