# Adapter port redesign, round 2 — one shape, the illegal states removed, the names fixed

Builds on `docs/design/adapter-port-revision-2026-09-21.md` (97243ea; its verdict and four methods are taken as given) and answers zernie/vigiles#263 with #262 as input. Tree reasoned against: `claude/optional-grammars` @ `e7c626f` (`npx tsc --noEmit -p .` → RC 0 on 2026-09-21). `claude/core-no-harness-names` is exactly one commit (`b9146ee`) stacked on that head (`git merge-base` = `e7c626f`), so everything below assumes both land first and counts its effect on that commit's eleven disables. Nothing was modified; three throwaway `tsc` probes ran in the scratchpad (§7).

Where a number here differs from #263, mine is the one measured on this tree and the command is given.

---

## 0. The answer in one paragraph

The port has one defect class wearing five coats: **a fact is stored in more than one place, and nothing relates the copies.** `skillDir` beside `surfaceDirs` (A1); `""` beside `?` for "none" (A2); `materializeRoot` beside `userSurfaceRoot`, equal in all three implementations and undefined when they differ (A5, new); `harnessTesting: true` beside an absent `harnessTestDriver` (A6, new — live in `opencode`, and the runner throws on it at `src/harness-test.ts:782-784`); a hand-written `ProbeHarness` and `DEFAULT_NAMES` beside the registry (A4). The construction is the same each time: **keep one copy, and derive or type the rest.** `surfaces` becomes a `Partial<Record<kind, dir>>` — not the owner's tagged list, because a list can still hold two `skill` entries and a record cannot (`tsc`-verified, §7). `intraRefDirs` is deleted and derived. `materializeRoot` is deleted and derived. `settingsFormat` becomes a codec **plus** a hook-registration constructor, because three of the nine format branches are about the entry _shape_, not the encoding, which round 1 did not separate. The instruction surface becomes the `instructionChain` method from #262, with two corrections the vendor pages force: the result is not one list but `loaded`/`unloaded`/`imports`/`patterns`, and `shadows` becomes a typed _reason_ on an unloaded entry so "a file that does not load must say why" is a type, not a convention. The name stays a string; round 1's ceiling is **confirmed, with a probe**: a branded `HarnessName` does not stop `=== "codex"` (TS comparability lets it through — §7), so the ratchet for names remains the lint rule, strengthened by a name-free selector that cannot go stale. `rulesDir` does **not** join `surfaces`, and §3.3 says why with a per-consumer count.

---

## 1. The final interfaces

