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

> **Today a unit that only inherits the session is reported once, as a cause —
> not once per unit.** A skill with no `disallowed-tools:` line (or a subagent
> with no `tools:` line) holds the three legs because the _session_ hands them to
> every unit, so that is one fact about the session. vigiles does not yet read
> the session's permissions, mode or MCP settings; that work is tracked in
> [#461](https://github.com/zernie/vigiles/issues/461). See
> [Where the legs come from](#where-the-legs-come-from).

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

The two severities describe **how the unit got there**, not how much it costs;
the cost follows the finding's **cause**, below.

### Where the legs come from

Every finding carries a `cause`, and it decides how the `audit` report shows the
finding and how the score charges it. `vigiles lint` does not use it: it reports
every unit that holds the trifecta, exactly as before (skills with no
`disallowed-tools:` line in one grouped line, every other finding at its file),
so CI still sees a unit that only inherits the session.

| `cause`   | what the unit's file shows                                                                                                                          | `audit` report        | Safety and overall     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------- |
| `session` | nothing: no `disallowed-tools:` line and no leg tool in `allowed-tools:` (skill), or no `tools:` line (subagent)                                    | one line for them all | charged once           |
| `fence`   | a fence or contract that does not work: a `disallowed-tools:` that closes no leg, an empty one, frontmatter that does not parse                     | its own line          | charged with `session` |
| `unit`    | the file adds a leg: `allowed-tools:` pre-approves a side-effecting leg tool (`Bash`, `WebFetch`, …) or any `mcp__*` tool, or an all-three `tools:` | its own line          | charged per unit       |

**Why.** Measured on 77 real repositories, 406 of 409 model-invocable skills held
the trifecta only because they declare no fence and inherit the session's tools.
A finding on each of them said the same thing 406 times: a reader learns to skip
it, and the finding that matters — a skill that pre-approves a production client,
a subagent whose `tools:` names all three legs — is lost in the noise. The cause
is the session, so it is stated once.

A `fence` finding is reported at its file because the author wrote something
that does not do what they meant. It is charged with the session, not per unit,
because the unit can do no more than an unfenced one: charging it per unit would
make a half-done fence score worse than no fence at all. The exception is a
skill whose `allowed-tools:` pre-approves a leg tool the fence does not deny:
`allowed-tools: Bash` with `disallowed-tools: []` still adds a leg, so it stays
`unit`. Otherwise a line that denies nothing would lower the charge.

`allowed-tools:` is still **not a fence** (see below). It counts here only as
evidence that the skill _adds_ something: a pre-approved tool runs without a
permission prompt while the skill is active, and an MCP tool reaches data outside
the repository. A read-only tool (`Read`, `Grep`, `Glob`) adds nothing: the harness runs
it without a prompt anyway, so pre-approving it changes nothing. This is an
interim rule; reading what the session itself allows is #461.

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
longer read as a bound; it only decides whether the skill adds a leg of its own
(see [Where the legs come from](#where-the-legs-come-from)).

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

### How skill findings read

```
⚠ Lethal trifecta: 34 unit(s) inherit the session's tools, and the session can
  read files, reach the web and run commands — one cause, counted once. One
  `disallowed-tools:` line per skill (a `tools:` line per subagent) that drops a
  leg closes it: food-log-entry, handoff, render-paper, review, ship +29 more.

⚠ skill half (skills/half/SKILL.md): `disallowed-tools: Read` closes no
  lethal-trifecta leg — private-data read is still supplied by Grep, Glob, Bash …

⚠ skill deploy (skills/deploy/SKILL.md): `allowed-tools:` pre-approves `Bash` —
  tools that supply a lethal trifecta leg — so they run without a permission prompt …
```

- **No fence and nothing added** (`cause: "session"`) is the **ecosystem
  default**. `audit` prints it as **one line** with the count and the first names.
- **A fence that closes no leg** (`fence: "ineffective"`, `cause: "fence"`) keeps
  its **own line**. The author believed they had fenced
  and had not — same shape as
  [disallowed-tools-contract](disallowed-tools-contract.md)'s "this entry blocks
  nothing".
- **A pre-approved leg tool or MCP tool** (`cause: "unit"`) keeps its own line.

Every skill finding is `"advisory"`. An ineffective fence has capability ≤ no
fence, so it never reads louder than one.

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

- **SHOWS** every trifecta unit in the **Safety** ring and the report — a real,
  useful heads-up. Units that only inherit the session are shown as **one line**
  (see [Where the legs come from](#where-the-legs-come-from)).
- **DEDUCTS −10 per unit that adds a leg (`cause: "unit"`), capped at −30 × the
  SHARE of the surface exposed** — so a trifecta dents the score without a
  catastrophic F. The `feature-dev` plugin's 3 hard units → `−30` → **C
  (70/100)**, not F and not A.
- **Units that hold only the session's legs (`session` and `fence`) are ONE
  cause, charged ONCE**: `min(10, 30 × their share)`. The weight is one unit's
  (`W_TRIFECTA`, 10), because one cause costs what one exposed unit costs; the
  share term keeps a small inheriting minority from costing more than it would
  per unit. A repo whose 400 skills all inherit loses 10, not 30.
- The **Safety** ring scores `100 −` the sum of the two, never more than `−30`.
  The sum is rounded once, not each part, so moving a unit from "adds a leg" to
  "inherits" (dropping a pre-approval) never costs a point. It
  is `n/a` only when there's no tool-bearing surface to assess (never a false 0),
  and a clean 100 when surfaces exist but no trifecta.
- An **inherits-all** unit is never free: it is in the one session charge.
  Declaring a contract that drops a leg clears it; declaring one that still names
  all three makes the finding the unit's own (`cause: "unit"`), charged per unit,
  because the contract now _declares_ the exfiltration path. The share cap stays:
  grading only the explicit case once made hardening a 35-skill repo read
  **70 → 0** (2026-08-03); under the capped model the same two states read
  **70 → 85**.
- The **only** thing that moves a **skill** out of the exposed set is a
  `disallowed-tools:` fence that closes a whole leg. Narrowing `allowed-tools:`
  never does: a narrow list and the widest one hold the same legs. What
  `allowed-tools:` decides is the **cause** — pre-approving a leg tool makes the
  finding the skill's own, charged per unit; dropping that pre-approval moves it
  back into the one session charge.

The deduction lives on the single shared `reportDeductions` → `computeIntegrityScore`
path, so the audit overall and the plugin-health leaderboard read the SAME number.
This is a **separate axis from the lint rule below** — under `vigiles lint` you can
still raise `lethal-trifecta` to `"error"` to gate CI on it independently.

## High-precision (FP-safe)

On the **subagent** side, only **well-known, high-signal tools** map to a leg — an
unknown tool maps to nothing, so a bare unrecognized `mcp__*` never cries wolf. A
`Tool(restriction)` suffix is stripped to its base name. On the **skill** side the
FP control is the cause, not the catalog: the unfenced default is true of almost
every skill, so it is stated once per harness rather than once per skill (see
[Where the legs come from](#where-the-legs-come-from)).
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
