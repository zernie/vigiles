# Testing output styles

An **output style** is a file that sets how the agent talks for a whole
session — "end every reply with a status block", "answer in English", "show the
code you discuss". The harness sends it to the model with every request of the
main session, chosen by a name in the settings. Nothing enforces it: the model
follows it or does not, and when the style stops loading, nothing says so.

This page is about testing one. The audit rule that asks for a test is
[`untested-output-style`](rules/untested-output-style.md).

## Why a style needs a test

Two ways a style fails without anyone seeing it:

- **It never loads.** Claude Code matches the `outputStyle` setting to the
  style's name exactly. A setting that misses — `status footer` for a style
  named `Status Footer` — loads no style and raises no error. A test that only
  checks the run succeeded passes, testing nothing.
- **It runs twice in one message.** A style that says "one status block per
  user message" printed two: a Stop hook blocked the agent's first reply, the
  agent replied again, and each reply ended with a block. The run's `output`
  holds only the last reply, so a test reading `output` saw one block.

## The three tiers

```
                    what runs              model           cost   answers
 audit              vigiles audit / lint   none            free   is there a test beside the style?
 harness            runHarnessTest         scripted fake   free   did the style reach the model?
                                                                  what did the agent print, reply by reply?
 eval               vigiles/eval           real            paid   does a real model FOLLOW the style?
```

Each tier answers only its own question. A green harness test proves the style
was delivered; a scripted model does not read it, so nothing in that tier says
it is followed.

**What no tier sees: the client.** How a chat client draws the run — whether a
reply the Stop hook forced appears inside the same message as the one before
it — happens after the agent is done. A test can show the agent printed two
status blocks for one user message; whether a reader sees them as one message
is the client's rendering, outside any harness.

## Harness tier: `runHarnessTest({ outputStyle })`

Pass the style **file**. vigiles writes it where the harness keeps styles and
selects it by the name the harness reads from the file — you never type the
name, so you cannot mistype it.

```ts
import { runHarnessTest } from "vigiles";

const r = await runHarnessTest({
  outputStyle: ".claude/output-styles/status-footer.md",
  transcript: true,
  prompt: "hi",
  model: [{ text: "done\n---\n**Status** idle" }],
});
// Reaching here means the style reached the model: when no request carries
// it, runHarnessTest throws instead of returning, and keeps the work dir.
```

It refuses before running when:

- the harness has no output styles (Codex);
- the fixture already has a file where the style goes;
- the fixture's `settings` already pick a style;
- the harness cannot tell the style's name from the file.

### Every reply: `replies`

`output` is the run's last reply. `replies` is every reply, in order — the one
a Stop hook made the agent follow up on included. Needs `transcript: true`.

```ts
const r = await runHarnessTest({
  outputStyle: ".claude/output-styles/status-footer.md",
  transcript: true,
  settings: {
    hooks: {
      Stop: [
        /* a hook that blocks the first stop */
      ],
    },
  },
  model: [
    { text: "first\n---\n**Status** A" },
    { text: "second\n---\n**Status** B" },
  ],
});
r.output; // "second\n---\n**Status** B"
r.replies; // ["first\n---\n**Status** A", "second\n---\n**Status** B"]
const footers = (r.replies ?? []).filter((t) => t.includes("**Status**"));
// footers.length === 2: one user message, two status blocks
```

`replies` is absent on a harness whose run output does not tell replies apart.

## Eval tier: does a real model follow it?

A style is not chosen by the model, so there is no trigger rate to measure
(`measureTriggerRate` does not apply). Compare runs with and without the style,
and check every reply of each run.

```ts
import { output, outputStyleArms, replyCount } from "vigiles";
import { paid_measureArms } from "vigiles/eval";

// Free: one run with the scripted model proves the style reaches the model,
// then the arms are built from the FILE — no name typed by hand.
const arms = await outputStyleArms(".claude/output-styles/status-footer.md");

// Paid: a real model, both arms.
const report = await paid_measureArms({
  arms,
  task: "summarise README.md",
  checks: [
    replyCount(/\*\*Status\*\*/, { max: 1 }), // one block per user message
    output(/\*\*Status\*\*(?:\n- [^\n]*)+\s*$/), // …and the message ends with it
  ],
  trials: 10,
});
```

`outputStyleArms` throws before the first paid trial when the harness has no
output styles, cannot tell the style's name, or the style does not reach the
model. The paid run itself cannot check that: it drives the real API, so no
request is captured (`modelRequests` is empty). The free run writes the same
files and settings the "with" arm gets, through the same binary.

Do not use the `output_style` field of Claude Code's `init` stream event as
proof that a style loaded: measured on 2.1.291, it repeats the setting even
when no style by that name exists.

For a rule with no checkable shape, use `paid_judged`. Gate the rates with
`assertRates`. This tier calls a real model and costs money; run it on purpose,
not on every push.

Pick the check by what the rule counts. `eachReply` is for a rule about every
reply ("answer in English"); `replyCount` is for a rule about the user's message
as a whole ("one status block per message"), because a Stop hook can make one
message two replies.

**Run on Claude Code 2.1.291, `sonnet`, 3 trials per arm, 2026-10-06**, with
the status-block style from the example:

| arms                                                 | with the style | without |
| ---------------------------------------------------- | -------------- | ------- |
| plain prompt: every reply has a status block         | 3 of 3         | 0 of 3  |
| a Stop hook forces a second reply: at most one block | 3 of 3         | 3 of 3  |
| …and the message ends with the block                 | 0 of 3         | 0 of 3  |

The second and third rows are why `replies` exists: the model put the block on
its first reply, as the rule says, and the reply the hook forced came after it,
so the reader sees the block in the middle of the message. `output` shows only
the second reply and would have reported "no block".

Still open: **one prompt per comparison** (`task`), while a style rule usually
needs a varied set of prompts to say anything. Run the comparison once per
prompt.

## Per harness

| harness     | output styles                                                                                        | audit                       | `outputStyle` option         |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------- |
| Claude Code | `.md` files in `.claude/output-styles/` (or a plugin's `output-styles/`), selected by `outputStyle`  | flags an untested style     | ✅                           |
| Codex       | none — a `personality` preset (`none`, `friendly`, `pragmatic`) and instruction keys, no style files | prints `Output styles: n/a` | throws: the harness has none |
| OpenCode    | not described by its adapter yet                                                                     | n/a                         | throws                       |

The Codex row was checked against its configuration reference on 2026-10-06:
`personality` is "Default communication style for models that advertise
supportsPersonality", and `model_instructions_file` / `developer_instructions`
replace or add instructions. Neither is a named file a setting switches on.

What Claude Code does with a style — which files load, how a name is read,
how the style is delivered — was measured on Claude Code 2.1.291 and is pinned
by tests in `src/adapters/claude-code/output-style.test.ts`.

## See also

- [`untested-output-style`](rules/untested-output-style.md) — the audit rule.
- [Testing your harness](harness-testing.md) — every tier, and which to pick.