> 🔴 **STALE as of 2026-09-22 — the five new flags below are superseded.**
> `SkillFiringPorts`, `AdoptabilityPorts`, `AdvisoryPorts`, `skillSelectionEvent`
> and `runtime.modelAvailability` were measured against this document's own §0
> principle ("a fact stored in more than one place, and nothing relates the
> copies") and **three of the five are second copies**: `skillFiring` equals
> `harnessTesting` on all three implementations, `skillSelectionEvent` equals
> `EvalDriver.experimental !== undefined`, and `adoptability: false` encodes a
> TODO with no vendor referent. A tsc probe shows the type cannot relate any of
> them to the ports that would make them true. Read
> [`port-redesign-names-half-2026-09-22.md`](port-redesign-names-half-2026-09-22.md)
> instead; the rest of this document stands.

Every field's docblock says what the field **is**; the second sentence, where present, says what its absence means, so absence has one spelling per field.

```ts
// ───────────────────────────── src/core/layout.ts ─────────────────────────────

/**
 * The three kinds of MODEL surface — a thing a session can invoke by name.
 * Instructions are not a surface: they are read, not called. That is why
 * `rulesDir` is not a key here (§3.3).
 */
export type SurfaceKind = "skill" | "agent" | "command";

/**
 * Where each model surface lives, keyed by kind — repo-relative and COMPLETE
 * (`.agents/skills`, never `skills` under a root the reader must remember).
 *
 * A kind with no entry is a surface this harness does not have; that is the
 * only spelling of "none" (there is no `""`). A record rather than a list so
 * the same kind cannot be named twice and a fourth kind cannot be smuggled in:
 * both are `tsc` errors, not conformance findings (§7, probe 2).
 */
export type SurfaceDirs = Readonly<Partial<Record<SurfaceKind, string>>>;

/**
 * The bytes-to-value codec for this harness's settings and manifest files.
 * It knows the ENCODING (JSON, TOML, a third party's YAML) and nothing about
 * what the value means — the hooks-entry shape lives on `HookProtocol`.
 */
export interface SettingsCodec {
  /** For messages and the generated JSON Schema only; the core never branches on it. */
  readonly label: string;
  /** Throws on malformed text; every caller today already catches. */
  parse(text: string): Record<string, unknown>;
  /** The inverse, with the trailing newline the harness's own tooling writes. */
  render(value: Record<string, unknown>): string;
}

export interface PluginLayout {
  /**
   * The harness this layout belongs to — the same string as `adapter.name`,
   * carried here so a layout passed on its own (the browser twin) can still
   * say whose it is. Output only; the domain compares layouts by identity.
   */
  readonly name: string;

  // ── The model surfaces ──────────────────────────────────────────────────

  /** See {@link SurfaceDirs}. At least one kind is required (conformance). */
  readonly surfaces: SurfaceDirs;

  /**
   * The dot-directory a plain END USER keeps the same surfaces under, when the
   * harness has such a second home (`.claude` → `.claude/skills`). When set,
   * every surface is read from BOTH `<surface>` and `<userSurfaceRoot>/<surface>`,
   * and this is ALSO the prefix a relocated scope is keyed under — the two
   * were separate fields (`materializeRoot`) that were equal in every shipped
   * layout and had no defined meaning when unequal (§3.5). Absent means the
   * surfaces have exactly one home and file-map keys equal on-disk paths.
   */
  readonly userSurfaceRoot?: string;

  /**
   * The directory a plugin keeps its EXECUTABLE hook scripts in (`hooks`) —
   * distinct from where the hooks are REGISTERED (`hooksConventionPath`,
   * `settingsPath`). It is scanned for dangling file references and checked
   * for misplacement inside the manifest dir, and it replaces the two ad-hoc
   * derivations `hooksConventionPath.split("/")[0]` (scan.ts:802,
   * scan-files.ts:771) plus the hand-written `intraRefDirs`. Absent means the
   * harness has no scripts directory to scan (code-module hooks).
   */
  readonly hookScriptsDir?: string;

  // ── The instruction surface ─────────────────────────────────────────────

  /**
   * The PRIMARY root instruction file — the one `compile` writes, `init`
   * scaffolds and `detect` scores. Whether it is in the loaded chain, and what
   * else is, is {@link instructionChain}'s answer, never this field's.
   */
  readonly instructionFile: string;

  /**
   * A directory of instruction files scoped by a frontmatter key — Claude
   * Code's `.claude/rules/` (`paths:`), Cursor's `.cursor/rules/` (`globs:`),
   * Windsurf's `.windsurf/rules/`. Read RECURSIVELY (vendor: "all `.md` files
   * are discovered recursively"). Absent means the harness has no such layer;
   * `""` is refused by conformance, not accepted as a second spelling.
   */
  readonly rulesDir?: string;

  /**
   * Which of the instruction-shaped files the domain enumerated this harness
   * LOADS at a repo-root session, in load order — and for each one it does
   * not load, WHY. Pure: a function of `files` alone (§4 states the property
   * a test asserts). Replaces `dialect.instructionBudget.alwaysLoaded` and
   * the private glob walker `scan.ts:readAlwaysLoaded`.
   */
  instructionChain(files: Readonly<Record<string, string>>): InstructionChain;

  // ── Registration files ──────────────────────────────────────────────────

  /** The plugin manifest, e.g. `.claude-plugin/plugin.json`. */
  readonly manifestPath: string;
  /** The repo-level settings file that can carry hook registrations. */
  readonly settingsPath: string;
  /** How `manifestPath` and `settingsPath` are encoded. */
  readonly settings: SettingsCodec;
  /**
   * The conventional standalone hooks FILE a plugin may ship instead of
   * inline registrations (`hooks/hooks.json`). A file, never a directory —
   * `opencode`'s `.opencode/plugin` is a directory and is why this is now
   * optional: absent means the harness has no standalone hooks file.
   */
  readonly hooksConventionPath?: string;
  /** Standalone MCP config file, e.g. `.mcp.json`. */
  readonly mcpConfigFile: string;
  /** The manifest key under which MCP servers are declared, e.g. `mcpServers`. */
  readonly mcpManifestKey: string;

  // ── Tokens ──────────────────────────────────────────────────────────────

  /** The env token a hook command uses for the PLUGIN's own root. */
  readonly pluginRootToken: string;
  /**
   * Tokens that root a path at the PROJECT being scanned, braced. Absent
   * means the harness has no such variable. (Unchanged; its docblock at
   * layout.ts:80-91 already earns the field.)
   */
  readonly projectRootTokens?: readonly string[];
}

// Derived, in the core, so no adapter lists them and no list can drift:
/** Every surface dir of a layout — what `surfaceDirs` used to be, minus the drift. */
export function surfaceDirs(layout: PluginLayout): readonly string[];
/** Dirs whose non-prose files are scanned for intra-plugin references: the
 *  surfaces plus `hookScriptsDir`. Equals the old `intraRefDirs` byte-for-byte
 *  on Claude Code and Codex; on `opencode` it gains `.opencode/skill`, which the
 *  hand list had left out. */
export function executableSourceDirs(layout: PluginLayout): readonly string[];

// ─────────────────────── src/core/instruction-chain.ts (new) ───────────────────

/** What a file IS to the harness that loads it. */
export type InstructionRole =
  | "root"        // CLAUDE.md, AGENTS.md — the committed team file
  | "root-local"  // CLAUDE.local.md, AGENTS.override.md — one machine's file
  | "rule"        // a file under `rulesDir`
  | "fallback"    // a repo-configured alternate name (Codex `project_doc_fallback_filenames`)
  | "import";     // reached through an `@path` import, not by location

/** Team instruction (committed) or per-machine? `"local"` is linted, never scored. */
export type InstructionScope = "repo" | "local";

export interface LoadedInstruction {
  readonly path: string;
  readonly role: InstructionRole;
  readonly scope: InstructionScope;
}

/**
 * Why a file the domain enumerated is NOT in the loaded chain. A tagged union
 * so that an unloaded entry without a reason is unrepresentable — this is
 * what `shadows` was trying to be (#263 §C): the combination RULE is the
 * adapter's, the fact that a file was hidden is reported to the core.
 */
export type NotLoadedReason =
  /** Another file took this directory's slot — Codex reads at most one per dir. */
  | { readonly kind: "replaced"; readonly by: string }
  /** Loaded only when the agent reads a matching file — never at launch. */
  | { readonly kind: "on-demand"; readonly when: "path-scoped" | "subdirectory" }
  /** A repo setting removed it — Claude Code `claudeMdExcludes`. */
  | { readonly kind: "excluded-by-settings"; readonly key: string }
  /** Present but ignored because a higher-precedence file exists — Claude Code
   *  reads `AGENTS.md` only when no `CLAUDE.md`/`CLAUDE.local.md` is present. */
  | { readonly kind: "superseded"; readonly by: string };

export interface UnloadedInstruction extends LoadedInstruction {
  readonly reason: NotLoadedReason;
}

export interface InstructionChain {
  /** Loaded at a repo-root session, in the order the harness concatenates them. */
  readonly loaded: readonly LoadedInstruction[];
  /** Instruction-shaped files in the map this harness does not load, each with why. */
  readonly unloaded: readonly UnloadedInstruction[];
  /**
   * Concrete repo-relative paths the loaded files NAME as imports (`@docs/x.md`).
   * The adapter only reports them; the domain reads them in a second, bounded
   * pass (§4). Every entry is a token that literally occurs in `files[from]`.
   */
  readonly imports: readonly { readonly path: string; readonly from: string }[];
  /**
   * Patterns or URLs the harness would expand at launch and the domain will
   * NOT walk (OpenCode `instructions: ["packages/*/AGENTS.md"]`). Reported so
   * the weight says "plus N patterns not weighed" instead of a number that is
   * wrong. Never read.
   */
  readonly patterns: readonly { readonly pattern: string; readonly from: string }[];
}

// ───────────────────────────── src/core/dialect.ts ─────────────────────────────
export interface HarnessDialect {
  // …unchanged, except:
  /**
   * The SKILL.md frontmatter keys this harness reads. The compiler emits a key
   * iff it is here; `dialectSupportsSkillFence` is `keys.includes("disallowed-tools")`.
   * Replaces `skillFrontmatter: "claude-code" | "minimal"`, a data field whose
   * VALUES were harness names and so forced every consumer to compare against
   * one (the root of five of the lint branch's eleven disables).
   */
  readonly skillFrontmatterKeys: readonly string[];
  /** `alwaysLoaded` is gone; unit/limit/onExceed/capturedFrom stay. */
  readonly instructionBudget?: Omit<InstructionBudget, "alwaysLoaded">;
}

// ─────────────────────────── src/core/hook-protocol.ts ─────────────────────────
export interface HookProtocol {
  // …unchanged, plus:
  /**
   * The config fragment that registers ONE command on ONE event in this
   * harness's native settings shape — Claude Code nests `{matcher, hooks:[{type,
   * command}]}`, Codex is flat `{matcher, command}`. This is the SHAPE half of
   * what `settingsFormat` was standing in for; `SettingsCodec` is the encoding
   * half. Reading already tolerates both shapes (`core/hook-normalize.ts`);
   * this makes writing symmetric.
   */
  registration(on: string, matcher: string | undefined, command: string): {
    readonly hooks: Readonly<Record<string, readonly unknown[]>>;
  };
}

// ───────────────────────────── src/core/runtime.ts ─────────────────────────────
/** Whether a REAL model is reachable for the tiers that need one, read from
 *  the environment alone — never a live probe, never a spent token. */
export interface ModelAvailability {
  readonly reachable: boolean;
  /** Reachable through a per-token key rather than a subscription — the consent
   *  wording says "spends API credits" iff true. */
  readonly metered: boolean;
  /** One line for the consent prompt: what it costs, or what is missing. */
  readonly hint: string;
}
export interface HarnessRuntime {
  // …unchanged, plus:
  /** Replaces `adapter.name === "codex" || hasModelAccess(process.env)` (cli-main
   *  8471, 8677, 8696) and `triggerCostWording` (8016). Renamed from round 1's
   *  `modelAccess`: it grants nothing — it REPORTS availability. */
  modelAvailability(env: Readonly<Record<string, string | undefined>>): ModelAvailability;
}

// ───────────────────────────── src/core/adapter.ts ─────────────────────────────

/** How, and how strongly, a repo looks like this harness. Structured so the
 *  registry can collapse a mirrored-instruction-file tie without naming a
 *  harness (round 1 #12/#13): both matched `via: "instruction-file"` and the
 *  files mirror ⇒ drop the one whose file is the mirror's link. */
export interface DetectSignal {
  readonly specificity: number; // 0 = not this harness
  readonly via: "manifest" | "settings" | "instruction-file";
}

/**
 * The invariant fields every adapter has. The capability-gated ports are NOT
 * here — they live in the unions below, so "declares X, lacks the port for X"
 * is a `tsc` error rather than a conformance finding (§7, probe 3).
 */
interface AdapterBase {
  /** The string that `--harness=`, `.vigilesrc.json#harnesses` keys and the JSON
   *  report carry. Declared `as const` in each adapter so the registry can
   *  derive `HarnessName` from it (§3.4). The domain reads it for OUTPUT only. */
  readonly name: string;
  readonly dialect: HarnessDialect;
  readonly layout: PluginLayout;
  /** Subagents exist as a surface (gates the subagent rules; n/a where false). */
  readonly subagents: boolean;
  /** The harness emits a skill-selection event a probe can observe. Gates
   *  selection-collision and adversarial-gate (scan-behavioral 584, 1017). */
  readonly skillSelectionEvent: boolean;
  /** `exists` is injected so no adapter bundle imports `node:` — the change that
   *  lets `layout-registry.ts` be deleted (round 1 §7). */
  detect(exists: (repoRelative: string) => boolean): DetectSignal;
  claims(path: string): boolean;
}

