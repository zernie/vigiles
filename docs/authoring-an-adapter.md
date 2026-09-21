# Authoring a harness adapter

vigiles ships an adapter for **Claude Code**. Teaching it a new harness — Codex,
Gemini CLI, OpenCode, or your own in-house agent runner — is **writing one
object** against five small port interfaces, then registering it. The core never
changes; the architecture boundary (`core ⊄ adapter`) guarantees it.

Everything you need is one import:

```ts
import {
  type HarnessAdapter,
  type HarnessDialect,
  type PluginLayout,
  type HarnessRuntime,
  type HookProtocol,
  type ModelMock,
  assertAdapterConformance,
} from "vigiles/adapter";
```

## The five ports

A harness differs from Claude Code along two axes — **format** (what it reads and
writes) and **transport** (how it runs) — captured by five descriptors:

| Port             | Axis      | What it describes                                                                                                               |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `HarnessDialect` | format    | built-in tool catalog, never-available tools, MCP tool shape, hook event names, instruction-file targets, plugin-root token     |
| `PluginLayout`   | format    | where the instruction file / skills / agents / commands / hooks / settings live on disk + the plugin-root token                 |
| `HarnessRuntime` | transport | the agent binary to spawn + the env a no-key mock model is reached through                                                      |
| `HookProtocol`   | transport | how a hook signals block/deny — the block exit code + the decision values + the events that honor `additionalContext` injection |
| `ModelMock`      | transport | the mock model's wire format (`anthropic-messages` / `openai-responses`) + endpoints                                            |

Each is a plain value object. Implement the ones your harness needs; the
conformance kit tells you what's missing.

## Write the adapter

A `HarnessAdapter` bundles the five ports plus two predicates — `detect(root)`,
which the CLI uses to recognize a repo, and `claims(path)`, which labels a
surface the audit found on its own:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { layoutClaims, type HarnessAdapter } from "vigiles/adapter";

const dialect: HarnessDialect = {
  name: "my-harness",
  builtinAgentTools: ["Run", "Edit", "Search"],
  neverAvailableTools: [],
  mcpToolPattern: /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i,
  hookEvents: ["PreToolUse", "PostToolUse", "Stop"],
  instructionTargets: ["AGENTS.md"],
  pluginRootToken: "${MY_PLUGIN_ROOT}",
};

const layout: PluginLayout = {
  name: "my-harness",
  manifestPath: ".myagent/config.json",
  hooksConventionPath: "hooks/hooks.json", // a FILE; omit it if the harness has none
  settingsPath: ".myagent/settings.json",
  settingsFormat: "json", // or "toml" (e.g. Codex's config.toml [hooks])
  instructionFile: "AGENTS.md",
  surfaces: {
    skill: "skills", // <dir>/<name>/SKILL.md
    agent: "agents", // omit the key entirely if the harness has no subagents
    command: "commands", // <dir>/<name>.md
  },
  // The second home a plain user keeps the same surfaces under — and the prefix
  // a relocated scope is keyed under. Omit it when the surface dirs already
  // carry their own prefix.
  userSurfaceRoot: ".myagent",
  pluginRootToken: "${MY_PLUGIN_ROOT}",
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcpServers",
  // Executable hook SCRIPTS, distinct from where hooks are REGISTERED. Omit it
  // when the harness has no scripts dir (in-process code-module hooks).
  hookScriptsDir: "hooks",
};

const runtime: HarnessRuntime = {
  name: "my-harness",
  agentBinary: "myagent",
  modelBaseUrlEnv: "MYAGENT_BASE_URL",
  modelApiKeyEnv: "MYAGENT_API_KEY",
  mockApiKey: "sk-mock",
};

const hookProtocol: HookProtocol = {
  name: "my-harness",
  blockExitCode: 2,
  denyDecisionValues: ["block", "deny"],
  eventEnvVars: [],
  // Events that honor `additionalContext` injection — so an inject/nudge hook
  // actually reaches the agent. A shellHooks adapter MUST declare at least one
  // (an empty list fails conformance); `compile` warns when an inject hook
  // targets an event NOT in this list.
  injectableEvents: ["SessionStart", "UserPromptSubmit", "PostToolUse"],
};

const modelMock: ModelMock = {
  name: "my-harness",
  wireApi: "openai-responses",
  modelEndpoint: "/v1/responses",
};

