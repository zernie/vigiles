# `vigiles/harness/claude-code`

The Claude Code pieces of a harness test: the adapter object, the plugin loader,
the scripted Anthropic Messages mock, the parsers of Claude Code's output, the
skill-selection matrix, and the typed spec builders checked against Claude Code's
tool catalog.

**For:** test authors targeting Claude Code. The harness-agnostic runners and
checks (`runHarnessTest`, `runHook`, `check`) live on the `vigiles` root; this
entry is what you pass them when the harness is Claude Code. Codex has its own
entry, [`vigiles/harness/codex`](harness-codex.md).

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).
Guides: [Claude Code harness testing](../harness-testing-claude-code.md) and the
[testing API](../testing-api.md).

## Typical tasks

### Script a model and run the real `claude` against it

No key, no cost: `claude` talks to an in-process mock that plays your turns in
order. A run that asks for a turn past the end of the script fails.

```ts
import { runHarnessTest, check, assertChecks } from "vigiles";
import { scriptModel } from "vigiles/harness/claude-code";

await using r = await runHarnessTest({
  settings: {
    hooks: {
      Stop: [
        {
          hooks: [{ type: "command", command: "test -f {cwd}/DONE || exit 2" }],
        },
      ],
    },
  },
  model: scriptModel([
    { text: "done?" },
    { tool: "Bash", input: { command: "touch DONE" } },
    { text: "done" },
  ]),
});
assertChecks(r, [check.writes({ include: ["DONE"] })]);
```

### Load a plugin the way Claude Code assembles it

`loadPlugin` reads the manifest and hooks, materializes skills and agents, and
lists the surfaces only a real model can drive in `warnings`.

```ts
import { loadPlugin } from "vigiles/harness/claude-code";

const plugin = loadPlugin("./my-plugin");
console.log(plugin.settings.hooks, Object.keys(plugin.files), plugin.warnings);
```

### Unit-test a file hook with both path spellings

Claude Code sends an absolute `file_path`; hand-written relative events hide bugs.
`fileToolEvents` returns both.

```ts
import { runHook } from "vigiles";
import { fileToolEvents } from "vigiles/harness/claude-code";

for (const event of fileToolEvents("src/index.ts")) {
  const result = runHook("node .claude/hooks/guard.mjs", event);
  console.log(result.blocked);
}
```

### Catch one skill stealing a sibling's prompts

```ts
import {
  measureSelectionMatrix,
  assertNoCollision,
} from "vigiles/harness/claude-code";

const report = await measureSelectionMatrix("./my-plugin", { trials: 1 });
assertNoCollision(report, { maxOffDiagonal: 0.2 });
```

This calls a real model. Prompts are derived from each skill's description unless
you pass `prompts`.

### Get a compile-time error for a bad tool and purity pair

```ts
import { experimental_agent } from "vigiles/harness/claude-code";

experimental_agent({
  name: "reader",
  description: "Read-only reviewer.",
  purity: "pure",
  tools: ["Read", "Bash"], // tsc error: Bash is side-effecting
});
```

## Exports

### Adapter

- `claudeCodeAdapter`: the Claude Code adapter; its ports (`layout`, `dialect`, `runtime`, `hookProtocol`, `modelMock`, `harnessTestDriver()`) and its tool catalog (`builtinAgentTools`, `sideEffectingTools`) are fields of it. Pass it to the runners as `{ adapter }`.

### Plugin loader

- `loadPlugin`: read a plugin or repository directory into hooks settings, materialized files, and warnings.
- `LoadedPlugin`: what `loadPlugin` returns.

### Scripted model

- `scriptModel`: build a turn script from text turns and scripted tool calls.
- `startMock`: start the Anthropic Messages mock on a free port, for driving it directly.
- `MockHandle`: the running mock: `url`, `requests`, `count`, `sideChannelCount` and `close`.
- `TurnInfo`: what the `onTurn` callback of `startMock` receives for each turn.

### Reading a run

- `claudeAvailable`: whether the `claude` binary can be run here; use it to skip or fail loudly.
- `parseToolCalls`: the tool calls of a `stream-json` transcript.
- `parseClaudeRun`: a real-model run's raw output parsed into the common run fields.
- `fileToolEvents`: both spellings of a file-tool hook event, for `runHook`.
- `FileToolEventOptions`: options of `fileToolEvents`: `tool`, `event`, `input`, `extra` and `root`.

### Skill selection

- `measureSelectionMatrix`: run each skill's prompts against the whole installed set and record which skill fires.
- `assertNoCollision`: throw when a skill's prompts are taken by a sibling above a ceiling, or when nothing was measured.
- `SelectionMatrixOptions`: options of `measureSelectionMatrix`, including curated `prompts`.
- `SelectionOptions`: model, trials, concurrency and effort, shared with the audit's trigger tier.
- `SelectionReport`: the matrix, the collision rate and the per-skill stats.
- `SkillSelectionStat`: one skill's recall, collision rate and the skills it collides with.

### Typed spec builders

- `experimental_agent`: the same builder as in [`vigiles/spec`](spec.md), with `tools` checked against Claude Code's tool catalog at each purity level.
- `experimental_skill`: the same skill builder, with the same check.
- `ClaudeCodeToolVocabulary`: the tool vocabulary behind that check.
- `ClaudeCodeBuiltinTool`: every built-in Claude Code tool name.
- `ClaudeCodeSideEffectingTool`: the built-in tools that change something.
- `ClaudeCodeReadOnlyTool`: the built-in tools that only read.
- `ClaudeCodeBoundedTool`: the tools a `bounded` unit may declare.
