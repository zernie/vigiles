# Skills

<!-- vigiles:ignore-file -->

> ⚠️ **`skill()` is experimental.** It compiles, and every gate it emits is
> verified — but it has not been adopted across a real skill corpus yet, and the
> spec shape may change without a major bump. [Status](#status--pending) lists the
> measured gaps, including one that blocks adoption today. Hand-written `SKILL.md`
> (markdown mode, below) is the stable path.

vigiles treats an agent **skill** (a `SKILL.md` procedure) the way it treats a `CLAUDE.md`: verify the deterministic parts at author time, enforce them at run time, and leave prose as prose.

A skill has two kinds of content:

- **Prose** the model executes — probabilistic, never asserted by vigiles.
- **Gates** — deterministic checks (a command, a file, a linter rule, a project role) that vigiles **verifies exist at compile time** and the harness **runs at run time**. A skill is not "done" until its result gate passes.

This is the same probabilistic-vs-deterministic split vigiles applies to rule references, now applied to a skill's _procedure_.

## Authoring a skill

Two on-ramps. They differ by **who owns the file**, not by power: in markdown mode you own `SKILL.md` and vigiles only checks the markers in it; with `skill()` the compiler owns `SKILL.md` and you own the spec it is generated from.

### 1. Markdown mode (no code) — stable

**Write `SKILL.md` prose and drop deterministic gates in as markers.** No spec, no TypeScript. Best for prose authors and the shallow majority of skills.

```md
## Step: Run the tests

Fix failures until the suite is green.

<!-- vigiles:gate "npm test" retry:3 -->

## Result

<!-- vigiles:result "npm test" -->
```

`vigiles lint` verifies each marker's reference against the project, exactly as in inline/frontmatter mode for `CLAUDE.md`. See `docs/markdown-mode.md`.

### 2. Declarative typed spec — `skill({ … })` — experimental

**For a linear skill**, a `SKILL.md.spec.ts` gives typed inputs, a knowledge body, and gated steps that compile to a verified `SKILL.md`:

```ts
import { experimental_skill, cmd, project, prose } from "vigiles/spec";

export default experimental_skill({
  name: "ship-pr",
  description: "Run the checks and open a PR once they pass",
  inputs: [experimental_skill.input("branch", "branch to open the PR from")],
  body: prose`## Reference\n\n…domain knowledge the model reads…`,
  steps: [
    experimental_skill.step("Run the linter and fix issues.", {
      gate: cmd("npm run lint"),
    }),
    experimental_skill.step("Run the tests; fix until green.", {
      gate: project("test"),
      retry: 3,
    }),
  ],
  postcondition: project("test"),
});
```

**Why `skill.input` and `skill.step` instead of two more imports.** Both are used only by skill specs; `cmd`, `file`, `project` and `result` are shared with subagents and stay top-level. Hanging the skill-only pair off the builder makes the experimental marking structural for the whole family — you cannot reach `input()` without naming `experimental_skill` first, which a per-name prefix convention could not guarantee. Aliasing at the import, as above, keeps the prefix on the one line that crosses the package boundary and keeps the body readable.

What each field does:

- **`inputs`** compile to the `argument-hint` frontmatter and an `## Arguments` section (`$1`, `$2`, …).
- **`body`** (knowledge) and **`steps`** (procedure) compose — the body renders as a reference section before the gated steps.
- Each step's **`gate`** + optional **`retry`** renders a `vigiles:gate` marker. **`postcondition`** renders the terminal `vigiles:result` marker. (The field was called `result:` until it collided with `result()`, the subagent output contract; the compiled MARKER keeps its name, because every already-compiled `SKILL.md` on disk carries it.)
- Every gate reference is **verified at compile time** (see below).

## Gates and what is verified

A gate is one of:

| Gate                               | Author-time check                   | Run-time                                                                           |
| ---------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `cmd("npm test")`                  | npm script exists in `package.json` | run, exit 0 = pass                                                                 |
| `cmd("python scripts/x.py")`       | the script **file** exists          | run, exit 0 = pass                                                                 |
| `file("scripts/validate.py")`      | the path exists                     | exists = pass                                                                      |
| `project("test"\|"build"\|"lint")` | always valid (portable)             | resolves to the **host** project's command (npm / pytest / cargo / go) and runs it |

ℹ️ **`project()` gates are portable.** A skill that runs in many repos should prefer `project("test")` over a hard-coded `npm test`. Missing scripts and files are caught at compile time — the exact "skill silently references a script that doesn't exist" rot that breaks real skills.

**`maxInlineCodeLines`** (default 20): an inline fenced code block longer than this raises a non-blocking **warning** nudging you to move the script into a file referenced by `file()`. This keeps big scripts out of the body for token budget and progressive disclosure. It's advisory, not an error — so adopting a code-heavy skill always compiles.

