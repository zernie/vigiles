# `vigiles/adapter` — API reference

The harness-adapter authoring API. Everything an adapter author needs — yours or
ours — in one import. This is the **reference**; for a guided walkthrough see
[`docs/authoring-an-adapter.md`](authoring-an-adapter.md).

```ts
import {
  // port interfaces (types)
  type HarnessAdapter,
  type HarnessDialect,
  type PluginLayout,
  type HarnessRuntime,
  type HookProtocol,
  type ModelMock,
  // conformance
  checkAdapterConformance,
  assertAdapterConformance,
  assertAdapterLoadsHooks,
  type ConformanceResult,
  // registry / detection
  ADAPTERS,
  defaultAdapter,
  detectAdapter,
  detectAdapterResult,
  resolveAdapter,
  getAdapter,
  type DetectResult,
} from "vigiles/adapter";
```

**Stability.** The five port interfaces and `HarnessAdapter` are the stable
contract — changes to them are semver-major. The conformance and registry
functions are stable. The behaviour _behind_ the descriptors (the renderers, the
mock HTTP server) is internal and may change between minors.

---

## Port interfaces

A harness differs from Claude Code along two axes — **format** (what it reads and
writes) and **transport** (how it runs). Each port is a plain, fully-`readonly`
value object.

### `HarnessDialect` (format)

The harness vocabulary the compiler verifies against.

| Field                 | Type                | Meaning                                                 | Claude Code                          | Codex                                                |
| --------------------- | ------------------- | ------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `name`                | `string`            | stable id                                               | `"claude-code"`                      | `"codex"`                                            |
| `builtinAgentTools`   | `readonly string[]` | tools a subagent may list in its contract               | `["Read","Write","Edit","Bash",…]`   | `["shell","apply_patch","update_plan","web_search"]` |
| `neverAvailableTools` | `readonly string[]` | tools the platform never exposes (a listed one is dead) | `["Agent","ExitPlanMode",…]`         | `[…]`                                                |
| `mcpToolPattern`      | `RegExp`            | matches an MCP tool ref                                 | `/^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i` | same                                                 |
| `hookEvents`          | `readonly string[]` | hook event names the harness fires                      | `["PreToolUse","PostToolUse",…]`     | `[…,"PermissionRequest","SubagentStart"]`            |
| `instructionTargets`  | `readonly string[]` | instruction-file targets (also the h1)                  | `["CLAUDE.md","AGENTS.md"]`          | `["AGENTS.md"]`                                      |
| `pluginRootToken`     | `string`            | env token expanded to the plugin root                   | `"${CLAUDE_PLUGIN_ROOT}"`            | `"${PLUGIN_ROOT}"`                                   |

**Consumed by:** `compileAgent(spec, { dialect })` — verifies the subagent
tool-contract against `builtinAgentTools`/`neverAvailableTools`/`mcpToolPattern`.

### `PluginLayout` (format)

Where the harness keeps things on disk.

