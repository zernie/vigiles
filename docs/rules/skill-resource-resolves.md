# skill-resource-resolves

Flag a **SKILL.md body** that references a **bundled file** which doesn't exist on
disk under the skill directory. A SKILL.md routinely points the agent at local
files shipped beside it — `scripts/run.sh`, `references/api.md`, an inline
`` `scripts/setup.py` ``. When the referenced file is missing, the agent reads the
instruction, gets nothing, and **silently continues** — a documented top skill
pain. This is the cross-reference moat applied to the SKILL.md body. Same detector
`vigiles audit` uses (`skillResourceIssues` in `src/core/skill-resources.ts`).

## What it flags

A body reference that is **unambiguously a local bundled resource** but doesn't
resolve on disk:

```
✗ pdf-extract: bundled resource "scripts/extract.py" (line 14) is referenced but
  missing — the agent reads the instruction and gets nothing.
```

A file that is missing beside the SKILL.md but **exists at the repository root**
is not reported as missing. It gets a separate, ungraded note — see
[Resolves only from the repo root](#resolves-only-from-the-repo-root--a-note-not-a-miss).

It matches two shapes:

- a **markdown link** `[setup](./scripts/run.sh)` whose target is a relative path
  with a file extension, and
- an **inline-code path** `` `scripts/foo.sh` `` that is prefixed by a standard
  bundle dir (`scripts/`, `references/`, `assets/`), has an extension, **and sits
  in a line that directs the agent to use it** (see below).

## Resolves only from the repo root — a note, not a miss

The agent usually runs from the repository root. So when a skill says
"run `` `scripts/check-changelog.sh` ``", it often means
`<repo>/scripts/check-changelog.sh`, not a copy beside the SKILL.md. That works
while the skill runs inside its own repository, and breaks once the skill is
installed anywhere else — as a plugin, or copied into another project.

Such a reference is neither missing nor fine, so vigiles reports it as its own
kind of finding. Take this skill:

```
.claude/skills/release-check/SKILL.md   # line 8:  Run `scripts/check-changelog.sh` …
                                        # line 10: Then read `references/release-policy.md` …
scripts/check-changelog.sh              # at the repo root, not beside the SKILL.md
```

`references/release-policy.md` exists nowhere. `scripts/check-changelog.sh`
exists only at the repo root.

**Before** — both refs were reported as missing, and both counted against the
score:

```
Skill bundled resources (2):
  ✗ release-check: scripts/check-changelog.sh (line 8) — bundled resource not found
  ✗ release-check: references/release-policy.md (line 10) — bundled resource not found
```

**After** — only the ref that exists nowhere is a miss. The other one is a note:

```
Skill bundled resources (1):
  ✗ release-check: references/release-policy.md (line 10) — bundled resource not found

Skill resources that resolve only from the repo root (1):
  ℹ release-check: scripts/check-changelog.sh (line 8) resolves only from the repo root, not from the skill directory — it breaks once the skill is installed outside this repository. If repo-root resolution is intended, add "scripts" to sharedDirs in .vigilesrc.json.
```

`vigiles lint` prints the same two lines:

```
Skill-resource check:

  ⚠ .claude/skills/release-check/SKILL.md: release-check: bundled resource "references/release-policy.md" (line 10) is referenced but missing — the agent reads the instruction and gets nothing.
  ℹ .claude/skills/release-check/SKILL.md: release-check: bundled resource "scripts/check-changelog.sh" (line 8) resolves only from the repo root, not from the skill directory — it breaks once the skill is installed outside this repository. If repo-root resolution is intended, add "scripts" to sharedDirs in .vigilesrc.json.
```

What a note does and does not do:

| Surface                                                 | A missing ref                           | A repo-root-only note                          |
| ------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `audit` text                                            | `✗` line                                | `ℹ` line, in its own section                   |
| `audit` score                                           | lowers the overall score, caps it at 89 | ❌ never scored                                |
| `audit --json` / HTML                                   | named in the verdict                    | `skillResourceNotes`, shown under Truthfulness |
| `lint` exit code                                        | fails at `"error"`                      | ❌ never fails, at any severity                |
| GitHub Actions annotation                               | `::warning` / `::error`                 | `::notice`                                     |
| `"skill-resource-resolves": false` or an `off` override | silenced                                | silenced                                       |

ℹ️ **What "the repo root" is.** The same root `sharedDirs` is read from: the
folder holding `.vigilesrc.json` (your working directory) for `vigiles lint`
and `vigiles audit`, and the audited folder for `vigiles audit <other-repo>`.

**Why a note, and not just resolving it from the repo root.** A real miss must
never disappear because a file with the same name happens to sit at the root.
Reporting the ref as a note keeps that guarantee visible: you still see every
ref that is not beside its SKILL.md, and you can tell the ones that are gone
from the ones that are only fragile.

**Why not just ask people to set `sharedDirs`.** `sharedDirs` is opt-in, and
`vigiles audit` is zero-config. Someone auditing a repository they do not own
has no `.vigilesrc.json` to edit, so every repo-root path read as a broken
reference. On a sweep of public repositories with a committed Claude Code or
Codex harness, that was the largest single source of false "missing" reports.

**To silence a note** in a repository you own, declare the directory as shared
(`{ "sharedDirs": ["scripts"] }` — see
[skills in a monorepo](../skills-monorepo.md#shared-scripts--references-trees--shareddirs)),
or ship the file beside the SKILL.md if the skill is meant to be installed
elsewhere. A file at the root with no directory (`guide.md`) cannot be declared
shared — the note says so and suggests shipping it beside the SKILL.md.

## High-precision (FP-safe)

By the same don't-cry-wolf discipline as the loader's `danglingRefs`, it flags
**only** what is clearly a local resource and **skips** everything ambiguous:

- URLs (`http://…`, `mailto:`), absolute paths (`/etc/x`, `C:\…`),
- `${VAR}` / `$VAR` tokens (plugin-root / runtime paths, uncheckable),
- `../` escapes out of the skill dir (a sibling skill or the repo),
- extension-less mentions (a bare word or a directory name is undecidable prose),
- and a generic inline `` `config.json` `` / `` `src/foo.ts` `` API mention (not a
  bundle-dir path).

An **inline-code path** gets one extra gate, because it is a weaker signal than a
link. A skill that _teaches_ how to build skills is full of bundle paths used as
**examples** of what a skill _could_ contain, not files it ships — "a
`` `scripts/rotate_pdf.py` `` would be helpful to store", "**Examples**:
`` `references/finance.md` ``", "- **`` `references/patterns.md` ``** — Common
patterns". So the two shapes are gated differently, and the asymmetry is deliberate.

**Two cues suppress a reference, and they apply to BOTH shapes:**

- an **illustrative** cue — `example`, `e.g.`, `such as`, `would be`, `template`, `→`;
- a **generated-file** cue — the line says the file is _made_, not read:
  `gitignored`, `.gitignore`, `cached to`, `cache file`, `written to` / `writes to`,
  `generated at runtime`, `created at runtime`. A file the author states is produced
  at runtime or kept out of the repository cannot be a missing bundled resource.

On top of that, an **inline backtick path** additionally needs a use directive
(`read` / `run` / `see` / `load` / …), because a bare mention is noisy. A **markdown
link** does not: it is explicit follow-me syntax, so `Resources: [the API](references/api.md)`
is checked even with no verb in the line, while "For example, see
`[a report](assets/example.pdf)`" is suppressed by the cue.

_(This paragraph previously said a link also required a directive. That was
true until the link branch was narrowed to cue-only suppression to close an
under-detection; `candidateFor` in `src/core/skill-resources.ts` and the
"plain resource link with NO use directive" test are the authority.)_

**A heading counts as a directive.** The verb gate reads prose, and a heading is
not prose — it is the section's label — so the most common way a skill points at
its own script went unchecked:

```md
## 🏗 START WITH THE MECHANICAL LEG — `scripts/structure.mjs`
```

Measured on a real skill whose `structure.mjs` sits at the skill **root**, not
under `scripts/`: that line yielded nothing, while rewriting it to "Run the
mechanical leg" — same file, same missing target — reported it correctly. The
tool's answer depended on the author's choice of verb. An ATX heading naming a
bundle path is now treated like an explicit "run …". The illustrative-cue veto
still applies (`## Examples: …` stays skipped), and the wider net stops there: a
mid-paragraph mention with no directive is still not checked, because flagging
every backticked bundle path is what cries wolf on teaching skills.

**A link's TEXT is not a reference.** Candidates come from a markdown _parse_
(markdown-it), not from regexes over each line, so the destination and the label
can be told apart:

```md
See [`references/api.md` § Lookups](../add-dataverse/references/api.md#lookups)
```

The destination is what the agent follows, and it resolves. The backtick span is
its human-readable label. A line-oriented scan could not see that the span sat
inside a link, and reported the label as a missing bundled resource — an
accusation against a correct link (measured on `microsoft/power-platform-skills`
and `rohitg00/pro-workflow`, 2026-08-17). A code span nested in a link's or an
image's text is therefore not a candidate at all. For the same reason, link
syntax that lives _inside_ a code span is not a link: `` `- [ ] [Phase N](phase-N.md)` ``
documents a checklist format, and `phase-N.md` is a metavariable that will never
exist.

The detector prefers **missing a real ref over a false positive** — a noisy
resource check would teach users to ignore it. A skill whose body is inherently
full of illustrative bundle-path examples (a skill-authoring tutorial) can opt out
entirely with a `<!-- vigiles-disable skill-resource-resolves -->` marker.

## Configuration

```json
{ "rules": { "skill-resource-resolves": "warn" } }
```

### Severity

| Value              | Behavior                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2) on a missing bundled resource; a repo-root-only note never fails |
| `"warn"` (default) | Prints a warning, exits 0 (don't-cry-wolf rollout)                                                 |
| `false`            | Skip the check, notes included                                                                     |

Default is **`warn`** during rollout; raise to `"error"` to gate CI once you trust
it on your own skills.

## Scope

Skills (`skills/*/SKILL.md`) — every harness has skills, so this rule is **not**
capability-gated. References resolve against the skill's own directory (resources
ship beside the SKILL.md), then against the repo root — through a declared
`sharedDirs` entry (resolved), or on its own (a note).

## Why

A SKILL.md is freeform markdown, so a renamed or un-shipped `scripts/` file rots
silently — the model just doesn't get the resource it was told to use. vigiles
already verifies file/script refs inside typed specs and intra-plugin hook refs in
the loader; this extends that guarantee to the SKILL.md body.

## See also

- [hook-script-exists](hook-script-exists.md) — the same idea for a hook command's
  script file.
- [skill-frontmatter](skill-frontmatter.md) — recommends an explicit, reliable
  trigger surface.
