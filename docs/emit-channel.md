# The emit channel — a skill returns a typed result by calling a tool

⚠️ **`experimental_emitTool` — the shape is not settled.** The prefix is on every
call site, so no one has to have read this page to know that. What this page adds
is _why_: the measurements behind the channel, and the conditions that would
retire the prefix.

Import it from the package root:

```ts
import { experimental_emitTool, experimental_assertEmittedOk } from "vigiles";
```

It sits beside `parseAgentResult` / `experimental_assertAgentOk`, which are its twins on the
other delivery shape — a comparison the [choosing a channel](#choosing-a-channel)
section below makes directly.

## The problem it addresses

A typed result (`output:` + `result()`) is valid **only on a forked skill**. `vigiles compile` hard-errors `output-without-fork` on every other one, and that is deliberate: an inline skill is spliced into the conversation, so it has no call→return boundary and therefore no return value to type.

A **tool call needs no return boundary**. The skill does not _return_ the structure — it _emits_ it, mid-conversation, and the call lands in `Trace.toolCalls`. The objection that grounds the exclusion does not apply to this delivery. It is the same `OutputContract`, reached a different way.

<!-- vigiles:check -->

```ts
import { experimental_emitTool } from "vigiles";
// `result()` builds the contract and lives on the authoring surface, not the
// testing one — two doors on purpose, and the reason this line is easy to forget.
import { experimental_agent } from "vigiles/spec";
const { result } = experimental_agent;

const CONTRACT = result(
  // `["CUT", "MERGE", "KEEP"]` is an ENUM — the permitted values travel with the tool
  // definition, so the model sees them even if it skimmed the prose around them.
  { verdict: ["CUT", "MERGE", "KEEP"], count: "number", report: "string" },
  { reason: "string" },
);

const emit = experimental_emitTool(CONTRACT);
//  emit.instruction — paste into the skill body, in place of a prose "report your verdict"
//  emit.tool        — the JSON-Schema tool definition, served from your own MCP server
```

In a test the emission is read back off the trace, not off stdout:

```ts
const v = experimental_assertEmittedOk(trace.toolCalls, CONTRACT);
assert.equal(v.verdict.startsWith("BLOCKED"), true);
assert.ok(v.count > 0); // `count` is a number because the contract said so
```

## How a wrong emission is caught

The reader is **total**: every way an emission can fail to satisfy the contract has its own
branch with its own reason. There is no "it happened to look fine" path.

| what the model did                             | what you get back                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| never called the tool                          | `malformed` — `no \`emit_result\` tool call in the run`                                                                                    |
| called it twice                                | `malformed` — `called 2 times; the contract is exactly once`                                                                               |
| called it with no object argument              | `malformed` — `carried no object argument`                                                                                                 |
| omitted `track` (or sent something else)       | `malformed` — `has no \`track\` of "ok" or "err"`                                                                                          |
| declared a track, sent no payload for it       | `malformed` — `declared track "ok" but carried no \`ok\` object`                                                                           |
| sent a payload that misses or mistypes a field | `malformed` — `ok payload: field "verdict" should be "CUT" \| "MERGE" \| "KEEP"`                                                           |
| **the call itself was denied or errored**      | `malformed` — `errored or was denied; nothing reached the server. Check the tool's permissions and the exact spelling in \`allowedTools\`` |

The last row is worth dwelling on, because until 2026-08-19 it was a **silent success**: the
reader filtered calls by name and never looked at `ToolCall.isError`, so a permission-denied
call carrying a valid payload returned `ok` for an emission the server never received. A
wrong `allowedTools` spelling is the likely cause, not an exotic one — MCP names are
host-mangled (`mcp__plugin_<plugin>_<server>__emit_result` on Claude Code, two segments on
Codex), so getting it wrong is easy.

Two neighbouring collapses are avoided on purpose: a denied call is **not** reported as "no
call" (that sends you to the skill's instructions when the fault is in permissions), and a
retried denial is **not** reported as "called twice" (a true signal under a false name). A
successful call alongside a denied one is one successful emission — the contract was met.

**What none of this catches: whether the emitted result is TRUE.** The channel checks form.
A skill that emits `verdict: "KEEP"` about work it never did is well-formed and wrong, and
no schema can say otherwise. Gating on an emitted verdict was measured and rejected —
self-report disagreed with a judged check in 45–75.8% of runs.

## Choosing a channel

Both channels deliver **exactly one** result. That is easy to miss, because
"emit" sounds like a stream: it is not, and the reader treats a second call as a
defect (`called 2 times; the contract is exactly once`). So the choice between
them is **not** about how many results you have.

It is about whether the skill has a place to return to.

|                            | `output:` + `result()`                                                                    | `experimental_emitTool`                                     |
| -------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **How the result travels** | the skill's return value, as a fenced block                                               | a tool call, mid-conversation, landing in `Trace.toolCalls` |
| **Where it is valid**      | **forked skills only** — `vigiles compile` hard-errors `output-without-fork` on any other | anywhere, including an inline skill                         |
| **What you have to run**   | nothing                                                                                   | your own MCP server, serving `emit.tool`                    |
| **What you have to write** | the `output:` field                                                                       | paste `emit.instruction` into the skill body by hand        |
| **Covered by semver**      | yes                                                                                       | no                                                          |

**Pick `output:` whenever the skill can afford to fork.** It is stable, it costs
no infrastructure, and the compiler emits it for you.

**Reach for emit when the skill must stay inline.** An inline skill is spliced
into the conversation rather than called, so it has no call→return boundary and
no return value to type — which is exactly what `output-without-fork` is saying.
A tool call needs no such boundary, so the objection that grounds the exclusion
does not apply to this delivery. It is the same `OutputContract`, reached a
different way.

**Why there are two rather than one.** The obvious consolidation — let emit
absorb `output:` — is measured and currently rejected on cost: emit requires the
caller to stand up an MCP server and hand-paste the instruction, because neither
`compileSkill` nor `compileAgent` emits it (`src/experimental-emit.ts:26-29`).
Where the boundary already exists, `output:` is strictly cheaper. Should the
compile-time path in gap 2 below land, this trade changes and the question is
worth reopening.

## What is measured, and what is not

**2026-08-13, one skill, sonnet:** 8 runs, 8 emits, all on `ok`, all parsing, none repeated.

**2026-08-14, breadth — five real skills, two models:** on sonnet **15 emissions from 15
runs**, across bodies of 97 and 354 lines, two insertion modes, and two natural languages.
On haiku a **zero appears**: `cold-read-diff` emitted on 1 run of 3 — and not because the
channel dropped anything. The skill stopped on its third turn without reaching its own first
step, so there was nothing to emit. That distinction is why **the pooled number is not
printed**: across both models it would read as 19/21 ≈ 90% while containing a skill at 33%.

**2026-08-19, serving:** a plugin-bundled MCP server registers (`√ Connected`), the model
called it, and the payload reached the server — confirmed by the server's own log, not only
by the transcript. So question 3 below is answered.

**Still not measured, and each could reshape the surface:**

1. **The rate.** 15-of-15 on one model is not a reliability claim; the design calls for ≥30
   runs and ≥2 models before the number means anything.
2. **Nothing depends on it yet.** Neither `compileSkill` nor `compileAgent` emits the
   instruction — you paste `.instruction` and serve `.tool` by hand.
3. **Triggering** — whether adding the instruction changes how often the skill fires at all.
   Deliberately skipped, with the reasoning written down rather than the number guessed.
4. **A COMPILED `SKILL.md` has never been observed loading as an installed skill.** The
   `vigiles:sha256:` header pushes frontmatter off line 1. The neighbouring surface (a
   compiled subagent) was measured working, a skill was not — so the compile-time path is
   theory until that first end-to-end run.

## What it does NOT buy — stated because it is the obvious thing to assume

- **It does not enforce the schema.** The runtime does **not** enforce a tool's declared `required` fields — measured, with the raw call captured in the examples directory. A call with missing required fields reaches the server. Validation therefore lands in **your** receiving code, exactly as it would with a fenced block. What the contract buys is a _typed reader_, not a guaranteed writer.
- **It does not remove `Bash` from a skill.** `allowed-tools` is **pre-approval, not restriction**. Dropping `Bash` from the list removes a permission prompt, not the capability.

## To drop the `experimental_` prefix

Three conditions, one of them now met:

- ~~an answer to whether a plugin can serve the tool without a separate process~~ — **answered
  2026-08-19**. It can serve the tool; "without a process" turns out not to exist for anything
  in the shipped CLI (hooks are processes too), so the question was retired rather than passed.
- **Breadth** — partly: five skills, two models, but on a subset. Needs ≥30 runs.
- **A compile-time path** so the instruction is not hand-pasted. Not started; the design is
  locked and its first gate is the end-to-end run in point 4 above.

## The non-experimental alternative

A **forked** skill (`context: "fork"`) with an `output:` contract, parsed by `parseAgentResult`. It is stable, it is covered by semver, and it is the right answer whenever the skill can afford to run as a subagent.

## See also

- [`skills.md`](skills.md) — authoring the skill this channel reports from.
- [`spec-format.md`](spec-format.md) — `result()` and the `output:` contract on a forked skill.
- [`testing-api.md`](testing-api.md) — `Trace`, `toolCalls`, and the check vocabulary the assertion composes with.