## Running and enforcing a skill

- **`vigiles hook-runtime run-skill <SKILL.md>`** parses the `vigiles:gate`/`vigiles:result` markers and **runs the gate ladder**: each gate in order, short-circuiting on the first failure (Railway), then the result gate. Exit 0 = all passed, exit 2 = blocked. (`src/adapters/claude-code/skill-runtime.ts`)
- **Stop-hook enforcement** makes the result gate enforce in a live session: `vigiles hook-runtime skill-start <SKILL.md>` marks a skill active; the `Stop` hook (`vigiles hook-runtime skill`) runs its result gate and **blocks completion until it passes** (exit 2 feeds the reason back to the model); `vigiles hook-runtime skill-done` clears it. Proven end-to-end against real Claude Code in `test/e2e`.
- **Edit protection**: the Claude Code plugin (installed via the marketplace — `/plugin marketplace add zernie/vigiles` then `/plugin install vigiles@vigiles`, or via `vigiles init`) ships a `PreToolUse` hook that blocks edits to any vigiles-compiled file (one carrying a `vigiles:sha256:` header — including a compiled `SKILL.md`) and redirects to its spec, and a `PostToolUse` hook that recompiles on `*.spec.ts` edits. Hand-written markdown is untouched.

## Testing a skill

A skill's **firing** and its **gates** are testable without a spec, from the public testing API — see [`docs/harness-testing.md`](harness-testing.md) and [`docs/testing-api.md`](testing-api.md):

- **Does the description actually fire?** `paid_measureTriggerRate` (`vigiles/eval`) reports recall and precision against prompts that should and should not reach the skill.
- **Does the gate ladder behave?** `vigiles hook-runtime run-skill <SKILL.md>` runs the markers directly, so a test can assert the exit code.
- **Live E2E** (`test/e2e`, `npm run test:cli-e2e`): drives the _real_ `claude` CLI against a scripted mock Anthropic endpoint (`ANTHROPIC_BASE_URL`), asserting the tool-use loop and Stop-hook enforcement with no real model.

## Companion files — `references/`, `scripts/`, `assets/`

A skill is a **directory**, not a file. The Agent Skills specification says so, and it
recommends splitting: _"Keep your main `SKILL.md` under 500 lines. Move detailed reference
material to separate files."_ Progressive disclosure is the intended shape, so companions
are the normal case, not an edge one.

| directory     | holds                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `references/` | documentation the agent reads on demand — a fallback procedure, a long table, a format reference |
| `scripts/`    | executable code the skill runs                                                                   |
| `assets/`     | everything else the skill ships                                                                  |

### How to write one

- **Point at it from `SKILL.md` with a relative markdown link**, and write the line as a
  plain instruction to use the file. `skill-resource-resolves` reports the link when its
  target is missing.

  🔴 **Do not infer the exact rule from this page.** The detector is deliberately
  conservative: it skips several target shapes and several surrounding phrasings, by design
  rather than by oversight. [`rules/skill-resource-resolves.md`](rules/skill-resource-resolves.md)
  describes them — and is itself explicit that its lists lag the constants in
  `src/core/skill-resources.ts`, which are the authority. Read the page before relying on a
  particular link being checked, and read the constants before concluding that it is.

- **Link back** from a **documentation** companion to its `SKILL.md` — `../SKILL.md` from a
  one-level file, and a path computed from the actual depth when it sits deeper (a
  `references/api/errors.md` needs `../../SKILL.md`). A prose companion that reads as a
  standalone procedure is one someone will follow without the gates its parent declares.

  Two exemptions, both because the backlink would end up somewhere it does not belong: a
  script says it in a comment or not at all, and a binary asset cannot say it; and **anything
  under `assets/` that the skill copies out** — a template's `README.md` is the user's file
  once it lands, and a backlink there points at a `SKILL.md` that did not travel with it.

- **Keep reference documents one level deep**, linked directly from `SKILL.md` — that is
  what the skill-authoring guidance asks for, and it keeps the reference resolvable by
  inspection. It is a rule for reference docs, not for every bundled resource: `scripts/` may
  be a package with helper modules and `assets/` may hold nested multi-file templates, whose
  layout and relative paths are part of how they work.
- **Do not reach for `file()` to verify a companion.** It looks like the higher rung — it is
  verified to exist at compile time — but `renderFragment` emits a `FileRef` as a **visible
  backticked path**, and that path is **repo-root-relative**. In a skill that is packaged and
  installed elsewhere the emitted path resolves nowhere, so the document ends up carrying a
  working link and a broken pointer side by side, and the agent may follow the second one.
  Nothing rebases it during packaging.

  The markdown link is already checked — that is what `skill-resource-resolves` is for. Use
  the link, and let the linter do the verifying.

  _(`file()` remains right for an instruction file that never leaves its own repository,
  where the emitted repo-root path is exactly what a reader should see. What does not exist
  today is a compile-verified reference that stays **skill-relative** and emits nothing —
  that is the gap, not something an author can work around.)_