/** Pillar 2: present iff `harnessTesting`. A thunk, for the reason at adapter.ts:87-108. */
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

/** Shell hooks: present iff `shellHooks`. */
type ShellHookPorts =
  | { readonly shellHooks: true; readonly hookProtocol: HookProtocol }
  | { readonly shellHooks: false; readonly hookProtocol?: never };

/** Skill-firing measurement: present iff `skillFiring`. Absorbs
 *  `scan-behavioral.ts:buildProbe` whole (round 1 #2/#4/#16). */
type SkillFiringPorts =
  | { readonly skillFiring: true; readonly skillProbe: () => Promise<SkillProbeDriver> }
  | { readonly skillFiring: false; readonly skillProbe?: never };

/** Adoptability drafting (drives a vendor CLI): present iff `adoptability`. */
type AdoptabilityPorts =
  | { readonly adoptability: true; readonly adoptabilityDrafter: () => Promise<AdoptabilityDrafter> }
  | { readonly adoptability: false; readonly adoptabilityDrafter?: never };

/**
 * Machine-state advisories (never scored). The method receives a READER the
 * domain built, which serves only paths the adapter already `claims` plus the
 * user's home — so the adapter cannot read what it does not claim. See §4 for
 * why round 1's `localAdvisories(root)` broke its own rule.
 */
type AdvisoryPorts =
  | {
      readonly localAdvisories: true;
      advisories(read: ClaimedReader): readonly string[];
    }
  | { readonly localAdvisories: false; advisories?: never };

export interface ClaimedReader {
  /** Text of a repo-relative path the adapter claims, else null. */
  readonly repo: (repoRelative: string) => string | null;
  /** Text of a path under the user's home, else null. */
  readonly home: (homeRelative: string) => string | null;
  /** Facts the domain already established, so the adapter need not re-read
   *  unclaimed files (`package.json`) to learn them. */
  readonly repoDependsOnVigiles: boolean;
}

export type HarnessAdapter = AdapterBase &
  TestingPorts & ShellHookPorts & SkillFiringPorts & AdoptabilityPorts & AdvisoryPorts;

// `AdapterCapabilities` as a separate object is gone: the flags ARE the
// discriminants. `referenceVerification: true` was a constant on every adapter
// and is dropped — a field that can hold one value carries no information.

// ─────────────────────────── src/adapter-registry.ts ───────────────────────────
export const HARNESSES = [claudeCodeAdapter, codexAdapter] as const satisfies readonly HarnessAdapter[];
/** Derived, never written: `"claude-code" | "codex"`. Requires `as const satisfies
 *  HarnessAdapter` on each ADAPTER, not on the array (#263 A4, verified). */
