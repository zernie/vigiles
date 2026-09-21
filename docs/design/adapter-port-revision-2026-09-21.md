# Adapter port revision — static fields vs. functions, the instruction chain, and the layering

**VERDICT: DOES NOT HOLD.** Static data is the correct shape for almost everything on `PluginLayout`, and the codebase already draws the data/function line correctly where the variance is computational (`HarnessRuntime.wireMock`, `versionKey`, `HarnessAdapter.detect`, `claims`, `harnessTestDriver`). Of the 21 harness-name comparisons I count in non-test source (the brief said 16; my grep found five more, listed below), only 7 want a port *method*, 5 want a *declared capability* (data), 7 are legitimate or are a mis-named data field, and 2 are a too-thin `detect` result. The one place the hypothesis lands — the instruction surface — is not "a field that should have been a function"; it is a concept the port does not have at all, so every consumer that needed it improvised one from the nearest field, and two of those improvisations re-created the unbounded, adapter-driven walk that `surface-discovery.ts` was written to abolish.

Branch measured: `claude/optional-grammars` @ `e7c626f` (16 ahead of `origin/main` @ `5f9d1f5`). Every file:line below is from that tree. Nothing was modified; no tests were run beyond one throwaway `tsc` experiment in the scratchpad (§9).

---

## 1. The generating cause

