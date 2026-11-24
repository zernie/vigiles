# `vigiles/harness/kit`

The authoring kit for teaching vigiles a new harness. It holds the five port
interfaces you implement, the `HarnessAdapter` bundle that groups them, the
conformance checks that validate your adapter, and the driver ports the test and
eval runners call.

**For:** people adding a harness beyond Claude Code and Codex (Gemini CLI,
OpenCode, an in-house agent runner). Almost nothing here is a function to call in
a normal test; most names are types you implement. If you only test a harness
that already ships, you do not need this entry.

Walkthrough: [authoring a harness adapter](../authoring-an-adapter.md). Field by
field: [the adapter API reference](../adapter-api.md). Signatures are in the
[generated API reference](https://zernie.github.io/vigiles/api/).

## Typical tasks

### Describe your harness with the five ports

Each port is a plain object. `layoutClaims` derives the adapter's `claims(path)`
from its layout.

```ts
import {
  layoutClaims,
  type HarnessAdapter,
  type HarnessDialect,
  type PluginLayout,
} from "vigiles/harness/kit";

export const myDialect: HarnessDialect = {
  name: "my-harness",
  builtinAgentTools: ["Run", "Edit", "Search"],
  neverAvailableTools: [],
  mcpToolPattern: /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i,
  hookEvents: ["PreToolUse", "PostToolUse", "Stop"],
  instructionTargets: ["AGENTS.md"],
  skillFrontmatterKeys: ["name", "description"],
  pluginRootToken: "${MY_PLUGIN_ROOT}",
};
// ...then a PluginLayout, HarnessRuntime, HookProtocol and ModelMock, bundled
// as a HarnessAdapter whose `claims` is (path) => layoutClaims(layout, path).
```

The full adapter, with every required field, is in
[authoring a harness adapter](../authoring-an-adapter.md#write-the-adapter).

### Validate the adapter in your test suite

```ts
import { test } from "vitest";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
} from "vigiles/harness/kit";
import { myHarnessAdapter } from "./my-harness-adapter.js";

test("my adapter conforms", () => {
  assertAdapterConformance(myHarnessAdapter); // pure: ports present and consistent
  assertAdapterLoadsHooks(myHarnessAdapter); // does IO: a rendered hook loads back
});
```

### Get the failures as data

```ts
import { checkAdapterConformance } from "vigiles/harness/kit";

const { ok, failures } = checkAdapterConformance(myHarnessAdapter);
if (!ok) console.error(failures.join("\n"));
```

### Read a layout the way vigiles does

```ts
import { surfaceDirs, executableSourceDirs } from "vigiles/harness/kit";
import { claudeCodeAdapter } from "vigiles/harness/claude-code";

surfaceDirs(claudeCodeAdapter.layout); // ["skills", "agents", "commands"]
executableSourceDirs(claudeCodeAdapter.layout); // the same plus "hooks"
```

## Exports

### Adapter bundle

- `HarnessAdapter`: the bundle of ports, drivers and predicates (`detect`, `claims`) that makes up a harness.
- `AdapterCapabilities`: what an adapter can do: `harnessTesting`, `shellHooks`, `subagents`.

### Format ports

- `HarnessDialect`: the built-in tool catalog, hook event names, instruction targets, skill frontmatter keys and plugin-root token.
- `PluginLayout`: where the instruction file, skills, agents, commands, hooks and settings live on disk.
- `SurfaceDirs`: the directory of each surface kind.
- `SurfaceKind`: a surface kind: `skill`, `agent` or `command`.
- `SkillDiscovery`: how skills are found on disk, including depth and hidden directories.
- `surfaceDirs`: the surface directories a layout declares.
- `executableSourceDirs`: the surface directories plus the hook scripts directory.
- `layoutClaims`: whether a path belongs to a layout; use it to build `claims`.
- `SettingsCodec`: how a harness reads and writes its settings file.
- `jsonSettingsCodec`: the ready-made codec for JSON settings.
- `tomlSettingsCodec`: the ready-made codec for TOML settings.

### Transport ports

- `HarnessRuntime`: the agent binary to spawn and how a keyless mock model is reached.
- `RequestCapture`: how to make a run record its model requests.
- `RequestChannel`: one run's request channel, from `open()`.
- `RunEnvPolicy`: which environment variables and home files a child run keeps.
- `HookProtocol`: how a hook signals block, deny and injection, and how hooks are registered.
- `ModelMock`: the mock model's wire format and endpoints.

### Output styles and skill listing

- `OutputStyleRules`: how a harness stores output styles and switches one on.
- `OutputStyle`: one style as read from its file.
- `StyleSelection`: what a settings object says about the output style: absent, the default, or a named style.
- `SkillListingRules`: how a harness renders skills into its session-start listing.
- `SkillListingBudget`: how a harness sizes that whole listing.
- `ListedSkill`: one skill as the harness would list it.
- `ListingLimit`: the listing's budget for one commit and what set it.

### Instruction chain

- `InstructionChain`: every instruction file a harness loads for a directory, with what is not loaded and why.
- `LoadedInstruction`: one loaded file, its role and scope.
- `UnloadedInstruction`: a file present but not loaded, with the reason.
- `NotLoadedReason`: why: replaced, on demand, excluded by settings or superseded.
- `InstructionRole`: what a file is to the harness: root, local root, rule, fallback or import.
- `InstructionScope`: whether a file is committed (`repo`) or one machine's (`local`).
- `NamedImport`: a path a loaded file names, with the text that names it.
- `PatternFrom`: a glob or URL a loaded file names.

### Drivers

- `HarnessTestDriver`: what a harness brings so `runHarnessTest` can drive it: arguments, mock, parser.
- `EvalDriver`: what a harness brings for the paid runners: a runner, an output parser, and an optional experimental caveat.
- `AgentRunner`: runs one trial and returns its raw output.
- `AgentRunArgs`: the per-trial arguments an `AgentRunner` receives.
- `ModelOutputParser`: maps a trial's raw output to run facts.
- `ParsedModelRun`: those facts: output, tool calls, turns, hooks, subagents and usage.
- `RunOut`: a trial's raw output: exit code, streams and timeout flag.

### Conformance

- `checkAdapterConformance`: check an adapter without IO and return the failures.
- `assertAdapterConformance`: throw listing every failure.
- `assertAdapterLoadsHooks`: write a hook with the adapter's own ports, load it back through its layout, and throw if none loads.
- `ConformanceResult`: `ok` and the list of `failures`.