| Field                 | Type                                             | Meaning                                                                                                                                             | Claude Code                                                 |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `name`                | `string`                                         | stable id                                                                                                                                           | `"claude-code"`                                             |
| `manifestPath`        | `string`                                         | plugin manifest                                                                                                                                     | `".claude-plugin/plugin.json"`                              |
| `hooksConventionPath` | `string?`                                        | standalone hooks FILE convention; omit when the harness has none (OpenCode's hooks are code modules)                                                | `"hooks/hooks.json"`                                        |
| `settingsPath`        | `string`                                         | repo settings carrying hooks                                                                                                                        | `".claude/settings.json"`                                   |
| `settingsFormat`      | `"json" \| "toml"`                               | how the settings file is encoded                                                                                                                    | `"json"` (Codex: `"toml"`)                                  |
| `instructionFile`     | `string`                                         | top-level instruction file                                                                                                                          | `"CLAUDE.md"`                                               |
| `surfaces`            | `Readonly<Partial<Record<SurfaceKind, string>>>` | where each model surface lives, keyed by kind (`skill`/`agent`/`command`); an ABSENT key is the only spelling of "this harness has no such surface" | `{ skill: "skills", agent: "agents", command: "commands" }` |
| `userSurfaceRoot`     | `string?`                                        | the second home an END USER keeps the same surfaces under — and the prefix a relocated scope is keyed under                                         | `".claude"` (Codex/OpenCode: omitted)                       |
| `rulesDir`            | `string?`                                        | path-scoped instruction dir (an instruction is READ, not invoked — so not a `SurfaceKind`)                                                          | `"rules"`                                                   |
| `hookScriptsDir`      | `string?`                                        | dir holding executable hook SCRIPTS, distinct from where hooks are registered                                                                       | `"hooks"` (OpenCode: omitted)                               |
| `pluginRootToken`     | `string`                                         | the plugin-root token (must match the dialect's)                                                                                                    | `"${CLAUDE_PLUGIN_ROOT}"`                                   |
| `mcpConfigFile`       | `string`                                         | standalone MCP config                                                                                                                               | `".mcp.json"`                                               |
| `mcpManifestKey`      | `string`                                         | manifest key declaring MCP servers                                                                                                                  | `"mcpServers"`                                              |

Three things the layout no longer carries, because each was a second place
naming a fact the fields above already hold:

| was                      | now                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `surfaceDirs: string[]`  | `surfaceDirs(layout)` — derived from `surfaces`, so a list and a per-kind field can no longer disagree                                     |
| `intraRefDirs: string[]` | `executableSourceDirs(layout)` — the surfaces plus `hookScriptsDir`                                                                        |
| `materializeRoot`        | `materializePrefix(layout)` = `userSurfaceRoot ?? ""` — the two fields were equal in every shipped layout and undefined when they differed |

**Consumed by:** `loadPlugin(path, layout)` — reads hooks (JSON or TOML per
`settingsFormat`), materializes surfaces, expands `pluginRootToken`.

### `HarnessRuntime` (transport)

How the test tiers drive the agent against a no-key mock.

| Field             | Type     | Meaning                          | Claude Code            |
| ----------------- | -------- | -------------------------------- | ---------------------- |
| `name`            | `string` | stable id                        | `"claude-code"`        |
| `agentBinary`     | `string` | the CLI that runs the agent      | `"claude"`             |
| `modelBaseUrlEnv` | `string` | env var pointing at the mock     | `"ANTHROPIC_BASE_URL"` |
| `modelApiKeyEnv`  | `string` | env var carrying the (dummy) key | `"ANTHROPIC_API_KEY"`  |
| `mockApiKey`      | `string` | a dummy key the mock ignores     | `"sk-vigiles-mock"`    |

### `HookProtocol` (transport)

How a hook signals a block/deny, and which events can inject developer context.

| Field                | Type                | Meaning                                                    | Claude Code                                         | Codex                                                                            |
| -------------------- | ------------------- | ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `name`               | `string`            | stable id                                                  | `"claude-code"`                                     | `"codex"`                                                                        |
| `blockExitCode`      | `number`            | exit code that blocks a tool call                          | `2`                                                 | `2`                                                                              |
| `denyDecisionValues` | `readonly string[]` | decision values meaning "deny"                             | `["block","deny"]`                                  | `["block","deny"]`                                                               |
| `eventEnvVars`       | `readonly string[]` | env vars a synthesized event carries                       | `[]`                                                | `[]`                                                                             |
| `injectableEvents`   | `readonly string[]` | events that honor `additionalContext` (inject/nudge hooks) | `["SessionStart","UserPromptSubmit","PostToolUse"]` | `["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","SubagentStart"]` |

`injectableEvents` makes "can this harness deliver an inject hook, and on which
events?" a **tested contract** rather than prose — a `shellHooks` adapter that
declares an empty list fails conformance, and `compile` warns when an inject hook
targets an event the harness doesn't honor. A code-module-hook adapter
(`shellHooks:false`, no `hookProtocol`) is exempt.

### `ModelMock` (transport)

The mock model's wire format. (The HTTP/SSE renderer lives in the harness's mock
module; this descriptor names the wire facts the bundle and tooling read.)

| Field                  | Type     | Meaning                                   | Claude Code            | Codex                |
| ---------------------- | -------- | ----------------------------------------- | ---------------------- | -------------------- |
| `name`                 | `string` | stable id                                 | `"claude-code"`        | `"codex"`            |
| `wireApi`              | `string` | the model API wire format                 | `"anthropic-messages"` | `"openai-responses"` |
| `modelEndpoint`        | `string` | URL substring of a turn-consuming request | `"/v1/messages"`       | `"/v1/responses"`    |
| `countTokensEndpoint?` | `string` | token-count endpoint a client probes      | `"count_tokens"`       | _(omit)_             |

### `HarnessAdapter`

The bundle. `name` + a `capabilities` descriptor + the ports + a `detect`. The
two layer-1 ports (`dialect`, `layout`) are always required; the transport ports
are **optional and gated by `capabilities`** — present iff the matching capability
is declared, so a reference-only or code-module-hook harness isn't forced to ship
a fake transport (the conformance kit enforces this both ways).

```ts
interface AdapterCapabilities {
  readonly referenceVerification: true; // layer 1 — always
  readonly harnessTesting: boolean; // layer 2 — needs runtime + modelMock
  readonly shellHooks: boolean; // shell-process hooks — needs hookProtocol
  readonly subagents: boolean; // has subagents — gates the subagent lint rules
}

interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  readonly dialect: HarnessDialect; // always
  readonly layout: PluginLayout; // always
  readonly runtime?: HarnessRuntime; // iff capabilities.harnessTesting
  readonly hookProtocol?: HookProtocol; // iff capabilities.shellHooks
  readonly modelMock?: ModelMock; // iff capabilities.harnessTesting
  /** Specificity score: 0 = not this harness; higher = a more specific match. */
  detect(root: string): number;
}
```

`assertHarnessTestable(adapter)` is the guard the layer-2 runners call to refuse
a non-`harnessTesting` adapter up front (returning its narrowed `runtime`+`modelMock`).

**`detect` contract.** Return `0` when `root` is not this harness; otherwise a
positive **specificity** — a strong signal (a private config dir / manifest)
should outscore a weak one (a shared `AGENTS.md`). The registry picks the highest
scorer, so scores let a precise adapter win over a generic one regardless of
registration order.

---

## Conformance

### `checkAdapterConformance(adapter): ConformanceResult`

Pure (no IO). Returns `{ ok: boolean; failures: readonly string[] }`. Checks:
every port populated; cross-port invariants (all port `name`s equal
`adapter.name`; `layout.instructionFile` ∈ `dialect.instructionTargets`;
`layout.pluginRootToken` === `dialect.pluginRootToken`; `settingsFormat` is
`"json"|"toml"`); and a behavioural one — the dialect's own first built-in tool
passes `compileAgent`'s tool-contract check.

### `assertAdapterConformance(adapter): void`

Throws an `Error` listing every failure if `checkAdapterConformance` isn't `ok`.
Drop it in your adapter's test suite.

### `assertAdapterLoadsHooks(adapter): void`

Does filesystem IO. Writes a minimal settings file in the adapter's
`settingsFormat` (with a hook) to a temp dir, loads it through the adapter's
`layout`, and throws if no hooks came back. This is what catches a layout that
points at the right file in the **wrong format** (the JSON-vs-TOML trap) — the
pure check passes it, but the agent would silently run zero hooks.

```ts
import { test } from "vitest";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
} from "vigiles/adapter";
import { myHarnessAdapter } from "./my-harness-adapter.js";

test("my adapter conforms", () => {
  assertAdapterConformance(myHarnessAdapter);
  assertAdapterLoadsHooks(myHarnessAdapter);
});
```

---

## Registry & detection

The registry is how the **CLI** picks an adapter for a repo (the library picks by
import). Claude Code is the default, so detection is backwards-compatible.

| Export                           | Signature                                 | Behaviour                                                                                                                  |
| -------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTERS`                       | `readonly HarnessAdapter[]`               | all registered adapters                                                                                                    |
| `defaultAdapter`                 | `HarnessAdapter`                          | used when nothing is detected (Claude Code)                                                                                |
| `detectAdapter(root)`            | `(string) => HarnessAdapter`              | the highest-specificity match, else the default                                                                            |
| `detectAdapterResult(root)`      | `(string) => DetectResult`                | `{ adapter, fallback, ambiguousWith }` — `ambiguousWith` lists other top-scoring adapters (a repo that looks like several) |
| `resolveAdapter(root, harness?)` | `(string, string?) => HarnessAdapter`     | an explicit `harness` name wins (throws if unknown); else `detectAdapter`. The CLI's `--harness` flow                      |
| `getAdapter(name)`               | `(string) => HarnessAdapter \| undefined` | lookup by name                                                                                                             |

```ts
interface DetectResult {
  readonly adapter: HarnessAdapter;
  readonly fallback: boolean; // true = no markers, fell back to default
  readonly ambiguousWith: readonly string[]; // other top-scoring adapter names
}
```

---

## Applying an adapter (the programmatic path)

`vigiles/adapter` gives you the **contract**; you apply it with the verification
core. This path is fully supported for third-party adapters today:

```ts
import { compileAgent } from "vigiles/linting";
import { loadPlugin } from "vigiles/claude-code";
import { myHarnessAdapter } from "./my-harness-adapter.js";

// verify a subagent's tool contract under your dialect
const { markdown, errors } = compileAgent(spec, {
  dialect: myHarnessAdapter.dialect,
  specFile: "reviewer.md.spec.ts",
});

// load a repo/plugin under your layout (hooks parsed per settingsFormat)
const plugin = loadPlugin("./my-project", myHarnessAdapter.layout);
```

## Third-party adapters

- **Programmatic use — supported now.** Implement the ports, validate with the
  conformance kit, and pass `adapter.dialect` / `adapter.layout` to the core
  functions above. Nothing is gated on the adapter living in _our_ tree.
- **CLI auto-detection — partial.** `ADAPTERS` is vigiles's internal registry;
  the `vigiles` CLI binary only auto-detects adapters compiled into it. A config-
  based mechanism for the CLI to load an _external_ adapter package is planned
  Until then: use the programmatic
  path, or contribute the adapter upstream so it joins `ADAPTERS`.

## See also

- [`docs/authoring-an-adapter.md`](authoring-an-adapter.md) — the guided tutorial.
- [`docs/harnesses.md`](harnesses.md) — how a consumer _selects_ a harness.