`PluginLayout` answers exactly one question — **"where is X?"** — as repo-relative paths, and the domain interprets every path with one code path (`join`, `startsWith`, a regex built from it). That is a correct port and it is why 16 of its 19 fields cause no trouble. The trouble starts where the domain needs to ask a *different* question of the harness — "how do I read this?", "what is this file to you?", "in what order and under what override does this load?", "can you do X?" — and the port has no field for it. When that happens, a consumer does one of three things, all visible in the tree: it branches on `adapter.name` (21 sites), it invents a mini-language on a string field and a private interpreter for it (`instructionBudget.alwaysLoaded` globs → `readAlwaysLoaded` in `src/scan.ts:1098-1140`, with its own `walk`/`findNested`), or it hard-codes the answer for the two harnesses it knows (`gatherInstructionFiles`, `src/cli-main.ts:3031-3037`; `INSTRUCTION_FILES` in `src/core/validate.ts:82`; the site's `HARNESS_ROOT_FILES`/`HARNESS_DIRS` in `site/src/demo/fetchRepo.ts`). The instruction surface is where all three happen at once, because it is the one surface whose semantics are genuinely *compositional* per harness (a chain with precedence and overrides) rather than *locational* (a directory). So the cause is not "fields should be functions"; it is **the port models location and the domain keeps needing classification and composition**. A method is the right answer only where the answer depends on something a path lookup cannot see — file content (a `paths:` frontmatter key), sibling files (an `AGENTS.override.md` shadowing `AGENTS.md`), or the repo's own settings (`project_doc_fallback_filenames`). Everywhere else, the fix is a *better-shaped data field* (a capability flag, a key set instead of a profile enum, a structured `detect` result), not a function.

---

## 2. Classification of every harness-name branch

Census command: `grep -rnE '\.name === "|\.name !== "|=== "codex"|=== "claude-code"|=== "claude"|!== "codex"|!== "claude-code"|harness === "|harness !== "' src --include=*.ts` excluding `*.test.ts`, then dropping `_specType === "claude"` (a spec kind, not a harness) and `c.name === "Skill"` (a tool name). **21 sites**, plus one dialect-profile comparison that is the same defect by another name.

| # | site | what it decides | category | where it belongs |
|---|---|---|---|---|
| 1 | `src/cli-main.ts:4260` `shortHarness` | canonical → short alias for `init` | (c) presentation, fine as data | derive from `HARNESS_ALIASES` in `adapter-registry.ts:96` instead of a second hand-written inverse; composition root, stays |
| 2 | `src/cli-main.ts:5788` `ProbeHarness` narrowing | which eval probe drives `measure` | (a) port method | `adapter.skillProbe?: () => Promise<SkillProbeDriver>` — the `harnessTestDriver` thunk pattern, present iff `capabilities.skillFiring` |
| 3 | `src/cli-main.ts:7539` `adapter.name !== "claude-code"` | "react output is confirmed only for Claude Code" | (b) capability table, **new column** | `EventCapability` (`core/event-capability.ts:65-71`) carries `carries`/`honours`/`matcher`/`denyShape` and no measurement status; add a per-channel `verified: boolean` (or reuse the vocabulary's per-term status) and let the warning read it |
| 4 | `src/cli-main.ts:7856` `ProbeHarness` narrowing | same as #2 | (a) | same as #2 |
| 5 | `src/cli-main.ts:8017` `triggerCostWording(harness)` | what running the trigger tier costs / needs | (a) port method (needs `env`) | `runtime.modelAccess(env): { available; metered; hint }` |
| 6 | `src/cli-main.ts:8356` `a.layout.name === adapter.layout.name` | sort the primary harness first | **fine as-is** — compares two port values, no literal | keep; not a name-branch, do not count it |
| 7 | `src/cli-main.ts:8407` `adapter.name === "claude-code"` | run `checkDialectDrift` + `checkSkillReachability` | (a) optional adapter method | `adapter.localAdvisories?: (root) => readonly string[]`, present iff `capabilities.localAdvisories` (advisory, never scored — already the site's own comment) |
| 8 | `src/cli-main.ts:8447` `adoptableRefs` | can adoptability draft from this instruction file | (b) capability flag | `capabilities.adoptability: boolean` (the drafting drives the `claude` CLI) |
| 9 | `src/cli-main.ts:8471` `modelReachable` | is a model reachable for firing | (a) | `runtime.modelAccess(env).available` (same as #5) |
| 10 | `src/cli-main.ts:8677` `modelReachable` | same | (a) | same as #5 |
| 11 | `src/cli-main.ts:8722` "adoptability preview is Claude Code only" | print the deferral | (b) | `!capabilities.adoptability` |
| 12 | `src/adapter-registry.ts:74` `w.name === "codex"` | mirror-collapse tie-break | (d) `detect` result too thin | `detect` returns `{ specificity, via }`; collapse "both matched `via: "instruction-file"` and the files mirror" by dropping the adapter whose file is the mirror's `link`, never by name |
| 13 | `src/adapter-registry.ts:79` `w.name !== "codex"` | the drop half of #12 | (d) | same |
| 14 | `src/setup-plan.ts:450` `harness === "claude"` | the plugin-install recipe | (c) composition root, fine | `init` names vigiles's own marketplace and CLI; the eslint header at `eslint.config.mjs:49-51` already exempts onboarding. Optional later: `adapter.installPlan()` |
| 15 | `src/setup-plan.ts:471` `harness === "codex"` | same | (c) | same |
| 16 | `src/scan-behavioral.ts:107` `buildProbe` | eval driver + fired-predicate + stub policy | (a) | the `SkillProbeDriver` thunk of #2 — this function IS the driver, it just lives in the application layer keyed by name |
| 17 | `src/scan-behavioral.ts:584` `harness !== "claude-code"` | "selection-collision is Claude Code only (no skill-selection event)" | (b) capability flag | `capabilities.skillSelectionEvent: boolean` |
| 18 | `src/scan-behavioral.ts:1017` `harness !== "claude-code"` | "adversarial-gate is Claude Code only" | (b) | same flag |
| 19 | `src/core/lethal-trifecta.ts:746` `dialect.skillFrontmatter === "claude-code"` | does this harness honour `disallowed-tools:` | (c) **data, mis-named** | `dialect.skillFrontmatterKeys: readonly string[]`; the check becomes `keys.includes("disallowed-tools")` — the profile enum names a harness where it should name a key set |
| 20 | `src/core/compile.ts:1036` `profile === "claude-code"` | which SKILL.md keys to emit | (c) data, mis-named | emit a key iff it is in `skillFrontmatterKeys` — one code path, no branch |
| 21 | `src/skill-harness.ts:48` `dialect.skillFrontmatter === "minimal"` | same profile, other side | (c) | same |
| 22 | `src/skill-harness.ts:48` is #21; the 22nd is `ProbeHarness` itself — `src/scan-behavioral.ts:44` `type ProbeHarness = "claude-code" \| "codex"` | a hand-written harness union | (d) second source of truth | delete; derive `HarnessName` from the registry (§8) |

Totals: **(a) 7 · (b) 5 · (c) 7 (of which 3 are one mis-named enum) · (d) 3**. The brief's 16 are all here; I do not count #6 as a defect. Sites #19–21 are not on the brief's list as name-branches but are the same thing wearing the dialect's coat: a data field whose *values* are harness names, so consumers compare against the name.

What this table says against the hypothesis: **the largest category the port is missing is declared capabilities — data.** Five sites print "X is Claude Code only" and the adapter has no field to say so, although `AdapterCapabilities` (`src/core/adapter.ts:32-73`) is exactly that field and already gates 17 other call sites cleanly (`capabilities.subagents`, `shellHooks` — `grep` count 17 non-test uses). The seven method sites reduce to three methods (`skillProbe`, `modelAccess`, `localAdvisories`), all of which follow a pattern the bundle already has (`harnessTestDriver` thunk; `wireMock` over an injected value).

---

## 3. The worked example: instruction surfaces

### 3.1 What the tree says today — five spellings, none the vendor's

| where | what it encodes | shape |
|---|---|---|
| `PluginLayout.instructionFile` (`core/layout.ts:29`) | one root file | path |
| `PluginLayout.rulesDir` (`core/layout.ts:75`) | a folder of rule files | dir; read recursively by `readTree` (`plugin-loader.ts:204`, via `materializeRules` at `:491-510`) but classified **flat** by `scan-core.ts:225` (`<rulesDir>/[^/]+\.md$`) |
| `HarnessDialect.instructionTargets` (`core/dialect.ts:82`) | filenames the harness reads | names; CC says `["CLAUDE.md"]` (`adapters/claude-code/dialect.ts:122`) while `docs/adapter-api.md` says `["CLAUDE.md","AGENTS.md"]` — the doc and the code disagree, and the vendor now sides with the doc (below) |
| `HarnessDialect.instructionBudget.alwaysLoaded` (`core/instruction-weight.ts:51`) | globs of unconditionally-loaded files | a mini-language: `matchesGlob` in the core (`:88-104`), and on the CLI side a **private interpreter that walks the repo** (`scan.ts:1098-1140`: `glob.endsWith("/**")` → `walk`, `glob.startsWith("**/")` → `findNested` over every non-dot directory) |
| `gatherInstructionFiles` (`cli-main.ts:3015-3050`) | files to route rules from | `new Set([instructionFile, "CLAUDE.md", "AGENTS.md"])` + `globSync(["**/CLAUDE.md","**/AGENTS.md"])` |
| `INSTRUCTION_FILES` (`core/validate.ts:82`) | recognised instruction basenames | `["CLAUDE.md","AGENTS.md"]` literal in the core |
| site `HARNESS_ROOT_FILES`/`HARNESS_DIRS` (`site/src/demo/fetchRepo.ts`) | what the browser twin fetches | a sixth list, Claude-Code-only, outside the engine |

Two of these already violate the constraint the owner flagged as fatal. `readAlwaysLoaded` (`scan.ts:1116-1130`) descends into every directory of the user's repository except `node_modules/.git/dist/build/vendor` and dot-dirs, driven by a string an **adapter** wrote (`codexLayout` → `"**/AGENTS.md"`, `adapters/codex/dialect.ts:48`). Register an adapter whose budget says `"**/RULES.md"` and vigiles reads more in everyone's repo. `gatherInstructionFiles` does the same with literals. Both were written under the discovery-boundary lint (`eslint.config.mjs`, `DISCOVERY_SELECTORS`) and pass it, because that rule polices *exclusion*, not *who chose the walk*.

### 3.2 What the vendors actually do (fetched 2026-09-21)

Codex, `developers.openai.com/codex/guides/agents-md`, verbatim: "Starting at the project root (typically the Git root), Codex walks down to your current working directory. … In each directory along the path, it checks for `AGENTS.override.md`, then `AGENTS.md`, then any fallback names in `project_doc_fallback_filenames`. Codex includes at most one file per directory." and "Codex concatenates files from the root down, joining them with blank lines. Files closer to your current directory override earlier guidance … Codex skips empty files and stops adding files once the combined size reaches the limit defined by `project_doc_max_bytes` (32 KiB by default)." The config reference confirms `project_doc_fallback_filenames` (array), `project_doc_max_bytes`, `project_root_markers` are keys of the repo's own `config.toml`.

Claude Code, `code.claude.com/docs/en/memory`, verbatim: "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your current working directory and every directory above it. … All discovered files are concatenated … Within each directory, `CLAUDE.local.md` is appended after `CLAUDE.md`. … Claude also discovers `CLAUDE.md` and `CLAUDE.local.md` files in subdirectories under your current working directory. Instead of loading them at launch, they are included when Claude reads files in those subdirectories." On rules: "All `.md` files are discovered recursively" and "Rules without a `paths` field are loaded unconditionally … Path-scoped rules trigger when Claude reads files matching the pattern." On AGENTS.md: "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it … `.claude/rules/` files … keep loading alongside `AGENTS.md`."

Three consequences for the shipped numbers, each a live defect of the *data* spelling:

1. **Codex weight over-reports.** `"**/AGENTS.md"` sums every nested `AGENTS.md` in the repo, but at any one cwd Codex loads only the root→cwd chain. For a `vigiles audit` at the root the true always-loaded set is the root file alone (plus `~/.codex`, which is out of the repo). A monorepo with twelve package-level `AGENTS.md` files is told it is 12× over a budget it never approaches.
2. **Claude Code weight over-reports.** `".claude/rules/**"` counts path-scoped rules, which the vendor says are on-demand. Whether a rule is in the sum is a fact about its **frontmatter**, which no glob can express.
3. **Nested rules are read and then lost.** `readTree` reads `.claude/rules/frontend/x.md` into `files`; `makeClassifier.isRule` never matches it; `frontmatter-valid` and the rule map see a file with no role. The field was right (rules live in that dir); the domain's *reader* encoded a depth the vendor does not have — the same class as `AGENT_FILE_LEAF_RE`'s history in `core/layout.ts:108-135`.

None of the three is fixed by turning `rulesDir` into a function. #3 is a one-regex fix to a reader. #1 and #2 need something that can see a file's content and its siblings.

### 3.3 `rulesDir` is not "named after one harness's implementation"

Cursor keeps `.cursor/rules/*.mdc` with a `globs:` frontmatter key; Windsurf keeps `.windsurf/rules/*.md` with `trigger`/`globs`; Claude Code keeps `.claude/rules/*.md` with `paths:`. "A directory of rule files, scoped by a frontmatter key" is a three-vendor shape, exactly as `skills/agents/commands` are cross-vendor names in `SURFACE_SHAPES`. Codex is the outlier, with a per-directory chain and no rules dir. The port must express **both** shapes, and the location half of the rules shape is a path — data. What is missing is the classification half.

### 3.4 `AGENTS.override.md` — what "not committed" means for a grade

The owner's instinct is right that precedence-over-committed-files does not fit a string field, and right for the reason he gives: it is a *function of the sibling set*, not a property of a path. On the second question — should an uncommitted override be read at all, and what does the grade mean if it is — the answer follows from a rule the tree already applies elsewhere (`cli-main.ts:8407-8415`: "Advisory only (machine state, not repo state) — never scored"):

- **Read it, lint it, never score it.** It is an instruction file and can be wrong (dangling refs, bad frontmatter); the person running `vigiles audit .` benefits from hearing that. But a grade is a statement about the repository, and the override is a statement about one machine. The vendor itself says `CLAUDE.local.md` should be gitignored; `AGENTS.override.md` is documented as the same kind of thing.
- **Shadowing is a finding.** An override that hides a committed `AGENTS.md` means "the instructions this team committed are not what this machine's agent reads." That is more useful than the override's own lint results and it is only expressible by a classifier that sees both files.
- **Two chains in the weight report**: the *committed* chain (what any fresh clone loads — the scored number) and the *effective* chain on this machine (advisory). Today's report has one number that is neither.
- **This is what keeps CLI and browser in agreement.** The browser twin fetches a GitHub tree, so it can never see an override; if the CLI scored it, the two would disagree on the same repo by construction. Classifying by *role* (`scope: "local"`) rather than by git status keeps the rule pure and needs no `git` — which the tree's own rule about git-as-carrier (`.claude/rules`, "the subject of a check lives in content, not history") also requires.

---

## 4. The proposed shape

Rule used to draw every line below, stated once so an adapter author does not guess:

> **A port field is data when the domain can interpret every possible value with ONE code path. It becomes a method when the domain would otherwise need a per-value branch, or when the answer depends on something a path lookup cannot see: file content, sibling files, or the repo's own settings. A method takes only what the domain already enumerated (a path, a text, a file map) and returns a label or a value — never a root, never a filesystem, never an enumeration.**

Under that rule, `settingsFormat` crosses (a per-value parser branch, copied four times: `plugin-loader.ts:127,145`, `scan-files.ts:239,261`, `cli-main.ts:7493-7503`, `hook-program.ts:1177` + `hook-install.ts:371`), the instruction chain crosses (content + siblings + settings), and `skillFrontmatter` does *not* cross — it is a per-value branch today only because the value is an enum instead of the key set it stands for.

```ts
// src/core/layout.ts — after. Fields kept as data are unchanged in meaning.
export interface PluginLayout {
  readonly name: string;

  // ── LOCATION: data. One code path interprets each. ──────────────────────────
  readonly manifestPath: string;
  readonly hooksConventionPath: string;
  readonly settingsPath: string;
  /** The PRIMARY root instruction file — what `compile` writes and `init` scaffolds.
   *  Membership in the loaded chain is `instructionChain`'s job, not this field's. */
  readonly instructionFile: string;
  readonly surfaceDirs: readonly string[];
  readonly userSurfaceRoot?: string;
  readonly skillDir: string;
  readonly agentDir: string;
  readonly commandDir: string;
  /** Stays: "a directory of rule files" is a Cursor/Windsurf/Claude Code shape and its
   *  location is a path. The reader must be recursive (vendor: "discovered recursively"). */
  readonly rulesDir?: string;
  readonly materializeRoot: string;
  readonly pluginRootToken: string;
  readonly projectRootTokens?: readonly string[];
  readonly mcpConfigFile: string;
  readonly mcpManifestKey: string;
  readonly intraRefDirs: readonly string[];

  // ── CODEC: a method, because a format value forces a per-value parser branch. ──
  /** Replaces `settingsFormat: "json" | "toml"`. */
  readonly settings: SettingsCodec;

  // ── COMPOSITION: a method, because the answer depends on content, siblings and settings. ──
  /**
   * The instruction files this harness loads at a repo-root session, in load order,
   * each with its role. `files` is the BOUNDED map the domain enumerated
   * (`INSTRUCTION_SHAPES`, §5); the result is a subset of its keys. Pure. Replaces
   * `dialect.instructionBudget.alwaysLoaded` and the private glob interpreter.
   */
  instructionChain(files: Readonly<Record<string, string>>): readonly InstructionEntry[];
}

export interface SettingsCodec {
  /** For messages and the schema only. The core never dispatches on it. */
  readonly label: string;                       // "json" | "toml" | anything a third party ships
  parse(text: string): Record<string, unknown>; // throws on malformed input; callers catch as today
  render(value: Record<string, unknown>): string;
}

export interface InstructionEntry {
  readonly path: string;
  /** What the file IS to this harness. */
  readonly kind: "root" | "root-local" | "root-override" | "rule" | "import";
  /** Loaded without a decision by the agent? The budget sums `"always"` only. */
  readonly loaded: "always" | "on-demand";
  /** Team instruction (committed) or per-machine? `"local"` is linted, never scored. */
  readonly scope: "repo" | "local";
  /** Present when this entry hides another: `AGENTS.override.md` over `AGENTS.md`. */
  readonly shadows?: string;
}

// src/core/dialect.ts — after
export interface HarnessDialect {
  // …unchanged…
  /** Replaces `skillFrontmatter: "claude-code" | "minimal"`. The compiler emits a key
   *  iff it is here; `dialectSupportsSkillFence` is `keys.includes("disallowed-tools")`. */
  readonly skillFrontmatterKeys: readonly string[];
  /** `alwaysLoaded` removed; the other four fields stay. */
  readonly instructionBudget?: Omit<InstructionBudget, "alwaysLoaded">;
}

// src/core/adapter.ts — after
export interface AdapterCapabilities {
  readonly referenceVerification: true;
  readonly harnessTesting: boolean;
  readonly shellHooks: boolean;
  readonly subagents: boolean;
  /** The harness emits a skill-selection event a probe can observe (#17, #18). */
  readonly skillSelectionEvent: boolean;
  /** vigiles can draft a spec from this harness's instruction file (#8, #11). */
  readonly adoptability: boolean;
  /** `skillProbe` present iff true (#2, #4, #16). */
  readonly skillFiring: boolean;
  /** `localAdvisories` present iff true (#7). */
  readonly localAdvisories: boolean;
}

export interface DetectSignal {
  readonly specificity: number;                       // 0 = not this harness
  readonly via: "manifest" | "settings" | "instruction-file";
}

export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  readonly dialect: HarnessDialect;
  readonly layout: PluginLayout;
  readonly runtime?: HarnessRuntime;
  readonly hookProtocol?: HookProtocol;
  readonly modelMock?: ModelMock;
  readonly harnessTestDriver?: () => Promise<HarnessTestDriver>;
  /** Present iff `capabilities.skillFiring`. Absorbs `buildProbe` (#16) whole. */
  readonly skillProbe?: () => Promise<SkillProbeDriver>;
  /** Present iff `capabilities.localAdvisories`. Machine state; never scored. */
  readonly localAdvisories?: (root: string) => readonly string[];
  /** `exists` is injected so the bundle is Node-free (§7). Structured so the registry
   *  can collapse a mirrored instruction-file tie without naming a harness (#12, #13). */
  detect(exists: (repoRelative: string) => boolean): DetectSignal;
  claims(path: string): boolean;
}

// src/core/runtime.ts — after (one addition; `wireMock`/`versionKey` are the precedent)
export interface HarnessRuntime {
  // …unchanged…
  /** Replaces `adapter.name === "codex" || hasModelAccess(env)` (#5, #9, #10). */
  modelAccess(env: Readonly<Record<string, string | undefined>>): {
    readonly available: boolean;
    readonly metered: boolean;
    readonly hint: string;
  };
}
```

Why each method crosses the line, and why nothing else does:

- `settings` — the domain holds `if (format === "toml")` in five places today. With a codec it holds zero and a third-party adapter can ship YAML without a core edit. The browser twin already receives text; `parse(text)` is the exact call it makes at `scan-files.ts:241`.
- `instructionChain` — cannot be a glob (frontmatter decides `loaded`), cannot be a list (`AGENTS.override.md` shadows a sibling), cannot be a constant (`project_doc_fallback_filenames` comes from `files[settingsPath]`, which the adapter parses with its own `settings.parse`). It takes the map the twin already passes to `weighInstructions` (`scan-files.ts:809`).
- `modelAccess`, `skillProbe`, `localAdvisories` — each runs a command or reads env; data cannot say "run `codex --version`".
- `detect(exists)` — the *only* Node import on any adapter bundle today is `node:fs` in the three `adapter.ts` files (grep: `src/adapters/*/{dialect,layout,runtime,hook-protocol,model-mock}.ts` import nothing from `node:`). Injecting the probe is what lets §7 collapse the two registries; `unresolvedDeclaredRoots(scopes, dirExists)` in `surface-discovery.ts:344` already uses this exact form.
- `rulesDir`, `instructionFile`, `skillDir`, … stay data: every consumer joins or matches them; a method there would be the defect in reverse.
- `skillFrontmatter` becomes `skillFrontmatterKeys` — data, but data whose values are not harness names. That removes three name-comparisons (#19–21) with one code path (`keys.includes`).

---

## 5. How it survives the discovery bound

Property, stated so a test can assert it:

> **For every registered adapter `a` and every bounded file map `F`: `a.instructionChain(F).every(e => e.path in F)`, and `a.instructionChain(F)` is a pure function of `F` — same input, same output, no `node:` import reachable from `a.layout`.**

The question the owner used — *can an adapter change what the domain SEES, rather than how it interprets what it sees?* — is answered by the signatures: `instructionChain` receives a map and returns a subset of its keys; `claims` receives a path and returns a boolean; `detect` receives an `exists` predicate the domain wrote. None can name a directory the domain did not open. Enumeration stays a domain constant, extended from `SURFACE_SHAPES` with an `INSTRUCTION_SHAPES` bound:

- the repo root's **direct files** (one `readdir`, depth 0 — this is what covers Codex's user-configured fallback names without knowing them),
- `<dot-dir>/*.md` for each depth-1 dot-directory (covers `.claude/CLAUDE.md`, `.claude/AGENTS.md`),
- `<dot-dir>/rules/**/*.md` (recursive, per the vendor),

and nothing else. `isDiscoveryRoot` decides the dot-dirs; `exclude` applies per entry as in `surface-discovery-fs.ts`. A nested `packages/x/AGENTS.md` is *not* in the map — correctly, because at a root session neither vendor loads it — and stays reachable the way the skills walk-up is: point `vigiles audit` at the subdirectory. This is the same trade `codexLayout`'s header already names for `.agents/skills`, now applied consistently to instructions instead of contradicted by `readAlwaysLoaded`.

`gatherInstructionFiles` (rule routing for the adoptability preview) is a different question — "route rules from all the prose in this repo" — and may keep a wider, `exclude`-governed walk; but it must take its basenames from the registered adapters' `instructionChain` roles over the discovered map, not from a literal `Set(["CLAUDE.md","AGENTS.md"])`. `validate.ts:82`'s `INSTRUCTION_FILES` fallback goes the same way.

A mutation test that would have caught today's violation: remove `INSTRUCTION_SHAPES` and let an adapter return a path outside `F` — the property test goes red; the current `readAlwaysLoaded` has no such test and could not have one, because the adapter *drives* the walk.

The browser twin implements all of this with zero new code paths: it already hands the whole fetched map to `weighInstructions` (`scan-files.ts:807-810`, "the file map IS the repo, so the glob filter … does the whole job"). Under the proposal it calls `layout.instructionChain(files)` instead and filters `loaded === "always"`. Its fetcher's own path list (`fetchRepo.ts` `HARNESS_DIRS`) should then be derived from `INSTRUCTION_SHAPES` + `SURFACE_SHAPES` rather than maintained by hand; that is a site change, not an engine one.

---

## 6. The price — counted

| change | source sites | test files | docs |
|---|---|---|---|
| `settingsFormat` → `settings` codec | 13 sites in 6 files: `plugin-loader.ts:117-149,173`; `scan-files.ts:232-262,284`; `cli-main.ts:7481,7493-7503`; `core/hook-program.ts:1051,1171-1189,1453`; `hook-install.ts:366-375`; `adapter-conformance.ts:189-191,262-274` — plus `core/layout.ts:27` and the 3 adapter layouts | 2 (`grep -rl settingsFormat src --include=*.test.ts`) | `docs/adapter-api.md`, `docs/authoring-an-adapter.md`; `vigilesrc.schema.json` does not carry it |
| `alwaysLoaded` → `instructionChain` + `INSTRUCTION_SHAPES` | `core/instruction-weight.ts` (drop `alwaysLoaded`, `matchesGlob`; `weighInstructions` takes entries), `scan.ts:845-853,1098-1140` (delete `readAlwaysLoaded`), `scan-files.ts:807-810`, 2 dialects; new bounded enumeration beside `boundedSurfacePaths` in `surface-discovery-fs.ts`; `cli-main.ts:3031-3037` and `core/validate.ts:82,290` stop naming files | 1 (`instructionBudget`), 0 (`alwaysLoaded`) — the walk has no test today | none name it |
| `skillFrontmatter` → `skillFrontmatterKeys` | `core/compile.ts:1036-1055,1162`; `core/lethal-trifecta.ts:746`; `skill-harness.ts:48`; `core/dialect.ts:23,95`; 3 dialects | 3 (`grep -rl skillFrontmatter src --include=*.test.ts`) | `docs/adapter-api.md` |
| capability flags (4) | the 5 (b) sites in §2 + `adapter-conformance.ts` presence⇔flag asserts (the `linter-contract.test.ts:52-63` pattern) + 3 adapters | `adapter-contract.test.ts` | `docs/harnesses.md` matrix |
| `skillProbe` / `modelAccess` / `localAdvisories` | 7 (a) sites in §2; `scan-behavioral.ts:96-125` moves into the two adapters; `scan-behavioral.ts:44` `ProbeHarness` deleted | 8 test files compare `name`/`harness` to a literal (`grep -rlE 'name === "(codex\|claude-code)"\|harness: "(codex\|claude-code)"' src --include=*.test.ts`) — those that pass `harness:` to `measure*` change signature | `docs/measuring-skills.md` if it documents `harness:` |
| `detect(exists) → DetectSignal` | 3 adapters, `adapter-registry.ts:53-88`, `layout-registry.ts` deleted (§7) | `layout-registry.test.ts` (folds into `adapter-contract.test.ts`), adapter tests that call `detect(root)` | `docs/authoring-an-adapter.md:130-140`, `docs/adapter-api.md` |
| rules classifier recursive | `scan-core.ts:225` one regex | `scan-core` tests — add the nested case | — |

External consumers: the five port interfaces are documented as semver-major on change (`docs/adapter-api.md:33-35`). `vigiles/codex` re-exports the whole adapter (`src/codex.ts:12-22`), so any third party holding a `PluginLayout` literal breaks at `tsc` on the missing `settings`/`instructionChain` members — which is the desired failure: loud, at compile time, with the conformance kit naming the gap. `assertAdapterLoadsHooks` (`adapter-conformance.ts:250-280`) stays the behavioural gate and gets simpler: it renders the probe settings with `layout.settings.render` instead of hand-writing TOML.

The 12 `layout.settingsFormat` / 3 `layout.rulesDir` / 26 `layout.instructionFile` field-access counts (`grep -rhoE "layout\.[a-zA-Z]+" src`, non-test) are the ceiling; only `settingsFormat` is touched at every access.

---

## 7. Layering — what each layer may import, and what it may KNOW

Verified facts, each re-measured:

1. `grep -rnE '^\s*(import|export)\b.*adapters/' src/core --include=*.ts` (non-test) → **empty.** The import boundary holds, and `eslint.config.mjs:201-245` (`boundaries/dependencies`, `verify-core` ⊄ `{cc,codex,opencode}-harness`) keeps it held.
2. `src/layout-registry.ts:19-20` imports both adapters' layouts. It is a second composition root, and its header says why it exists: "an adapter's `detect(root)` does real filesystem work — so that module pulls `node:fs` in." That reason is the *only* reason; the ports themselves are Node-free.
3. `src/scan-files.ts:40-41` (and `scan.ts:23-24`, `test-coverage.ts:75`, `run-hook.ts:41`, `sandbox.ts:33`, `eval.ts:43-44`, `harness-test.ts:56,63`) import a Claude Code port as a **default parameter**. Seven engine modules each carry a hidden composition root. The site passes `undefined` for both (`site/src/demo/runAudit.ts:25`) and so is wired to Claude Code by an engine default it never wrote. `scan-behavioral.ts:38-40` (probe drivers), `verify-plugin-guards.ts:109` (`claudeCodeAdapter`), `skill-contract.ts:32` (a CC parser used generically) import adapters for other reasons. **14 application files import adapters directly**; `cli-main.ts` imports four CC modules (`:255-297`) for runtime/scripts, not for wiring.
4. `src/codex.ts` and `src/claude-code.ts` re-export the adapter modules wholesale. Adapters are published API, and `docs/harnesses.md:11-30` makes "choose by import" the library's selection mechanism. Any structure must keep an adapter importable on its own, without the registry.

**The consequence the owner has not seen yet, stated plainly.** Because the core imports nothing from `src/adapters/`, none of the 21 branches in §2 is an import-graph violation. The core knows harness identity as *data*: a `string` on the port, compared to a literal. `eslint-plugin-boundaries` is blind to it by construction. The repo's own string-literal boundary (`eslint.config.mjs:55-67`, `CC_LITERAL_RE = "CLAUDE_PLUGIN_ROOT|\.claude|ANTHROPIC_"`) was built for exactly this class and misses it twice over: its regex names three Claude Code *spellings* and never a harness *name*, and its file set (`src/core/**`, `scan.ts`, `test-coverage.ts`, `plugin-loader.ts`) excludes `cli-main.ts` and `scan-behavioral.ts`, where 15 of the 21 live. So: **does the proposed structure make `=== "codex"` unrepresentable?** No, and I do not think it should try. The only way to make a string comparison unrepresentable is to stop the name being a string in the core (an opaque identity token, with the printable name living in the registry). That breaks `--harness=codex`, `Detected harness: codex`, the JSON report's `harness` field and `.vigilesrc.json#harnesses` keys, all of which are strings by contract. What the structure *can* do is three cheaper things: (i) remove the *reason* to compare — every branch in §2 has a port field or method to read instead; (ii) make the comparison red where it does not belong — extend the existing `no-restricted-syntax` selector with `Literal[value=/^(claude-code|codex|claude|opencode)$/]` (built from `readdirSync("src/adapters")` at lint-config time, as `adapter-contract.test.ts:33` already discovers prototype dirs) over `src/core/**` and the detector set plus `src/scan-behavioral.ts`; (iii) delete the hand-written unions (`ProbeHarness`) so there is nothing to compare against but the registry-derived `HarnessName`. Detectable, not unrepresentable — that is the honest ceiling, and it is the same ceiling the repo already accepted for `.claude/` literals.

**Layers.** Two directories and one file are already the right partition; I am not proposing to move any of the 94 root / 83 core / 32 adapter source files.

| layer | may IMPORT | may KNOW | may NOT know |
|---|---|---|---|
| **domain** `src/core/**` | `src/core/**`, Node-free libs | port types; capability names; codec labels only for messages | any harness name; any harness path spelling; any format-specific parser |
| **harness** `src/adapters/<h>/**` | `src/core/**` (ports, parsers, `layoutClaims`) | everything about its own harness, including its name | other adapters; the registry; the application layer |
| **composition root** `src/adapter-registry.ts` | every adapter; `src/core/**` | the full set, the aliases, the default | nothing about what a harness *does* — it holds, it does not branch |
| **application** `src/*.ts` (cli, scan, scan-files, runners, barrels) | `src/core/**`, `src/adapter-registry.ts`; **not** `src/adapters/**` except the published `src/<h>.ts` barrels | which adapter it was HANDED (a parameter) | a harness by name, except in `init`/`setup-plan` onboarding, which is explicitly the composition root's UI |

**Where the assembly happens.** One composition root, `src/adapter-registry.ts`, once `detect` takes an injected `exists` — then no adapter bundle imports `node:`, `layout-registry.ts` has no reason to exist, and `scan-files.ts:53`/`scan.ts:790` read `REGISTERED_LAYOUTS` off `ADAPTERS.map(a => a.layout)` from the one list. The drift test in `layout-registry.test.ts` becomes unnecessary because there is nothing to drift. Defaults move out of engine functions: `scanFiles(files, layout, dialect)` and `scanPlugin(dir, { adapter })` take what they are given; the *only* legitimate default is in an adapter-owned wrapper, which the tree already has as the pattern (`src/adapters/claude-code/plugin-loader.ts:41-50`, `resolveHarness(opts, layout = claudeCodeLayout)`). The site imports `claudeCodeAdapter` from `@engine/claude-code` and passes it — one line, and its `fetchRepo.ts` comment ("the demo doesn't wire the Codex layout/dialect yet") becomes a parameter instead of a default it cannot see.

**Built at module load or passed in?** The registry is a constant (`ADAPTERS`), built at load — that is what a composition root is, and it is the only file where `import { codexAdapter }` is meant to appear. Every engine function keeps taking adapters as parameters (as `scanPlugin`, `compileAgent`, `runHarnessTest` already do), so a test constructs a fake adapter without registering it and the registry is never on a unit test's path. Bundle cost: the browser twin **never imports the registry**; it imports the one adapter it grades. `hook-runtime.ts:96-104` measured 279 ms to `require` the registry (2026-09-08) and went lazy for that reason; **re-measured on this branch's `dist/` (built 2026-09-21 13:24): `require("./dist/adapter-registry.js")` = 11.4 ms, 21 modules; `layout-registry.js` = 1.8 ms, 5 modules.** The `harnessTestDriver` thunk removed the cost the lazy `require` was defending against, so the only remaining reason for the second registry is the `node:fs` import in the three `adapter.ts` files — which `detect(exists)` removes. A Node-free bundle removes the `node:fs` edge but not the dialect vocabularies, which are the bulk; the twin's cost is one adapter's vocabularies, which it already pays.

**What a new harness author touches, start to finish** (with the proposal in place):

1. `src/adapters/<h>/layout.ts`, `dialect.ts`, `runtime.ts` (if testable), `hook-protocol.ts` (if shell hooks), `model-mock.ts` (if testable), `adapter.ts` — the object, declared `as const satisfies HarnessAdapter` (§8).
2. `src/adapters/<h>/adapter.test.ts` — `assertAdapterConformance` + `assertAdapterLoadsHooks`.
3. `src/<h>.ts` — the published barrel; `package.json` `exports` — one line.
4. `src/adapter-registry.ts` — one element in `HARNESSES`.
5. `docs/harnesses.md` — one matrix row; `docs/adapter-api.md` — the column.

Zero files under `src/core/`. Today the list also includes `eslint.config.mjs` (`CODEX_HARNESS`/`OPENCODE_HARNESS` are per-adapter element patterns; collapse to one `src/adapters/*/**` element type so the boundary rule is written once) and `scan-behavioral.ts:44` (`ProbeHarness`) — both removed by the proposal.

**What moves, concretely: nothing.** Deleted: `src/layout-registry.ts`, `src/layout-registry.test.ts` (2 files; the claims-agreement test moves to `adapter-contract.test.ts`). Edited for wiring only: the 7 default-parameter files, `scan-behavioral.ts`, `verify-plugin-guards.ts` (take the adapter it is given — it already receives one at `:532`), `adapter-registry.ts`, `eslint.config.mjs`, `site/src/demo/runAudit.ts` — 12 files. `skill-contract.ts:32` imports `parseAgentToolList` from the CC adapter; read, it is a six-line wrapper — `frontmatterList(readFrontmatter(markdown), key)` over `core/frontmatter-read.ts` (`adapters/claude-code/agent-tools.ts:38-43`), already dialect-neutral (the key is a parameter). `skill-contract.ts` should call the two core functions directly; no move, one import line.

A restructuring beyond that would be a restructuring because one was asked for. The directories are right; the two registries, the seven hidden defaults, and a literal rule that names spellings instead of names are the whole of the layering problem.

---

## 8. `Record<Union, Adapter>` vs `as const satisfies` array

**Is the reading right?** Half. For linters the union is *not* hand-written: `src/core/spec.ts:26-40` declares `BUILTIN_LINTERS = [...] as const` and derives `BuiltinLinter` from it; `LINTERS: Record<BuiltinLinter, LinterAdapter>` (`core/linters.ts:1872`) is a checked *projection* of that array, not a second declaration. There is one source (the name array) and one consumer the compiler checks against it. The owner's argument does apply, verbatim, to **harnesses**: `ADAPTERS: readonly HarnessAdapter[]` (`adapter-registry.ts:24`) yields no union at all, and the tree grew a hand-written one anyway — `ProbeHarness = "claude-code" | "codex"` (`scan-behavioral.ts:44`), which already drifts (opencode is not in it, and nothing says whether it should be).

**What each form catches that the other cannot** (all four checked against `tsc` 5.x semantics in the scratchpad experiment, §9):

| failure | `Record<Union, A>` | `[…] as const satisfies readonly A[]` |
|---|---|---|
| member declared in the union, adapter missing | **tsc error** | unrepresentable (the union is the members) |
| adapter present, name not in the union | tsc error (excess property) | unrepresentable |
| two adapters with the **same name** | tsc error (duplicate object key) | **silent** — the union collapses to one literal; needs a runtime check |
| registry key ≠ `adapter.name` | runtime test only (`linter-contract.test.ts:44-48`) | unrepresentable (there is no key) |
| exhaustive O(1) lookup `REG[name]` typed non-undefined | yes | `find(...)` returns `A \| undefined`; a `Record` projection needs a cast |
| the union usable in a Node-free leaf | yes if the *name array* is the leaf (`spec.ts`) | yes via `import type { HARNESSES }` + `typeof` — erased (verified: emitted `consumer.js` has no `require`) |

So neither form is strictly better; the array makes two classes unrepresentable and loses one (duplicate names) to a one-line conformance assertion (`new Set(names).size === HARNESSES.length`).

**Does it survive this codebase?** Only with one change the snippet does not show. All three adapters are declared `export const codexAdapter: HarnessAdapter = { name: "codex", … }`. The experiment shows an annotation **widens** `name` to `string`, and so does a bare `satisfies` (`registry.d.ts`: `A1: readonly [Adapter]`, `A2: readonly [{ name: string; … }]`); only `as const satisfies` keeps `readonly name: "opencode"`. The owner's `HarnessName` therefore comes out as `string` today, silently, and the derivation is worth nothing until the three adapter files switch to `as const satisfies HarnessAdapter`. `as const` deep-freezes the literal's type, which is compatible because every port field is already `readonly`; the method members (`detect`, `claims`, thunks) are unaffected. For the browser twin: `import type { HARNESSES } from "./adapter-registry.js"` costs zero bytes (erased), and the twin does not need the union anyway — it needs one adapter.

**Rule I applied, so the next author does not guess:** *A closed set is declared once as an `as const satisfies` array of its members, and its name union is derived from it. A `Record<Name, X>` appears only as a checked projection of that array where O(1) exhaustive lookup is needed, never as a second declaration. Every registry gets a duplicate-name assertion in its conformance loop.* For linters this means: keep `BUILTIN_LINTERS` as the member array (the leaf constraint — `spec.ts` must import nothing — makes the *name* the member) and keep `LINTERS` as its projection; add nothing. For harnesses: `HARNESSES = [claudeCodeAdapter, codexAdapter] as const satisfies readonly HarnessAdapter[]`, `HarnessName = (typeof HARNESSES)[number]["name"]`, delete `ProbeHarness`, and `getAdapter(name: string): HarnessAdapter | undefined` keeps accepting untrusted input from `--harness=`. Dispatch tables in §4: there are none in the core — capabilities and codecs live on the adapter, which is the point.

The `VigilesConfig = z.infer<typeof vigilesConfigSchema>` precedent generalises exactly this far: derive the type from the value that is checked, never write it beside it. It does not say "prefer arrays to records"; it says "one declaration".

---

## 9. The minimum step

If only one thing is done: **replace `instructionBudget.alwaysLoaded` and `scan.ts:readAlwaysLoaded` with `PluginLayout.instructionChain(files)` over a bounded `INSTRUCTION_SHAPES` enumeration.**

Why this line and not the codec or the lint rule: it is the only change on the list that (1) removes a shipped violation of the constraint the owner called fatal — an adapter string driving a whole-repo walk (`scan.ts:1116-1130`); (2) corrects two numbers the audit prints today (§3.2, #1 and #2); (3) settles the `AGENTS.override.md` question with a property instead of an opinion (§3.4); (4) is implemented in the browser twin by changing one call (`scan-files.ts:809`), because the twin already does the right thing — it filters a map it was handed; and (5) is the worked example, so it is the change whose correctness the owner can check against the vendor text in §3.2 without trusting this document. The codec is hygiene with no wrong output behind it; the lint rule prevents the next branch but fixes no existing one; the capability flags are five sites that print an honest message today.

The second thing, if there is a second: `as const satisfies` on the three adapters + `HarnessName` + the literal rule extended to names (§7, §8) — it is a morning's work and it is what stops the count in §2 from growing.

---

## 10. Where my analysis may be wrong

- **The registry cost is measured on `dist/`, not on the TS sources vitest loads.** 11.4 ms / 21 modules is the CJS build; the site consumes `dist/` too (`site/vite.aliases.ts`), so it is the right number for the twin, but `hook-runtime.ts:98`'s stale 279 ms comment should be updated or removed, and its lazy `require` may now be ceremony.
- **I did not run `npx vitest run` or `npm run check`.** Every count is a grep; the test-file counts in §6 (`settingsFormat` 2, `rulesDir` 4, `instructionTargets` 2, name-literal tests 8) include comment hits and may be low by the files that construct a `PluginLayout` literal without naming those fields. `skillFrontmatter`'s test count (3) is a filename grep, not an assertion count.
- **`rulesDir` test count is inflated** — 12 source files match because `linters.<x>.rulesDir` (the Cedar/custom-linter config key) shares the name. Layout-`rulesDir` sites are 3 (`plugin-loader.ts:491`, `scan-core.ts:218`, `surface-discovery.ts:211`).
- **Codex's chain at the ROOT may include files I have not modelled.** The vendor page says the global scope (`~/.codex/AGENTS.override.md`/`AGENTS.md`) is read first; that is outside the repo and outside a grade, but `instructionChain` cannot see it and the weight report should say so. I also did not verify whether `project_doc_fallback_filenames` is honoured at the root level only or at every level.
- **Claude Code's `@path` imports** are always-loaded content reachable only by parsing the importing file. `InstructionEntry.kind: "import"` covers the shape, but I have not checked whether `.claude/rules/*.md` files may themselves `@import`, which decides whether `instructionChain` needs a fixpoint.
- **The lint selector for harness names will fire on legitimate strings** — `"codex"` appears in messages, in `init`'s plan, and in the aliases map. The file set must exclude `setup-plan.ts` and the alias table, or the rule will be disabled within a day (the repo's own `lint-rule-calibration` warning). I have not enumerated the false positives.
- **Duplicate detection in the array form** relies on a runtime assertion; I did not check whether a type-level `NoDuplicates<T>` is cheap enough to prefer. It is likely not worth it.
- **Whether `scanFiles`'s default parameters are relied on by anyone outside `site/`.** `scanFiles` is exported from `dist/scan-files.js`, which is not in `package.json#exports`, so it should be internal; I did not confirm no consumer deep-imports it.
- **The count of 21 assumes the grep pattern is complete.** It does not catch `switch (adapter.name)`, `name.startsWith("claude")`, or a name stored into a variable before comparison. A follow-up with `ast-grep` over `BinaryExpression` whose right side is a literal in the harness-name set would be the honest census; the rule in §7 (ii) is that census, made permanent.

The scratchpad experiment (`/tmp/claude-0/…/scratchpad/tsx/`): `annotated.ts` (`: Adapter`), `satisfies-only.ts`, `const-satisfies.ts`, `registry.ts`, `consumer.ts`, compiled with this repo's `typescript` under `strict`/`Node16`. Result: only `as const satisfies` preserved the literal; the `@ts-expect-error` on the plain-`satisfies` probe was reported unused (TS2578), which is the compiler saying the widening happened; `consumer.js` emitted no `require`.