- **Documentation companions under `references/` stay plain markdown even when the skill has a `.spec.ts`.** (`scripts/` stays executable source — `.py`, `.sh`; `assets/` stays whatever it is. The point below is about ownership, not file type: every companion is an author-owned source, not a generated artifact.) They carry no
  frontmatter and no tool contract, so there is nothing for a spec to declare, and the
  compiler's integrity mark is for _generated_ files — a companion is a **source**. Hashing
  it would report `manually edited after compilation` on every legitimate edit.

### What is verified, and what is not

Measured 2026-08-31 by planting each defect and checking whether it was reported:

| property                                 | checked                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a link from `SKILL.md` to a companion    | **yes, for the ordinary case** — `skill-resource-resolves`. Its reported line names a line of the `SKILL.md` itself, frontmatter included. It deliberately skips a number of target shapes and surrounding phrasings; [`rules/skill-resource-resolves.md`](rules/skill-resource-resolves.md) describes them, and names the source constants as the authority over its own prose |
| a link _inside_ a companion resolves     | **no** — resolution is not transitive                                                                                                                                                                                                                                                                                                                                           |
| a companion no link reaches              | **no** by default — `orphans` is opt-in and scans `docs/`                                                                                                                                                                                                                                                                                                                       |
| companion prose, tool mentions, trifecta | **no** — these read `SKILL.md`                                                                                                                                                                                                                                                                                                                                                  |

The first row is the one that matters most, and it works for the ordinary shape; the rest is
why a companion is not
a place to move something _because_ it is awkward. The gap is tracked as a roadmap item —
the fix is to scope by directory and follow the reference closure, not to add a manifest
field listing companions.

## Status / pending

`experimental_skill` carries the prefix, and these are the measured reasons — the
roadmap for a feature lives with the feature, not on a separate stability page:

- **A compiled `SKILL.md` now has one datapoint as an installed skill — and the header worry is stale.** Measured 2026-08-31 in `zernie/mine`: `outbound-email` was converted to a spec, compiled, and the harness listed it as an available skill with its compiled description. Read the strength honestly — the skill was already present before the conversion, so this shows the compiled form does not _break_ loading; it is not a from-scratch install.

  The specific fear in the previous wording is measurably gone: the `vigiles:sha256:` header no longer precedes the frontmatter. In that compiled file the frontmatter opens on **line 1** and the header sits on **line 10**, after the closing `---`. A reader anchored at `^---` finds the frontmatter exactly where it expects it.

  Independent supporting evidence, unchanged: in `examples/harness/dogfood/reviewer-ab.eval.mjs`, real Claude Code loaded a compiled `agents/code-reviewer.md` through `--plugin-dir`, dispatched to it, and the subagent read the file — 100% of trials against real sonnet (2026-06-20).

  ⚠️ Still missing for a clean close: a compiled skill installed somewhere it never existed before, and one shown to _fire_ on a prompt rather than merely appear in a listing.

- **Adoption is all-or-nothing.** `renderSkillSections` composes the whole document in a fixed order, so converting an existing skill rewrites its structure rather than adding a gate to it. There is no "keep my prose, add one verified gate" path.
- **`inputs` costs more than it looks.** One `input()` adds both the `argument-hint` frontmatter key and a generated `## Arguments` section.
- The generator authoring mode (`genSkill` / `act` / `checkpoint` / `finish`) is **parked** and undocumented. It compiles, but it is reachable from no package subpath, so it is not part of the public API.

**What would have to be true to drop the prefix:** a real skill corpus converted to it (today: two example specs), and a compiled `SKILL.md` shown to load and run as an installed skill. The first bullet above moves that second condition **partway** and no further — it shows a converted skill still being listed, not a fresh install, and firing was never measured. Treat the milestone as unmet.

**Why the helpers hang off the builder.** `experimental_skill.input()` and `experimental_skill.step()` are exported through the builder rather than beside it, and that placement is the point: both are used **only** by skill specs, so making them reachable only through the prefixed name makes the marking structural for the whole family. `cmd`, `file`, `project` and `result` are shared with subagents and stay top-level. Honest limit: `const { input } = experimental_skill` strips the marker inside one file — what the shape guarantees is narrower, that an unmarked name never crosses the package boundary.

**Stable alternative:** a hand-written `SKILL.md` with markdown-mode gate markers. Same enforcement, no spec.