export type HarnessName = (typeof HARNESSES)[number]["name"];
/** Untrusted input in, adapter or nothing out — the one place a string becomes an adapter. */
export function getAdapter(input: string): HarnessAdapter | undefined;
```

**What is unchanged on purpose** (the owner asked for this to be said rather than dressed up): `manifestPath`, `settingsPath`, `mcpConfigFile`, `mcpManifestKey`, `pluginRootToken`, `projectRootTokens`, `instructionFile`, `rulesDir`, `userSurfaceRoot`, `claims(path)`, the thunk pattern, `HarnessDialect` bar two fields, `HarnessRuntime` bar one, `HookProtocol` bar one. Nineteen fields become fourteen plus one method; nothing moves directory.

---

## 2. Every illegal state, and the construction that removes it

| #            | state the port can express today                                                                                   | construction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | live instance in the tree                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1           | `skillDir ∉ surfaceDirs` — a surface named and never read                                                          | `surfaces: Partial<Record<SurfaceKind, string>>`: one place names a dir, so there is no second place to disagree with. `surfaceDirs()` is derived from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **`opencode`**: `skillDir: ".opencode/skill"` while `surfaceDirs: [".opencode/agent", ".opencode/command"]` (`src/adapters/opencode/layout.ts:23-24`). Its skills are silently never materialized — #263's hypothetical, shipping.                                                 |
| A2           | absence spelled `""` (`agentDir`, `materializeRoot`) and `?` (`rulesDir`), and `rulesDir`'s docblock blessing both | `""` is gone from the port: a kind with no dir is an absent key; `rulesDir`, `hookScriptsDir`, `hooksConventionPath`, `userSurfaceRoot` are `?` only; `materializeRoot` no longer exists (A5). TS cannot type a non-empty string, so conformance refuses `""` for every optional path — a test, stated as such in §3.                                                                                                                                                                                                                                                                                               | `codex/layout.ts:76,82`, `opencode/layout.ts:27`                                                                                                                                                                                                                                   |
| A3           | the owner's sketch: a tagged list                                                                                  | **Rejected in favour of a record.** A list `[{kind:"skill",dir:"a"},{kind:"skill",dir:"b"}]` type-checks and means nothing (no harness has two skill dirs at one scope — the second home is `userSurfaceRoot`, a scope, not a dir). A record makes the duplicate a duplicate-key error and a fourth kind an excess-property error; both verified (§7, probe 2). Order, the one thing a list has that a record lacks, is not load-bearing anywhere: every consumer iterates and keys counts by dir.                                                                                                                  | —                                                                                                                                                                                                                                                                                  |
| A4           | `ProbeHarness = "claude-code" \| "codex"` and `DEFAULT_NAMES` in the lint rule, both hand-written                  | `as const satisfies HarnessAdapter` on each adapter, `HARNESSES as const satisfies readonly HarnessAdapter[]`, `HarnessName` derived; `ProbeHarness` deleted (its consumer `buildProbe` moves into the adapters as `skillProbe`); the lint rule takes names from `readdirSync("src/adapters")` at config time, which `adapter-contract.test.ts` already pins equal to the registered names (dir == name), and so covers the unregistered `opencode` too. Duplicate names are the one thing the array form cannot see: one line in the contract loop, `new Set(HARNESSES.map(a=>a.name)).size === HARNESSES.length`. | `scan-behavioral.ts:44`; `eslint-rules/no-harness-names.mjs:129`                                                                                                                                                                                                                   |
| **A5** (new) | `materializeRoot ≠ userSurfaceRoot`                                                                                | Delete `materializeRoot`; the key prefix is `userSurfaceRoot ?? ""`. Measured: `claude-code` `.claude`/`.claude`, `codex` `""`/absent, `opencode` `""`/absent — equal in 3 of 3, and `surface-scopes.ts:130-145` only ever pairs them. `assertDistinctScopeKeys` guards "a future layout naming `.claude` as both its `materializeRoot` and a second scope's base" — with one field that future cannot be written.                                                                                                                                                                                                  | all three layouts; 9 test files name `materializeRoot` (`grep -rl`) — the largest single test cost in this design                                                                                                                                                                  |
| **A6** (new) | `harnessTesting: true` with no `harnessTestDriver`                                                                 | Capability flags become discriminants of unions intersected into `HarnessAdapter` (§1). Verified with `tsc` (§7, probe 3): the `opencode` shape is an error, `hookProtocol` beside `shellHooks: false` is an error, and `if (a.harnessTesting) a.harnessTestDriver()` narrows.                                                                                                                                                                                                                                                                                                                                      | **`opencode/adapter.ts:33`** declares `harnessTesting: true`; no thunk; `harness-test.ts:782` throws `declares harnessTesting but carries no harnessTestDriver` at run time. Conformance does not check the thunk (`adapter-conformance.ts:96-106` checks runtime/modelMock only). |
| **A7** (new) | `hooksConventionPath` that is a directory                                                                          | Optional field, documented as a file; conformance: if present, `basename` has an extension. Under A6 it belongs on the `shellHooks: true` arm, but a cross-object constraint (layout ⇄ adapter) is not worth an intersection over `PluginLayout` — conformance, and said so.                                                                                                                                                                                                                                                                                                                                        | `opencode/layout.ts:15` `".opencode/plugin"`, comment "Vestigial"                                                                                                                                                                                                                  |
| A8           | `settingsFormat` limited to two values in the core, with the enum re-checked in conformance (`:189-191`)           | `SettingsCodec` (encoding) + `HookProtocol.registration` (shape). Six of the nine branches are encoding, three are shape; §3.6 lists them. The conformance enum check is deleted — a third-party YAML codec is now legal.                                                                                                                                                                                                                                                                                                                                                                                           | `plugin-loader.ts:127,143`; `scan-files.ts:239,259`; `cli-main.ts:7496,7507`; `hook-install.ts:371`; `hook-program.ts:1177`; `adapter-conformance.ts:264`                                                                                                                          |
| A9           | an unloaded instruction file with no stated reason; a "shadows" that is a Codex-only word                          | `UnloadedInstruction.reason: NotLoadedReason` tagged union — a file in `unloaded` without a `kind` does not type-check. `shadows` is gone; its one true meaning is `{kind:"replaced", by}`.                                                                                                                                                                                                                                                                                                                                                                                                                         | `readAlwaysLoaded`'s output has no such distinction at all                                                                                                                                                                                                                         |

### 2.1 Does `rulesDir` join `surfaces`? No.

Counted, not felt. If `rules` were a `SurfaceKind`, every consumer that ranges over `surfaces` acquires a branch on the kind:

| consumer                                                                                                           | today                           | with `rules` in the record                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `surfaceHasLoadable` / `hasLoadable` (empty-machine decision, `plugin-loader.ts:391-397`, `scan-files.ts:304-314`) | ranges over `surfaceDirs`       | must skip `rules` — a rules-only repo is NOT a machine (the loader's own comment at `:481-489`)              |
| `counts` / `harnessCounts` (`materializeScope`)                                                                    | per surface                     | must skip `rules` (rules are excluded from counts today, `:487`)                                             |
| `SURFACE_SHAPES` / `discoverSurfaces`                                                                              | three shapes with tails         | `rules` has no shape tail (any `.md`, recursive) and lives under a dot-dir, not the root — a different bound |
| `knownHomes` (`surface-discovery.ts:433-446`)                                                                      | `{skill, agent, command}[kind]` | must exclude `rules`                                                                                         |
| `pluginDirLayoutIssues`                                                                                            | surfaces + hooks dir            | fine either way                                                                                              |
| `layoutLocations` (claims)                                                                                         | adds `rulesDir` separately      | fine either way                                                                                              |
| `executableSourceDirs`                                                                                             | —                               | must exclude `rules` (prose)                                                                                 |

Five of seven consumers would need `kind !== "rules"`. That is the defect the record exists to remove (a per-value branch), reintroduced by the field that joins it. The distinction the owner wondered about is real and has a name in the tree already: **a surface is invocable, an instruction is read.** `rulesDir` stays a flat optional path beside `instructionFile`, and both are inputs to `instructionChain`, which is where their semantics (recursive, `paths:`-scoped, on-demand) actually live. The one thing that was wrong about `rulesDir` — the flat classifier at `scan-core.ts:225` while the loader reads it recursively — is fixed in stage 4 by the chain classifying rules, not by the classifier's regex.

---

## 3. The ratchet — per state, type or test

| state                    | held by                                                               | the construction, stated so it can be checked                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1                       | **type**                                                              | there is no field other than `surfaces` that names a surface dir; `surfaceDirs()` is a function of it. A layout literal with `skillDir:` is an excess property → `tsc` error.                                                                                                                                                                                                                                                                             |
| A2                       | type for the record (absent key), **test** for `""` on optional paths | conformance: `for f of [rulesDir, hookScriptsDir, hooksConventionPath, userSurfaceRoot]: need(f === undefined \|\| f.length > 0)`. Stated as a test because TS has no non-empty-string type worth the ceremony (a template-literal `${string}${string}` hack matches `""` too).                                                                                                                                                                           |
| A3                       | **type**                                                              | duplicate key in an object literal is TS1117; excess property under `satisfies` is TS2353 (probe 2).                                                                                                                                                                                                                                                                                                                                                      |
| A4                       | **type** for membership, **test** for duplicates                      | `HarnessName` is `(typeof HARNESSES)[number]["name"]`; a name outside it is unrepresentable as a `HarnessName`. Duplicates collapse the union silently (round 1 §8), so the contract loop asserts the set size. The eslint rule's name list is read from the adapters directory, and `adapter-contract.test.ts` already fails if a dir is neither registered nor a declared prototype — so a new adapter dir turns the rule on for its name with no edit. |
| A5                       | **type**                                                              | `materializeRoot` does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A6                       | **type**                                                              | probe 3: `harnessTesting: true` without `harnessTestDriver` is TS2322 under `satisfies`; `hookProtocol` with `shellHooks: false` is an excess property. Conformance keeps its runtime checks for a non-TS adapter, worded as today.                                                                                                                                                                                                                       |
| A7                       | **test**                                                              | conformance `basename(hooksConventionPath)` has an extension.                                                                                                                                                                                                                                                                                                                                                                                             |
| A8                       | **type**                                                              | the core has no `"json" \| "toml"` type; `hook-program.ts:1051` takes `registration: HookProtocol["registration"]` and `render: SettingsCodec["render"]`. A grep `'"json" \| "toml"'` over `src/` is the mutation check: it must return only the two adapter files.                                                                                                                                                                                       |
| A9                       | **type**                                                              | `UnloadedInstruction` requires `reason`; `loaded` entries have no `reason` property (excess).                                                                                                                                                                                                                                                                                                                                                             |
| the discovery bound (§4) | **test**                                                              | property tests over every registered adapter AND the prototype, with a synthetic map.                                                                                                                                                                                                                                                                                                                                                                     |
| the name ceiling (§5)    | **lint**, two arms                                                    | the existing `local/no-harness-names` (names, from readdir) plus a name-free selector: `BinaryExpression[operator=/^[!=]==$/] > MemberExpression[property.name="name"]` and `SwitchStatement > MemberExpression.discriminant[property.name="name"]` over `src/core/**` + the detectors. The second arm needs no list, so a fourth adapter cannot make it stale.                                                                                           |

---

## 4. How every new method survives the discovery bound

The test the owner uses: _can an adapter change what the domain SEES, rather than how it interprets what it sees?_ Round 1 stated the rule ("takes only what the domain enumerated; returns a label; never a root") and then proposed `localAdvisories(root)`, which takes a root. That is corrected here. Per method:

| method                                                           | receives                           | property a test asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructionChain(files)`                                        | the bounded map `F`                | (i) `loaded ∪ unloaded ⊆ keys(F)`; (ii) `imports.every(i => F[i.from].includes(i.path))` — an import is a token the REPO OWNER wrote, the adapter only found it; (iii) `patterns` likewise `⊆ tokens(F)`; (iv) pure: `chain(F)` deep-equals `chain(F)` and `chain(F ∪ G)` restricted to `keys(F)` equals `chain(F)` whenever `G` holds no instruction-shaped path (monotone in the map). Mutation that must go red: an adapter returning `"packages/x/AGENTS.md"` when that key is not in `F`.                                                                                                                                                                                                                                                     |
| `settings.parse(text)` / `render(value)`                         | text / value                       | no path argument exists; the browser twin calls `parse` on text it already holds (`scan-files.ts:241` today).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `hookProtocol.registration(on, matcher, cmd)`                    | three strings                      | pure constructor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `runtime.modelAvailability(env)`                                 | an env record                      | pure over its argument; test with `{}` and with each vendor var.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `detect(exists)`                                                 | a predicate                        | the test counts calls: `detect` may call `exists` at most N times (N = its declared marker count) and only with paths `claims(p)` is true for — that is the strongest form of "an adapter cannot probe what it does not claim". `unresolvedDeclaredRoots(scopes, dirExists)` already takes this shape.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `skillProbe()` / `adoptabilityDrafter()` / `harnessTestDriver()` | nothing                            | they return RUNNERS for the executing tiers, which spawn processes after consent; they are not reads of the repo and the bound does not apply. Said explicitly rather than pretended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `advisories(read)`                                               | a `ClaimedReader` the DOMAIN built | the reader refuses unclaimed repo paths; test: a fake reader records every request, and `advisories` must request only paths for which `adapter.claims(p)`. What `checkSkillReachability` reads today — `package.json`, `.claude/skills`, `.claude/settings.json`, `node_modules/vigiles/skills`, `~/.claude/plugins/installed_plugins.json` (`src/skill-reachability.ts:184-214`) — maps as: `package.json` → the injected fact `repoDependsOnVigiles`; `.claude/*` → claimed; `node_modules/vigiles/skills` → **not claimed**, so it becomes a second injected fact (`vendoredSkillNames`) or the check drops that branch. `checkDialectDrift()` reads the installed `claude-code` package and `PATH`, never the repo: it uses `read.home` only. |

**The bound itself, extended for instructions.** `INSTRUCTION_SHAPES` beside `SURFACE_SHAPES`: the repo root's direct files (one `readdir`, depth 0 — covers Codex fallback names the domain does not know), `<dot-dir>/*.md`, `<dot-dir>/rules/**/*.md`, and each registered layout's `settingsPath` (a claimed file; Claude Code's `claudeMdExcludes` and Codex's `project_doc_fallback_filenames` both live in settings — two vendors, one shape, the argument for a method that #262 made). Then the **second bounded pass** for `imports`: concrete relative paths, inside the repo (no `..`, no absolute), `exclude`-governed, closure depth ≤ 4 (vendor: "maximum depth of four hops"), and only paths that occur literally in the loaded text. A pattern is never expanded outside the map: OpenCode's `packages/*/AGENTS.md` is matched against `keys(F)` and otherwise reported. The weight report prints "N imports weighed, M patterns not reached" — a number that is true of something, which the current one is not (#262 §2).

**What this cannot see, stated:** `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`, `~/.claude/CLAUDE.md`, user-level `claudeMdExcludes` in `settings.local.json`, and `claudeMdExcludes` patterns matched against ABSOLUTE paths (vendor: "matched against absolute file paths") — the chain applies the `**/`-prefixed patterns to repo-relative keys and reports the rest as unapplied. None of these is repo state, so none belongs in a grade.

---

## 5. The name: the ceiling confirmed, with a probe, and what the design buys instead

#263 D invites a challenge to "detectable, not unrepresentable". I tried the one type-level construction that could raise it and it does not hold:

```
scratchpad/r2/brand.ts — type HarnessName = string & { readonly [brand]: true }
  if (n === "codex") {}        // expected TS2367 — COMPILES (TS2578: unused @ts-expect-error)
  if (r === "codex") {}        // r: ("codex" & Brand) | ("claude-code" & Brand) — COMPILES
