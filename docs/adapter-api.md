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

**Consumed by:** the subagent tool-contract check (`vigiles compile` / `vigiles lint`,
and the conformance kit) — verifies a subagent's `tools:` against
`builtinAgentTools`/`neverAvailableTools`/`mcpToolPattern`.

### `PluginLayout` (format)

Where the harness keeps things on disk.

| Field                 | Type                                             | Meaning                                                                                                                                                                                    | Claude Code                                                 |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `name`                | `string`                                         | stable id                                                                                                                                                                                  | `"claude-code"`                                             |
| `manifestPath`        | `string`                                         | plugin manifest                                                                                                                                                                            | `".claude-plugin/plugin.json"`                              |
| `hooksConventionPath` | `string?`                                        | standalone hooks FILE convention; omit when the harness has none (OpenCode's hooks are code modules)                                                                                       | `"hooks/hooks.json"`                                        |
| `settingsPath`        | `string`                                         | repo settings carrying hooks                                                                                                                                                               | `".claude/settings.json"`                                   |
| `settings`            | `SettingsCodec`                                  | the bytes-to-value CODEC for the manifest and settings files (`label` / `parse` / `render`) — an encoding, not a format name; `jsonSettingsCodec` and `tomlSettingsCodec` ship in the core | `jsonSettingsCodec` (Codex: `tomlSettingsCodec`)            |
| `instructionFile`     | `string`                                         | top-level instruction file                                                                                                                                                                 | `"CLAUDE.md"`                                               |
| `surfaces`            | `Readonly<Partial<Record<SurfaceKind, string>>>` | where each model surface lives, keyed by kind (`skill`/`agent`/`command`); an ABSENT key is the only spelling of "this harness has no such surface"                                        | `{ skill: "skills", agent: "agents", command: "commands" }` |
| `userSurfaceRoot`     | `string?`                                        | the second home an END USER keeps the same surfaces under — and the prefix a relocated scope is keyed under                                                                                | `".claude"` (Codex/OpenCode: omitted)                       |
| `rulesDir`            | `string?`                                        | path-scoped instruction dir (an instruction is READ, not invoked — so not a `SurfaceKind`)                                                                                                 | `"rules"`                                                   |
| `instructionChain`    | `(files) => InstructionChain`                    | METHOD: given the bounded candidate map the domain enumerated, which files this harness LOADS at a repo-root session, in order, and for each one it does not, WHY                          | see below                                                   |
| `hookScriptsDir`      | `string?`                                        | dir holding executable hook SCRIPTS, distinct from where hooks are registered                                                                                                              | `"hooks"` (OpenCode: omitted)                               |
| `pluginRootToken`     | `string`                                         | the plugin-root token (must match the dialect's)                                                                                                                                           | `"${CLAUDE_PLUGIN_ROOT}"`                                   |
| `mcpConfigFile`       | `string`                                         | standalone MCP config                                                                                                                                                                      | `".mcp.json"`                                               |
| `mcpManifestKey`      | `string`                                         | manifest key declaring MCP servers                                                                                                                                                         | `"mcpServers"`                                              |

Four things the layout no longer carries, because each was a second place
naming a fact the fields above already hold — or, for the last, a mini-language
the core had to interpret:

| was                      | now                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `surfaceDirs: string[]`  | `surfaceDirs(layout)` — derived from `surfaces`, so a list and a per-kind field can no longer disagree                                     |
| `intraRefDirs: string[]` | `executableSourceDirs(layout)` — the surfaces plus `hookScriptsDir`                                                                        |
| `materializeRoot`        | `materializePrefix(layout)` = `userSurfaceRoot ?? ""` — the two fields were equal in every shipped layout and undefined when they differed |

| `alwaysLoaded: string[]` (on the DIALECT's `instructionBudget`) | `layout.instructionChain(files)` — see below |

#### `instructionChain(files)`

The one METHOD on this port, and it is a method for a reason no better data
field fixes: which instruction files load is decided by things a path lookup
cannot see — a rule's own frontmatter (`paths:` scopes it to an on-demand read),
a SIBLING file (Codex's `AGENTS.override.md` takes the directory's one slot), and
the REPOSITORY'S OWN SETTINGS (Claude Code's `claudeMdExcludes`, Codex's
`project_doc_fallback_filenames`).

It receives the map the DOMAIN enumerated and classifies those keys:

```ts
interface InstructionChain {
  loaded: { path; role; scope }[]; // in load order
  unloaded: { path; role; scope; reason }[]; // reason is a tagged union
  imports: { path; from }[]; // `@path` tokens the loaded files NAME
  patterns: { pattern; from }[]; // globs the domain will NOT walk
}
```

- `role` — `root` · `root-local` · `rule` · `fallback` · `import`
- `scope` — `repo` or `local`. A `local` file is READ and LINTED and never
  SCORED: the browser engine reads a GitHub tree and can never see a gitignored
  file, so scoring one would put the CLI and the browser permanently out of
  agreement and make a published grade irreproducible between teammates. The
  weight therefore carries two numbers, `committedTotal` and `effectiveTotal`.
- `reason` — `{kind:"replaced", by}` · `{kind:"on-demand", when}` ·
  `{kind:"excluded-by-settings", key}` · `{kind:"superseded", by, byScope}`. A
  file in `unloaded` without one does not type-check.
  - `superseded` is a CROSS-FAMILY switch, not `replaced`'s same-directory slot:
    Claude Code reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md`
    or `CLAUDE.local.md` is present (vendor, v2.1.277+). `byScope` carries
    whether the file that did it is committed — when it is `local`, a gitignored
    file has changed the MEMBERSHIP of the load rather than its size, so
    `committedTotal` keeps a file `effectiveTotal` drops and the effective
    number can come out BELOW the committed one.

**The bound.** The domain enumerates candidates from `INSTRUCTION_SHAPES`
(`core/instruction-chain.ts`): the repo root's markdown, a depth-1
dot-directory's markdown, that dot-directory's `rules` tree read recursively,
plus each layout's own `instructionFile` and settings sources. An adapter cannot
add a root — `registering an adapter must not widen what vigiles reads in
anyone's repository`, the same rule `core/surface-discovery.ts` states for
surfaces. `src/adapter-properties.test.ts` asserts it: every path a chain names
is a key of the map it was given.

The one read outside that bound is the IMPORT pass, and what makes it legitimate
is who chose the path: an `@import` token is written by the repository owner in
their own instruction file, and the property tests require every reported import
to literally occur in the file that reports it. It reads ONE level and does not
recurse — measured across 198 real `CLAUDE.md` files, six carry an import at all
and every one is a single concrete path at depth 1, four of them the `@AGENTS.md`
workaround. `core/instruction-chain.ts#resolveImports` carries the numbers and
what one level costs.

**Consumed by:** `loadPlugin(path, layout)` — reads hooks through `settings.parse`,
materializes surfaces, expands `pluginRootToken`. And by
`weighInstructions(chain, files, budget)` — the instruction-weight report.

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

The bundle. `name` + the capability flags + the ports + a `detect`. The two
layer-1 ports (`dialect`, `layout`) are always required; the transport ports are
**gated by the flags**, so a reference-only or code-module-hook harness is not
forced to ship a fake transport.

🔴 **The gate is the TYPE, not a convention.** The flags are DISCRIMINANTS of
unions intersected into `HarnessAdapter`, so "declares the capability, ships no
port" and "denies the capability, ships the port" are both compile errors.
They used to live in a nested `capabilities` object, and that nesting is exactly
what made the illegal state expressible: TypeScript narrows a union by a
discriminant on the object itself and never by `a.capabilities.x`. It was not
hypothetical — the OpenCode prototype shipped `harnessTesting: true` with no
`harnessTestDriver`, and the runner threw at run time.

```ts
interface AdapterBase {
  readonly name: string;
  readonly dialect: HarnessDialect; // always
  readonly layout: PluginLayout; // always
  readonly subagents: boolean; // gates the subagent lint rules; no port behind it
  /** Specificity score: 0 = not this harness; higher = a more specific match. */
  detect(root: string): number;
  claims(path: string): boolean;
}

type TestingPorts =
  | {
      readonly harnessTesting: true;
      readonly runtime: HarnessRuntime;
      readonly modelMock: ModelMock;
      readonly harnessTestDriver: () => Promise<HarnessTestDriver>;
    }
  | {
      readonly harnessTesting: false;
      readonly runtime?: never;
      readonly modelMock?: never;
      readonly harnessTestDriver?: never;
    };

type ShellHookPorts =
  | { readonly shellHooks: true; readonly hookProtocol: HookProtocol }
  | { readonly shellHooks: false; readonly hookProtocol?: never };

type HarnessAdapter = AdapterBase & TestingPorts & ShellHookPorts;
```

`AdapterCapabilities` survives as the documented projection of the three flags.
`referenceVerification` does not: it was typed as the literal `true` on every
adapter, so neither the type nor its conformance check could ever fail.

**The conformance kit still checks all of this**, and that is deliberate rather
than redundant: the type reaches an adapter authored in TypeScript, and the kit
reaches a third-party adapter authored in JavaScript or one crossing a package
boundary through a cast. The type is the gate; the kit is the explanation,
because a TypeScript error against a four-member intersection reads badly next
to a sentence naming the field.

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
`layout.pluginRootToken` === `dialect.pluginRootToken`; `layout.settings`
round-trips its own output); and a behavioural one — the dialect's own first
built-in tool passes the subagent tool-contract check (the same validator
`vigiles compile` runs on a subagent's `tools:`).

The enum check that used to sit here — `settingsFormat` is `"json"|"toml"` — is
gone, and its absence is the point: the core re-checking a closed set it had
itself declared is what told you the "data" field was a hidden switch. A codec
has no set to be outside of, so a third-party adapter whose settings are YAML
is legal, and what is checked instead is that its codec can read back what it
wrote.

### `assertAdapterConformance(adapter): void`

Throws an `Error` listing every failure if `checkAdapterConformance` isn't `ok`.
Drop it in your adapter's test suite.

### `assertAdapterLoadsHooks(adapter): void`

Does filesystem IO. Writes a minimal settings file built from the adapter's own
ports — `layout.settings.render(hookProtocol.registration(…))`, so the ENCODING
and the entry SHAPE both come from the adapter rather than from a branch inside
the check — to a temp dir, loads it through the adapter's `layout`, and throws
if no hooks came back. This is what catches a layout that points at the right
file in the **wrong format** (the JSON-vs-TOML trap) — the pure check passes it,
but the agent would silently run zero hooks.

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

`vigiles/adapter` gives you the **contract**; you validate it with the conformance
kit and apply it through the public loaders. This path is fully supported for
third-party adapters today:

```ts
import { assertAdapterConformance } from "vigiles/adapter";
import { loadPlugin } from "vigiles/claude-code";
import { myHarnessAdapter } from "./my-harness-adapter.js";

// every port populated, the ports agree, and the dialect's own built-in tool
// passes the subagent tool-contract check
assertAdapterConformance(myHarnessAdapter);

// load a repo/plugin under your layout (hooks parsed through layout.settings)
const plugin = loadPlugin("./my-project", myHarnessAdapter.layout);
```

Compiling specs is not a library call: the compiler left `vigiles/linting` in the
major that moved Python/Ruby/Rust parsing to WebAssembly (#257). Specs compile
through the CLI (`vigiles compile`), which picks your adapter from the registry
(below) or `--harness <name>`.

## Third-party adapters

- **Programmatic use — supported now.** Implement the ports, validate with the
  conformance kit, and pass `adapter.layout` to the loaders above. Nothing is
  gated on the adapter living in _our_ tree.
- **CLI auto-detection — partial.** `ADAPTERS` is vigiles's internal registry;
  the `vigiles` CLI binary only auto-detects adapters compiled into it. A config-
  based mechanism for the CLI to load an _external_ adapter package is planned
  Until then: use the programmatic
  path, or contribute the adapter upstream so it joins `ADAPTERS`.

## See also

- [`docs/authoring-an-adapter.md`](authoring-an-adapter.md) — the guided tutorial.
- [`docs/harnesses.md`](harnesses.md) — how a consumer _selects_ a harness.