export const myHarnessAdapter: HarnessAdapter = {
  name: "my-harness",
  // What this harness can drive — gates which transport ports are required, and
  // which surface lint rules apply. `subagents:false` makes the subagent rules
  // (subagent-tool-contract, …) report n/a instead of running.
  capabilities: {
    referenceVerification: true, // always
    harnessTesting: true, // needs runtime + modelMock
    shellHooks: true, // needs hookProtocol
    subagents: true, // has a subagent surface (layout.surfaces.agent)
  },
  dialect,
  layout,
  runtime,
  hookProtocol,
  modelMock,
  // detect returns a *specificity score* (0 = not this harness; higher wins).
  // A strong signal (your own config dir) should outscore a weak one (a shared
  // AGENTS.md), so the registry picks the right adapter for a repo that looks
  // like several.
  detect: (root) => (existsSync(join(root, ".myagent")) ? 2 : 0),
  // claims answers "is this repo-relative path one my harness reads?" — a PATH,
  // never a root. The audit discovers surfaces by shape on its own and asks
  // every registered adapter to label what it found, so your adapter can never
  // widen what vigiles reads in somebody else's repo. A surface NO adapter
  // claims is reported as a finding rather than silently graded around.
  // `layoutClaims` derives the answer from your layout, so a layout that moves
  // takes its claim with it; override it only for a location the PluginLayout
  // fields cannot express.
  claims: (path) => layoutClaims(layout, path),
};
```

## Validate it

Drop the conformance checks in your test suite. `assertAdapterConformance`
verifies every port is populated, the cross-port invariants hold (names agree,
`instructionFile` is a declared target, the plugin-root tokens match), **and**
that your dialect drives the compiler. `assertAdapterLoadsHooks` is the
behavioural one — it round-trips a real settings file through your `layout`, so
a layout that points at the right file in the wrong format (the JSON-vs-TOML
trap) fails loudly instead of silently running zero hooks:

```ts
import { test } from "vitest";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
} from "vigiles/adapter";
import { myHarnessAdapter } from "./my-harness-adapter.js";

test("my adapter conforms", () => {
  assertAdapterConformance(myHarnessAdapter); // ports + invariants + compiler
  assertAdapterLoadsHooks(myHarnessAdapter); // settings-format round-trip
});
```

### How the registry tests your adapter automatically

You don't have to remember to write the calls above for an adapter you _ship_.
Once it's in the registry (`ADAPTERS`), the **contract suite**
(`src/adapter-contract.test.ts`) runs the whole conformance kit over **every**
registered adapter in a loop — so registering a harness auto-subjects it to every
contract, and you cannot leave a new harness untested. The suite is
**capability-gated**: a contract for a capability your adapter declares it lacks
(`shellHooks: false`, `harnessTesting: false`) becomes a **visible `it.skip(… n/a
…)`**, never a silent pass. A companion meta-test asserts every
`src/adapters/<dir>/` is either registered **or** a declared prototype — so an
adapter directory that exists but was never wired in **fails the build**. This is
the structural half of the [test-both-harnesses](harnesses.md) discipline: the
gap is caught by the registry, not by reviewer memory.

(Genuinely harness-_specific_ behaviour — your wire-format SSE renderer, a
real-binary integration test — still lives in your `src/adapters/<harness>/`
suite, gated/skipped loudly when the binary isn't on PATH.)

## Wire it up

- **Library use:** import your adapter and pass its ports —
  `compileAgent(spec, { dialect: myHarnessAdapter.dialect })`,
  `loadPlugin(path, myHarnessAdapter.layout)`.
- **CLI auto-detection:** add it to the registry (`src/adapter-registry.ts`
  `ADAPTERS`) so `vigiles compile|scan|lint` detect it from a repo's layout
  (highest `detect` specificity wins). Claude Code stays the default, so nothing
  existing breaks. Users force a harness with `--harness <name>` when a repo
  matches more than one.

## What's not a descriptor (yet)

Three seams still carry harness-specific _behaviour_, not just facts, and are
extracted opportunistically as a second real implementation lands: the instruction-file/skill **renderers**
in the compiler, the hook **decision-decode** beyond exit-code/values, and the
model-mock **HTTP server** (the `ModelMock` descriptor names the wire format; the
SSE renderer is per-harness). For a harness whose model can't be pointed at a
custom endpoint (a closed, hosted agent), the mock-backed test tiers don't apply
— you still get the full **reference-verification** layer.

## See also

- [`docs/adapter-api.md`](adapter-api.md) — the full **API reference**: every port field (with Claude Code + Codex example values), the conformance functions, and the registry API.
- [`docs/harnesses.md`](harnesses.md) — how a consumer _selects_ a harness.
