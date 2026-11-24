# `vigiles/harness/codex`

The OpenAI Codex harness: the adapter object, the OpenAI Responses mock, the
parser of `codex exec` output, and the eval and live drivers.

**For:** test authors targeting Codex. It sits beside
[`vigiles/harness/claude-code`](harness-claude-code.md): the same runners and
checks from `vigiles`, a different transport (the `codex` binary and the Responses
mock). Subagent contracts are Claude Code only.

Trigger-rate on Codex is experimental. Codex emits no skill-selection event, so
vigiles infers "fired" from a `SKILL.md` read and the number can be wrong either
way; treat it as directional. See
[Codex harness testing](../harness-testing-codex.md#trigger-rate-on-codex-is-experimental).

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).

## Typical tasks

### Run a deterministic test against real `codex exec`

Pass the adapter. The scripted model is plain text turns, with no key and no
network.

```ts
import { runHarnessTest } from "vigiles";
import { codexAdapter } from "vigiles/harness/codex";

const r = await runHarnessTest(
  {
    prompt: "say exactly HELLO_CODEX and nothing else",
    model: [{ text: "HELLO_CODEX" }],
    sandbox: false,
    timeoutMs: 60_000,
  },
  { adapter: codexAdapter },
);
console.log(r.output.includes("HELLO_CODEX"), r.modelRequests.length);
```

### Measure a skill's trigger rate on Codex

Pass the eval driver. The report is stamped experimental and a warning is printed.

```ts
import { defineEval, check } from "vigiles";
import { assertRates } from "vigiles/eval";
import { codexEvalDriver } from "vigiles/harness/codex";

export default defineEval({
  measureTriggerRate: {
    skillsDir: ".agents/skills",
    prompts: ["...tasks the skill should handle..."],
    irrelevantPrompts: ["...unrelated tasks..."],
    fired: check.skill("greet"),
    trials: 2,
  },
  evalDriver: codexEvalDriver,
  assert: (report) => assertRates(report, { min: 0.5 }),
});
```

### Drive the Responses mock directly

```ts
import { startCodexMock } from "vigiles/harness/codex";

const mock = await startCodexMock([{ text: "HELLO_CODEX" }]);
try {
  // point a `codex exec` at mock.url, then read mock.requests
} finally {
  await mock.close();
}
```

## Exports

- `codexAdapter`: the Codex adapter and its five ports plus drivers. Pass it to the runners as `{ adapter }`.
- `parseCodexRun`: parse the plain-text stdout of a deterministic `codex exec` run.
- `startCodexMock`: start the OpenAI Responses mock with a script of text turns.
- `CodexTurn`: one scripted turn: its `text`.
- `CodexRequest`: one request the mock received: `prompt`, `model` and `toolNames`.
- `CodexMockHandle`: the running mock: `url`, `port`, `requests` and `close`.
- `codexEvalDriver`: the eval-tier driver; read `codex exec --json` and carries the experimental caveat. Pass it as `evalDriver`.
- `codexLiveDriver`: the driver for the executing audit tiers, reached through `codexAdapter.liveDriver()`.
