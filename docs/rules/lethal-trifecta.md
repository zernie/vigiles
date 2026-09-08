# lethal-trifecta

Flag a unit — a **subagent** or a **model-invocable skill** — that holds all
**three legs** of Simon Willison's _lethal trifecta_. A single unit that can do
all three is a **prompt-injection exfiltration path with no exploit code**:
attacker-controllable content flows in, reads your private data, and ships it out
— all driven by the model, no bug required. Same detectors `vigiles audit` uses
(`lethalTrifectaIssues` / `skillTrifectaIssue` in
`src/core/lethal-trifecta.ts`). The check is over the tool **set** a unit holds, not
any single tool's effect. (A claim that no other plugin linter does this stood here
until 2026-09-08. Nobody had run one; it is removed rather than reworded so it is
not reintroduced.)

> ⚠️ **Subagents and skills are read from DIFFERENT fields, because they are
> different mechanisms.** A subagent's `tools:` really does bound the unit. A
> skill's `allowed-tools:` does **not** — it is a pre-approval, and the only skill
> field that removes a tool is `disallowed-tools:`. See
> [Skills: the fence is `disallowed-tools`](#skills-the-fence-is-disallowed-tools).

## The three legs

| Leg                          | What it grants                  | Example tools                                                                                           |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A — private-data read**    | read local secrets/files/repo   | `Read`, `mcp__filesystem__*`, `mcp__github__get_file_contents`, `Bash` (`cat ~/.ssh/*`)                 |
| **B — untrusted-content in** | ingest attacker-controlled text | `WebFetch`, `WebSearch`, `mcp__fetch__*`, MCP servers reading issues/email/tickets                      |
| **C — exfiltration channel** | send data out                   | `WebFetch`, `computer_use`, `mcp__github__create_pull_request`, Slack/email MCP, `Bash` (`curl`/`wget`) |

`Bash` (and Codex's `shell`) is **dual** — it satisfies leg A (read a secret) AND
leg C (curl it out) — so `Bash` + any leg-B tool is already all three legs.

**Meta's Rule of Two**: allow at most two of the three legs in one unit. A unit
holding all three is the finding.

## What it flags (subagents)

For a **subagent** this is a **capability SET-intersection over the declared
`tools:` contract, not a text scan**: it classifies each declared tool into the
leg(s) it supplies and fires only when all three legs are non-empty.

```
✗ subagent issue-triager (agents/issue-triager.md): Lethal trifecta: this unit can
  read private data (Read), ingest untrusted content (mcp__github__issue_read), AND
  exfiltrate (mcp__github__create_pull_request) — a prompt-injection exfil path with
  no exploit code. Drop at least one leg (Meta's Rule of Two: allow at most two).
```

### Hard vs advisory

- **`"hard"`** — an **explicit** contract that names all three legs (a concrete,
  declared exfil path). Reported with `✗`.
- **`"advisory"`** — a unit that holds every leg only because it **inherits**
  everything: a subagent with no `tools:` line, or a skill with no effective
  `disallowed-tools:` fence. A maximal blast radius. Reported with `⚠`.

The two severities describe **how the unit got there**, not how much it costs: an
inherits-all unit is graded exactly like an explicit one (see below), because it
is strictly the worse of the two.

### A contract that doesn't parse is not a contract

If a unit's frontmatter **exists but isn't valid YAML**
([frontmatter-valid](frontmatter-valid.md)), its declared tool list — a subagent's
`tools:`, a skill's `disallowed-tools:` fence — is read as **inherits-all**, the
advisory case, and the finding says so:

```
⚠ skill broken: Frontmatter is not valid YAML, so the declared tool list could not
  be read — a strict loader rejects the block, and a regex salvage of it is a guess,
  not a contract. Scored as INHERITS-ALL (every capability) …
```

vigiles's shared frontmatter reader is deliberately lenient: on a block js-yaml
rejects it falls back to a regex salvage, so the live PreToolUse rail still has
something to enforce and the file's other fields keep working. That is right for a
rail and wrong for a **score** — a unit whose contract a strict loader rejects was
being graded as though it had declared exactly the narrow list its author meant, so
the Safety ring read **better than the truth**. Same conservative direction as
grading inherits-all like an explicit all-three: presence of a declaration is not
enforcement of it. **Fix the YAML and the declared list counts again** — the finding
disappears the moment the block parses.

## Skills: the fence is `disallowed-tools`

A **skill** is not read the way a subagent is, and the difference is not a style
choice — it is what the platform does.

### `allowed-tools:` pre-approves. It does not restrict.

Claude Code's own documentation, under **"Pre-approve tools for a skill"**:

> The `allowed-tools` field **grants permission** for the listed tools during the
> turn that invokes the skill … **It does not restrict which tools are available:
> every tool remains callable**, and your permission settings still govern tools
> that are not listed. … **To remove tools from Claude's available pool while a
> skill is active, list them in `disallowed-tools`** in the skill's frontmatter.

Two bug reports say the same thing from the field, both closed by Anthropic as
_not planned_: [#18837](https://github.com/anthropics/claude-code/issues/18837)
(Jan 2026) and
[#37683](https://github.com/anthropics/claude-code/issues/37683) (Mar 2026) — the
second reproduced **interactively**, on a live model, on a different CLI version,
with the skill spawning an `Explore` subagent it had told itself never to use.
Measured here too (`claude -p`, CLI 2.1.227): a skill declaring
`allowed-tools: WebSearch, WebFetch` read a private file and wrote a new one.

**vigiles used to read `allowed-tools` as a bound, and that was wrong in the
dangerous direction.** It reported "18 of 38 units hold the trifecta" on a corpus
where all 38 did, and it credited a narrow `allowed-tools` list with a risk
reduction that does not exist. That is this tool's own thesis — _a declaration
present is not a rule enforced_ — violated by this tool. `allowed-tools` is no
longer an input to this check at all.

### `disallowed-tools:` does restrict — measured

Nine runs, `claude -p`, CLI 2.1.227, scripted mock model, $0. The cleanest control
is a single run in which the **same tool call succeeds before the skill activates
and is denied after**:

```
Permission to use Read has been denied.
```

and, in that same run, through a `Task` subagent — the route-around that defeats
`allowed-tools` in #37683:

```
Error: No such tool available: Read. Read is disabled for this session,
in subagents as well as here.
```

Positive controls were established first (without the line, the same `Read`
succeeds), and the refutations failed: a `bogus-tools:` key blocks nothing, and an
**unactivated** skill's fence does not apply — the fence is bound to activation,
not to the file existing.

**Not claimed** (the measurement did not cover it): the interactive app, the Agent
SDK, tools other than `Read`, narrow `Bash(…)` deny scopes, `mcp__*` names, or the
docs' "the restriction clears when you send your next message" (a `-p` run is one
message).

### What the check does

A skill inherits every tool the session grants. So each leg stands **unless every
built-in that supplies it is denied**:

| Leg                          | Built-ins that must ALL be denied to close it |
| ---------------------------- | --------------------------------------------- |
| **A — private-data read**    | `Read`, `Grep`, `Glob`, `Bash`                |
| **B — untrusted-content in** | `WebFetch`, `WebSearch`, `Bash`               |
| **C — exfiltration channel** | `WebFetch`, `WebSearch`, `Bash`               |

This list is deliberately **wider** than the per-leg catalogs used for subagents,
and the asymmetry is the point. On the allow side an unlisted tool maps to no leg
— that under-states risk, which is the safe direction for a "you are exposed"
claim. On the deny side the same omission would over-state safety: a leg would
read as closed because a supplier was forgotten. So `Grep`/`Glob` join `Read`,
`WebSearch` counts as an exfiltration channel (a query string leaves the machine),
and the shell is in all three — `curl` fetches attacker content in, `cat` reads
the secret, `curl --data` ships it out.

A deny entry with a **restriction** does not remove the tool:
`disallowed-tools: Bash(curl:*)` denies that pattern and leaves the rest of the
shell — the mirror of how a narrowed `Bash(…)` grant is read on the allow side.

**Stated limit.** This covers the harness's **built-ins**. An MCP server the
_session_ provides can re-supply a leg the fence closed, and no static read of a
`SKILL.md` can see the session's MCP config. "Leg closed" therefore means _closed
among the built-ins_ — the part the author can control from frontmatter — not a
proof of absence.

### The remedy is split by CAUSE

A check that fires on every unit carries no information unless it says **why this
unit fired**. After the `allowed-tools` inversion a real 38-skill repo went from
18 of 38 exposed units to **38 of 38** (Safety 86 → 70) — the classification is
right and stays, but the single remedy sentence it carried ("drop at least one
leg") was identical for situations needing different edits, and it pointed at
**narrowing `Bash(...)`**, which `EFFECT_FREE` has closed for anything an author
actually runs. So the remedy now names the cause:

| what the contract holds                                                               | what the message says                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| an **unrestricted** shell grant (`Bash`)                                              | the shell alone supplies two legs — removing it closes the path in one edit; narrowing only helps for an enumerably effect-free program                            |
| a **restricted** shell grant that still counts (`Bash(node ./x.mjs:*)`)               | you already narrowed, and it did not count — nothing has read your script, an interpreter runs whatever it is handed, narrowing further will not move this finding |
| **no shell leg at all** (`Read`, `WebFetch`) — including a _bounded_ `Bash(echo …:*)` | there is nothing to narrow; remove one of the named tools                                                                                                          |
| a skill fence whose entries are **restricted** (`disallowed-tools: Bash(curl:*)`)     | a restricted deny is **discarded**, not weighed — only an unrestricted name removes the tool                                                                       |

Grading is untouched by all of this: the same units are found, with the same
severities and the same score.

### Two states, one grade, two presentations

```
⚠ 34 of 38 model-invocable skill(s) declare no `disallowed-tools:` fence — each
  inherits every tool the session grants, so each holds all three legs.
  `allowed-tools:` does NOT fence a skill (it pre-approves; every tool stays
  callable), so narrowing it changes nothing here. …
      food-log-entry, handoff, render-paper, …

⚠ skill half (skills/half/SKILL.md): `disallowed-tools: Read` closes no
  lethal-trifecta leg — private-data read is still supplied by Grep, Glob, Bash …
```

- **No fence at all** (`fence: "none"`) is the **ecosystem default** — near enough
  100% of skills in the wild. Printed once, as **one aggregate line plus the
  names**. It is one fact about the harness, not N facts about N skills; a section
  that fires on every repo with a wall of identical text gets muted within a day,
  and takes the hard findings above it along.
- **A fence that closes no leg** (`fence: "ineffective"`) keeps its **own line**.
  It is rare, per-skill, and a real mistake — the author believed they had fenced
  and had not. Same shape as
  [disallowed-tools-contract](disallowed-tools-contract.md)'s "this entry blocks
  nothing".

**Presentation differs; severity and grade do not.** Both are `"advisory"` and
both count once toward the exposure penalty below. An ineffective fence has
capability ≤ no fence, so grading it _harder_ would re-create exactly the
non-monotonicity this rule was already fixed for once.

### The one-line fix

```yaml
---
name: food-log-entry
description: …
disallowed-tools: WebFetch, WebSearch, Bash # drops legs B and C
---
```

Legs B and C share their built-in suppliers, so one line closes both. For a
research skill that must reach the web, close leg A instead:
`disallowed-tools: Read, Grep, Glob, Bash`.

## In `vigiles audit`: graded, but a **ding — not a fail**

A trifecta finding is a **capability PATTERN with no exploit code**, not a
demonstrated vulnerability — attacker content _could_ be exfiltrated, but nothing
proves it will be. It's a **real risk worth surfacing in the grade**, yet
Anthropic's own official plugins ship the pattern on their cleanest surfaces (e.g.
the `feature-dev` plugin's `code-reviewer` subagent lists `Read, WebFetch,
WebSearch`), so fail-grading such a plugin to **F** would cry wolf. `vigiles audit`
threads that needle with a **capped exposure** penalty:

- **SHOWS** every trifecta unit (hard _and_ inherits-all) in the **Safety** ring
  and the report — a real, useful heads-up. Unfenced skills are shown as **one
  aggregate line plus their names**, not one line each; the exposure count below
  still counts **units**, so collapsing the presentation never shrinks the
  penalty.
- **DEDUCTS −10 per exposed unit, capped at −30 × the SHARE of the surface
  exposed** — so a trifecta dents the score without a catastrophic F. The
  **Safety** ring scores `100 − min(10 × exposed, 30 × exposed/assessable)`, is
  `n/a` only when there's no tool-bearing surface to assess (never a false 0), and
  is a clean 100 when surfaces exist but no trifecta. The `feature-dev` plugin's 3
  hard units → `−30` → **C (70/100)**, not F and not A.
- An **inherits-all (`"advisory"`)** unit is graded **exactly like an explicit
  one**. It holds all three legs implicitly _and every other capability besides_,
  so it cannot cost less than a declared all-three contract. Grading only the
  explicit case made the score non-monotone in risk: **declaring** a tool contract
  — a genuine risk reduction — could only ever LOWER the score. Measured on a real
  35-skill repo (2026-08-03): Safety read **70** while 35/35 units inherited
  everything (only the 3 declared units counted), and dropped toward **0** after
  contracts were added everywhere and exposure fell to **17/35**. The tool called
  the safer configuration strictly worse. Under the capped-exposure model the same
  two states read **70 → 85**.
- The **only** thing that moves a **skill** out of the exposed set is a
  `disallowed-tools:` fence that closes a whole leg. Adding or narrowing
  `allowed-tools:` moves the score by exactly **zero**, because it changes what the
  skill can do by exactly zero. (Regression-tested: a skill declaring
  `allowed-tools: Read, Grep` and one declaring every tool in the catalog produce
  byte-identical findings.)

The deduction lives on the single shared `reportDeductions` → `computeIntegrityScore`
path, so the audit overall and the plugin-health leaderboard read the SAME number.
This is a **separate axis from the lint rule below** — under `vigiles lint` you can
still raise `lethal-trifecta` to `"error"` to gate CI on it independently.

## High-precision (FP-safe)

On the **subagent** side, only **well-known, high-signal tools** map to a leg — an
unknown tool maps to nothing, so a bare unrecognized `mcp__*` never cries wolf. A
`Tool(restriction)` suffix is stripped to its base name. On the **skill** side the
FP control is the presentation, not the catalog: the unfenced default is true of
almost every skill, so it is stated once per harness rather than once per skill
(see [Two states, one grade, two presentations](#two-states-one-grade-two-presentations)).
**User-invoked** skills
(`disable-model-invocation: true`) are excluded — they're picked by an explicit
command, so they can't be hijacked by attacker content.

## Configuration

```json
{ "rules": { "lethal-trifecta": "warn" } }
```

### Severity

| Value              | Behavior                                                |
| ------------------ | ------------------------------------------------------- |
| `"error"`          | `vigiles lint` exits non-zero (2) on a trifecta finding |
| `"warn"` (default) | Prints a warning, exits 0 (don't-cry-wolf rollout)      |
| `false`            | Skip the check                                          |

Default is **`warn`** during rollout. Once you've confirmed it's quiet on your own
units, raise it to `"error"` to gate CI — an explicit all-three contract is a real
exfiltration risk worth blocking.

## Scope

Subagents (`agents/*.md`, on a harness with subagents) — read from `tools:` — and
model-invocable skills (`skills/*/SKILL.md`) — read from `disallowed-tools:`, never
from `allowed-tools:`. Skills exist on every harness; the subagent half is gated by
the active adapter's `subagents` capability.

## Why

The blast radius of a prompt-injected agent is bounded by what it can do, and the
deadliest shape is the one unit that can read, ingest, and exfiltrate at once. A
linter that checks one tool at a time never sees it; the **combination** is the
risk, and it's decidable from the declared contract — for free, no model.

## See also

- [subagent-tool-contract](subagent-tool-contract.md) — verifies the same `tools:`
  rail resolves to real tools.
- [disallowed-tools-contract](disallowed-tools-contract.md) — the SUBAGENT deny-side
  mirror (`disallowedTools:`); a skill's `disallowed-tools:` fence is read here
  instead.