```

TypeScript's comparability relation for `===` is looser than assignability; a branded string is comparable to a string literal. An OBJECT token (`class HarnessId { toJSON() }`) would make `id === "codex"` an error — and would move the comparison one member deeper (`id.name === "codex"`), because the string must exist for `--harness=`, `harnesses.<key>` and the report. So the honest ceiling is: **wherever a string exists, comparing it is expressible.** The design does three things with that instead of pretending otherwise:

1. **Remove the reason.** After stage 6 every one of round 1's twelve (a)+(b) sites reads a flag or calls a thunk; the eight (c)/(d) sites are either onboarding (`init`, `setup-plan` — the composition root's own UI, exempt by the existing eslint header) or gone (`ProbeHarness`, the mirror-collapse via `DetectSignal.via`). A grep of `adapter.name ===` / `harness === "` over `src/` minus `setup-plan.ts` and `cli-main.ts`'s `init` path should return zero; that grep is the stage-6 acceptance.
2. **Make the domain unable to receive one.** No `src/core/**` signature takes a harness name; they take `HarnessAdapter`, a port, or a flag. `replacedKeyMessage` (`config-schema.ts:329`) and the unclaimed-surface message (`surface-discovery.ts:489`) take the names/layouts they print as parameters. This is what removes their two disables — not by hiding the literal, but because the core no longer knows it.
3. **Ratchet with a list-free selector** (§3, last row) beside the list-bearing rule. The list-bearing rule can go stale in exactly the way #263 A4 describes; the selector cannot, because "never compare `.name` in the domain" does not depend on what the names are.

---

## 6. `opencode`: alive as a fixture, abandoned as a product — and the design uses it as the third implementation

Evidence, not impression: no `src/opencode.ts` barrel and no `package.json#exports` entry (`node -e` over `exports`: `./claude-code`, `./codex`, `./adapter` only); no `driver.ts`/`eval.ts`; `docs/harnesses.md:81` — _"OpenCode's mockable tier is **declared but not yet built**"_; `adapter-contract.test.ts:33` lists it as `UNREGISTERED_PROTOTYPES`. Yet it is exercised by three test files outside its own directory (`verify-plugin-guards.test.ts:38,312,721`, `core/surface-scopes.test.ts:15,111,123`, `core/layout.test.ts:65`), has its own eslint element type, and is the only implementation with `shellHooks: false`. **Verdict: alive as the port's third implementation, not as a harness.** Under this design it is where two of the illegal states are live (A1, A6), which is exactly the job a third implementation has.

What changes for it: `harnessTesting: false` and drop `runtime`/`modelMock` (the docs already say the tier is not built; A6 makes the current declaration a `tsc` error; `opencode.test.ts:36-40` flips to asserting `assertHarnessTestable` throws); `surfaces: { skill: ".opencode/skill", agent: ".opencode/agent", command: ".opencode/command" }` (its skills become readable — a behaviour change in a prototype); `hooksConventionPath` absent. And it is added to the property tests of §4 through a `PROTOTYPES` list beside `HARNESSES` in `adapter-contract.test.ts`, so a port validated against two and broken by the third fails in this repo, not in a user's.

---

## 7. The three `tsc` probes (scratchpad `r2/`, this repo's `typescript`, `strict`, `Node16`)

| probe                                                                                                        | file          | result                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. branded `HarnessName` stops `===` literal?                                                                | `brand.ts`    | **No.** Both `@ts-expect-error` reported unused (TS2578). `const s: string = n` and `JSON.stringify({n})` compile, as required.                                                                                    |
| 2. `Partial<Record<SurfaceKind,string>>` refuses a 4th kind and a duplicate kind under `as const satisfies`? | `surfaces.ts` | **Yes.** Both expected errors fired; `Object.values(l.surfaces)` types as `string[]`.                                                                                                                              |
| 3. capability⇔port as intersection of 2-variant unions, with `as const satisfies`?                           | `caps.ts`     | **Yes.** `opencode`'s shape (testing true, no driver) errors; `hookProtocol` beside `shellHooks:false` errors; both valid shapes pass; `if (a.harnessTesting) a.harnessTestDriver()` narrows without a cast. RC 0. |

Cost of probe 3 worth naming: a wrong adapter literal produces a TS error against a 32-member intersection (2⁵), which reads badly. The conformance kit keeps its per-flag messages for that reason; the type is the gate, the kit is the explanation.

---

## 8. Migration in stages, each leaving `npm run build` and `npm run check` green

Ordering rule: each stage deletes something and shrinks a list; no stage depends on a later one. The eleven per-site disables of `b9146ee` are tracked as `11 → n`.

> **⚠️ STALE AS A PLAN, KEPT AS A RECORD — 2026-09-21.** This table is the plan as written BEFORE the work, and stages 1–7 have since shipped on `claude/port-redesign`. It is correct history and wrong as instructions; a `grep` that lands inside it will read as current unless it reads this. Where a row and the code disagree, the CODE and its commit message are the answer.
>
> Two rows are superseded in particular:
>
> - **Stage 4** says `cli-main.ts:3755` `KNOWN_INSTRUCTION_FILES` and `core/validate.ts:82` `INSTRUCTION_FILES` should become "the registered adapters' `instructionFile`s". Half of that shipped and half is REFUSED: the two `cli-main.ts` sites derive from the registry, and `core/validate.ts` does NOT, because `core ⊄ adapter` — measured, the import takes `dist/core/validate.js` from 108 to 136 modules and pulls both adapters into the domain's graph, while `boundaries/dependencies` stays silent because it judges direct edges. The core keeps one stated default (`DEFAULT_INSTRUCTION_TARGETS`) and a ratchet test outside the core holds it to the registry.
> - **Stage 4** also says the CC dialect's comment at `claude-code/dialect.ts:116-121` "is now wrong". It was corrected in `3a14cf7`; the vendor rule it describes is now quoted verbatim in `adapters/claude-code/instruction-chain.ts`, along with two questions the vendor has NOT answered that are deliberately left open there.
>
> §9 ("what this deliberately does not fix") and §10 ("where my analysis may be wrong") are the rows that aged BEST — several §10 items were closed by measurement during the work, and their resolutions are in the commit messages rather than here.

| stage                                     | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | files (non-test)                                                                                                                                                                                          | tests touched                                                                                          | disables |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| **0**                                     | land #260 and the lint commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                         | —                                                                                                      | 11       |
| **1** `skillFrontmatterKeys`              | `dialect.ts:29,95`; `compile.ts:1036-1055,1162`; `lethal-trifecta.ts:746`; `skill-harness.ts:48`; 3 dialects; `docs/adapter-api.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2 (`grep -rl skillFrontmatter src --include=*.test.ts`)                                                                                                                                                   | **11 → 6** (dialect.ts, compile.ts ×3, lethal-trifecta.ts)                                             |
| **2** registry as source of truth         | `as const satisfies` on 3 adapters; `HARNESSES`/`HarnessName`; duplicate assert + `PROTOTYPES` in `adapter-contract.test.ts`; eslint rule reads names from `readdirSync`; delete `DEFAULT_NAMES`; add the list-free `.name` selector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 1                                                                                                                                                                                                         | 6 (closes A4; no disable is at a registry site)                                                        |
| **3** layout reshape (A1, A2, A3, A5, A7) | `core/layout.ts`; `surfaceDirs()`/`executableSourceDirs()`; `plugin-loader.ts` (391-397, 427-432, 463, 491, 503, 543, 628, 729); `scan-files.ts` (mirror sites); `scan-core.ts:215-264,369-380`; `core/surface-discovery.ts:200-231,433-446`; `core/surface-scopes.ts:149-173,196`; `core/orphans.ts:119-123`; `test-coverage.ts:111-118,351,413-419`; `test-coverage-files.ts:86-89,115-116,158-159`; `scan.ts:802`; `scan-files.ts:771`; `adapter-conformance.ts:85`; 3 layouts; `docs/adapter-api.md`, `docs/configuration.md` (the `vigiles:symbol` cross-links make `lint` red until edited — that is the mechanism working), `docs/rules/untested-subagent.md:49`; `site/src/demo/fetchRepo.ts:95` derives `HARNESS_DIRS` from `surfaceDirs()`                                                                                                                                                                                                                                          | union of the per-field counts ≈ 12 files, `materializeRoot` alone 9; 3 files hold `PluginLayout` literals (`plugin-loader.test.ts`, `core/surface-scopes.test.ts`, `adapters/claude-code/layout.test.ts`) | 6                                                                                                      |
| **4** instruction surface (#262)          | **[STALE — see the banner above this table]** new `core/instruction-chain.ts`; `INSTRUCTION_SHAPES` + the imports pass in `surface-discovery-fs.ts`; `instruction-weight.ts` drops `alwaysLoaded`/`matchesGlob`, `weighInstructions(chain, budget)` returns committed + effective totals; delete `scan.ts:1098-1140`; `scan-files.ts:807-810` one call, and the twin now reads rules (it reads none today — `grep rulesDir src/scan-files.ts` is empty, so CLI and browser disagree on every repo with `.claude/rules/`); `scan-core.ts:225` — `isRule` answers from the chain, not a flat regex; `cli-main.ts:3031` `gatherInstructionFiles`, `cli-main.ts:3755` `KNOWN_INSTRUCTION_FILES`, `core/validate.ts:82` `INSTRUCTION_FILES` → the registered adapters' `instructionFile`s; CC dialect `instructionTargets` gains `AGENTS.md` (vendor, v2.1.277+: _"Claude Code can read `AGENTS.md` as your project instructions"_ — the comment at `claude-code/dialect.ts:116-121` is now wrong) | 1 (`instructionBudget`), 0 (`alwaysLoaded`); new property tests                                                                                                                                           | 6                                                                                                      |
| **5** codec + registration (A8)           | `SettingsCodec` on 3 layouts; `HookProtocol.registration` on 2 protocols; the 6 encoding sites and 3 shape sites of §2 A8; `hook-program.ts:1051` takes the two functions; `adapter-conformance.ts:189-191` deleted, `:262-274` renders the fixture through `registration` + `render`; `docs/adapter-api.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2                                                                                                                                                                                                         | 6                                                                                                      |
| **6** capabilities + thunks (A6)          | `core/adapter.ts` unions; `runtime.modelAvailability` on 3 runtimes; `skillProbe` thunks absorb `scan-behavioral.ts:96-125`; delete `ProbeHarness` (`:44`) and the `harness:` option; `cli-main.ts` 5788, 7539 (see §9), 8016-8025, 8407-8415, 8447, 8471, 8677, 8696, 8722; `scan-behavioral.ts` 584, 1017; `verify-plugin-guards.ts:109` takes the adapter it is given (`:532` already receives one); `advisories(read)` with the `ClaimedReader` built in `cli-main`; `opencode` to `harnessTesting: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 8 name-literal test files (round 1 §6)                                                                                                                                                                    | 6                                                                                                      |
| **7** one composition root                | `detect(exists)` on 3 adapters; delete `layout-registry.ts` + its test (claims-agreement test folds into `adapter-contract.test.ts`); `scan-files.ts:53`, `scan.ts:790` read `HARNESSES.map(a => a.layout)`; remove the CC defaults at `scan.ts:601,645,932,985` and `test-coverage.ts:665` — callers pass what they resolved, the CC wrapper at `adapters/claude-code/plugin-loader.ts:30-50` is the pattern; `replacedKeyMessage(present, knownNames)`; the unclaimed finding names `layouts[0].name` (or the detected layout) instead of `"claude-code"`; `site/src/demo/runAudit.ts:25` passes `claudeCodeAdapter`                                                                                                                                                                                                                                                                                                                                                                        | `layout-registry.test.ts` (deleted), scan tests that rely on the default                                                                                                                                  | **6 → 1** (scan.ts ×2, test-coverage.ts, surface-discovery.ts, config-schema.ts "example config text") |
| **8** (optional)                          | nothing — A6 is already in stage 6; this row exists to say the intersection type is not a separate step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                         | —                                                                                                      | 1        |

The surviving disable is `config-schema.ts:312-316`, the _quoted legacy config_ in the migration notice for the removed `harness` key. Its author called it "the one exemption here that is not debt" and that is right: it quotes a historical artefact, and the lint rule's own header says a comment saying the word is not a finding. It stays.

Stages 3 and 4 are the two that touch many files; each is still one PR by the repo's "one reason to roll back" rule — stage 3 is "the layout no longer carries copies", stage 4 is "instructions are classified by the harness". Stages 1, 2, 5, 6, 7 are each a morning.

---

## 9. What this deliberately does not fix, and why

- **`cli-main.ts:7539` (`adapter.name !== "claude-code"` — "react output confirmed only for Claude Code").** Round 1 wanted a per-channel `verified` on `EventCapability`. That is a vocabulary-status question (`HarnessVocabulary` already carries per-term status) and belongs to the event-capability table's owner, not to this port. Left as a name-branch in the application layer, outside the lint rule's file set, with this sentence as the reason.
- **`init` / `setup-plan.ts:450,471`.** The composition root's own UI; it installs vigiles's own plugin for one harness by name. Exempt by the existing eslint header, and correctly so.
- **Codex `.agents/skills` walk-up and nested `AGENTS.md`.** Out of the bound by design (`codex/layout.ts:24-45`); the chain reports a nested `AGENTS.md` that happens to be in the map as `on-demand/subdirectory`, and nothing else. Point `vigiles audit` at the subpackage.
- **`claudeMdExcludes` against absolute paths, and every home-directory file.** §4 says what is applied and what is reported as unapplied. Reading `~` for a grade is wrong on its face.
- **The `hooks`-dir value for Codex.** `hookScriptsDir: "hooks"` on Codex carries over today's `intraRefDirs` value, which nothing in the vendor pages confirms. It stays as it was, with a comment saying so, rather than being "aligned" from a guess — the same stance `codex/layout.ts:46-52` takes for `installCodexSkills`.
- **`instructionBudget` staying on the dialect** while `instructionChain` is on the layout. The budget is a format fact (unit, limit, what happens over it); the chain is a location-and-content fact. Two ports, one consumer (`weighInstructions(chain, budget)`), no branch. Moving one to sit beside the other would be redrawing a box.
- **Making `PluginLayout` a class, or the ports methods-first.** Round 1 answered this and the answer stands: data where one code path interprets every value, a method where content or siblings decide.
- **The browser twin's `fetchRepo.ts` root-file list** (`HARNESS_ROOT_FILES`, `:93`). Stage 3 derives `HARNESS_DIRS`; the root-file set should be derived from `INSTRUCTION_SHAPES` + each layout's file fields in stage 4. Listed here because it is a site change, not an engine change, and the site is not in `npm run check`.

---

## 10. Where my analysis may be wrong — a work queue

1. **The `surfaces` record loses ordering, and I have asserted no consumer needs it.** `materializeScope` keys `counts` by dir and `pluginDirLayoutIssues` orders findings by input; `knownHomes` sorts. The one I could not fully rule out: `assertDistinctScopeKeys` and `scopeKey` — they range over scopes, not dirs, so ordering of dirs should not reach them. Verify by running the loader tests after the change with the record iterated in reverse.
2. **A5 assumes `materializeRoot` is only ever read as "the user root" / a key prefix.** Closed after writing: `scan.ts:708` and `scan-files.ts:695` feed `scanSkills`'s context, whose only read is `scan-core.ts:491-514` → `onDiskPath`, which strips it as a prefix. All 24 non-test reads are now accounted for as prefix or user-root uses. Remaining risk is only the 9 test files that spell the field.
3. **The imports pass may widen the read in a way the owner does not want.** It reads owner-written concrete paths only, bounded by depth 4 and `exclude`, but it IS a read outside the dot-dir bound. If that is unacceptable, `imports` becomes report-only like `patterns`, and the Claude Code weight is under-reported by the imported size (vendor: imported files "still load and enter the context window at launch"). Decide before stage 4.
4. **`INSTRUCTION_SHAPES` includes each layout's `settingsPath`** so the chain can read `claudeMdExcludes`/fallback names. Claude Code's are documented for `.claude/settings.local.json` too, which is not `settingsPath`. I did not add it to the bound; if the owner wants local settings honoured (advisory), it is one more entry, gitignored by convention, `scope: "local"`.
5. **`detect(exists)` call-count property.** I proposed "at most N calls, all to claimed paths". Claude Code's `detect` probes `manifestPath`, `settingsPath`, `instructionFile` — all claimed. Codex probes `.codex/config.toml` (= `settingsPath`, claimed) and `AGENTS.md`. `opencode` probes `opencode.json` (= manifest). Holds for all three; a fourth adapter that wanted to detect by a marker it does not read (a lockfile, say) would be refused by this property, and I have not decided whether that is right.
6. **The eslint rule reading names from `readdirSync("src/adapters")`** assumes adapter dirs are named after adapters. `adapter-contract.test.ts:105-120` asserts it for registered ones and for `UNREGISTERED_PROTOTYPES`; a dir that is neither fails that test, so the assumption is tested — but only under `vitest`, not under `eslint`, so a bad dir name would make the lint rule silent for that name until the test ran. Acceptable; noted.
7. **Stage 7 removes `scanPlugin`'s CC defaults.** Closed after writing: `grep -n 'scanPlugin\|scan-files' src/test.ts src/linting.ts src/eval-surface.ts` is empty, so neither `scanPlugin` nor `scanFiles` is on a published barrel and the defaults can go without a wrapper. A deep import of `dist/scan.js` by a third party would still break, and `package.json#exports` does not permit one.
8. **Test-file counts are filename greps** (`grep -rl`), not assertion counts, and the union across stage 3's six fields is estimated at ~12; the true number is the union, which I did not compute. `materializeRoot` at 9 is exact.
9. **`hook-normalize.ts` "already tolerates both shapes"** is read from its header (`:4-12`, `:79-83`), not from running it against a TOML fixture with a matcher. If a third shape appears (YAML with a different nesting), `registration()` handles writing but reading would need a `HookProtocol.registrations(config)` inverse — one more method, deferred until a third shape exists (the repo's own rule-of-three).
10. **`ClaimedReader` for `advisories` may be more machinery than two CLI-only checks deserve.** The alternative — leave `adapter.name === "claude-code"` at `cli-main.ts:8407` as the one sanctioned application-layer branch, like §9's first bullet — is cheaper and I would accept it. I chose the reader because the brief asked every new method to state how it survives the bound, and `(root) => string[]` cannot.
11. **The 21-site census is round 1's grep, not an AST census.** `switch (adapter.name)` and a name held in a variable before comparison are not in it. The list-free selector in §3 IS that census, applied continuously; until it lands, the count may be low.
12. **I did not run `npm run check` or `npx vitest run`**, only `tsc --noEmit` (RC 0). Every "green" claim in §8 is a claim about a design, checked against the call sites listed, not a measured run.
