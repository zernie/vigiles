# #263 second half — the four name-checks, the boolean trap, and #261

> Design pass run 2026-09-22 against branch `claude/port-redesign` @ `2426ec0`.
> Verbatim report. The probes it cites are beside it in
> `probes/names-half-2026-09-22/`; `tsc` is this repo's 5.9.3 with
> `--strict --module node16 --moduleResolution node16 --target es2022`.
>
> 🔴 This SUPERSEDES §1 of `port-redesign-round-2-2026-09-21.md`
> (`SkillFiringPorts` / `AdoptabilityPorts` / `AdvisoryPorts` /
> `skillSelectionEvent` / `runtime.modelAvailability`).

## 0. Verdict in one paragraph

The worry is right, and the tree already contains the design it warns against: `docs/design/port-redesign-round-2-2026-09-21.md` §1 proposes `skillSelectionEvent: boolean` on the base plus three new discriminated unions (`SkillFiringPorts`, `AdoptabilityPorts`, `AdvisoryPorts`) and a `runtime.modelAvailability(env)` — five new flags for four questions, giving the 32-member intersection the doc itself calls a cost. Measured against the redesign's own principle ("a fact stored in more than one place, and nothing relates the copies" — that doc §0), **three of the five are second copies**: `skillFiring` is `true` exactly when `harnessTesting` is on all three implementations; `skillSelectionEvent: false` restates `EvalDriver.experimental !== undefined` (`src/adapters/codex/eval.ts:271`); and `adoptability: false` on Codex restates _nobody wired the runner_, a TODO with no vendor referent. Probe P3 shows the type cannot relate any of them to the ports that would make them true — a Codex-shaped adapter carrying the eval driver the drafter is built from **and** `adoptability: false` compiles clean. The shape that survives the discriminator is smaller: **one thunk in the arm that already exists** (`liveDriver`, in `harnessTesting: true`) carrying two tagged unions (`access`, `firing`); **one deletion** (the adoptability gate — the feature-gating was the defect, exactly as suspected of the 8500/8775 pair); **one required base method** with no flag behind it (`advisories(read)`); and **one name-check that stays, named** (7582). After it, `adapter.name ===` occurs once in `src/` outside onboarding, `ProbeHarness` and `hasModelAccess` are gone from the composition root, and the ratchet is the existing list-bearing lint rule widened to two files with a measured false-positive count of zero. The name stays a string; P1 shows an object identity would move the comparison one member deeper rather than remove it. `rulesDir` stays, name and all — #261's second bullet is already done on this branch and its first is answered by a measurement about who enumerates, not by a rename.

## 1. The discriminator — what makes a capability legitimate vs a relocated name-check

The obvious move (`dialectCatalog: boolean`, `adoptabilityPreview: boolean`, …) fails for a reason the type can show. Three tests, all mechanical; a field must pass all three:

| test                                                                                                                                                                          | legitimate capability                                                                                         | relocated name-check                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1 — one copy.** Is the value DERIVABLE from a port the adapter already carries for another reason, or from a vendor fact with a referent outside vigiles?                  | derived or vendor-anchored; cannot disagree with the ports                                                    | a free choice the author can set either way — P3: `{harnessTesting:true, evalDriver, adoptability:false}` compiles; so does `{harnessTesting:false, adoptability:true, adoptabilityDrafter}`. The type accepted both directions of nonsense, so the flag carries a second copy of a fact the ports already hold |
| **T2 — the body under the branch.** After `if (adapter.cap)`, does the consumer call **the adapter** (a port) or **a harness by name** (`checkDialectDrift()`, `spawnAgent`)? | the branch disappears: `for (line of adapter.advisories(read))`                                               | the boolean is `true ⇔ name === X`, and the code under it is still X's — the name wearing a type                                                                                                                                                                                                                |
| **T3 — writable by a stranger.** Could a third-party adapter author fill it from their vendor's docs without reading `cli-main.ts`?                                           | "return diagnostics about your harness's local install", "how does a skill's firing show in your trace" — yes | "may the audit print the adoptability preview for you" — no; the answer lives in our CLI, not their vendor                                                                                                                                                                                                      |

Applied to the round-2 doc's five: `modelAvailability` passes (it is a query on the runner both adapters carry — keep, rehomed); `SkillFiringPorts.skillFiring` fails T1 (equals `harnessTesting` everywhere); `skillSelectionEvent` fails T1 (equals `experimental === undefined`); `AdoptabilityPorts.adoptability` fails all three; `AdvisoryPorts.localAdvisories` fails T1 in the weak sense `subagents` already argued at `src/core/adapter.ts:56-57` — _"No port sits behind it, so it stays a plain flag rather than a discriminant of a union with nothing in its arms"_ — here even the flag is redundant because `[]` is a legal answer.

Probe P3 (`p3-boolean-copy.ts`, tsc RC 0 — **no error, which is the finding**): both `codexLike` and `nonsense` type-check under `as const satisfies Adapter`.

## 2. The four questions

### Q4 — "can we reach a model" (`cli-main.ts:8524, 8730`, plus `8749` and `triggerCostWording` at `8058-8067`)

What it asks: is the live eval runner usable right now, and on whose bill. Both adapters ALREADY answer it, in `buildProbe` (`scan-behavioral.ts:113-131`): Codex → `codexDriver.available()` (spawns `codex --version`, `adapters/codex/driver.ts:62-72`); Claude Code → `claudeAvailable` (`harness-test.ts:494`, spawns `claude --version`). `cli-main.ts` then duplicates the Codex half as `adapter.name === "codex"` and the Claude half as `hasModelAccess(process.env)` — a function whose whole body is Claude Code env vars (`scan-trigger-suggest.ts:16-34`: `ANTHROPIC_API_KEY`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`) sitting in a module named for the harness-agnostic read-vs-run decision. Passes T1 (derivable from the runner), so it is a **port query, not a flag**:

`access(env): ModelAccess` on the live driver, a tagged union (`none | subscription | metered`, with `fix` on `none`). It absorbs six sites: 8524, 8730, 8749, 8060 (`triggerCostWording`'s name branch), and the two literal strings _"authenticate the `claude` CLI or set ANTHROPIC_API_KEY"_ at 8733 and 8766, which today print regardless of harness. Claude Code implements it env-only (as `hasModelAccess` does — no spent token); Codex returns `subscription` when the binary is present, matching today's wording at 8061 (_"your Codex CLI, $0 metered"_), and the docblock says it cannot tell key from ChatGPT auth without a run. `hasModelAccess`/`isMeteredAccess` move to `src/adapters/claude-code/` and `scan-trigger-suggest.ts` stops mentioning `ANTHROPIC_`.

Why on the live driver and **not** `HarnessRuntime` (where the round-2 doc put it): `HarnessRuntime` is the mock-transport port — every field is how to reach a MOCK (`modelBaseUrlEnv`, `mockApiKey`, `wireMock`, `src/core/runtime.ts:13-38`). Real-model reachability is the live tier's fact, and the live tier's `available()` already lives beside the eval driver in `HarnessProbe`.

### Q1 — `ProbeHarness` (`cli-main.ts:123, 5822-5823, 7898-7899`; `scan-behavioral.ts:51, 113-131, 600, 1037`)

`buildProbe(dir, harness)` IS a port keyed by name: four members (`evalDriver`, `firedFor`, `stub`, `available`) per harness, already typed as `HarnessProbe` (`scan-behavioral.ts:106-111`). Passes T1/T2/T3 as a **port**, fails them as a boolean. Construction: the thunk becomes `liveDriver: () => Promise<HarnessLiveDriver>` **inside the existing `harnessTesting: true` arm** — no new discriminant. Evidence it belongs there: `AdapterCapabilities.harnessTesting`'s own docblock claims _"deterministic harness tests + evals"_ (`core/adapter.ts:37`); on all three implementations live-eval ⇔ mock-testable (CC: `claudeEvalDriver` `eval.ts:2349`; Codex: `codexEvalDriver` `codex/eval.ts:263`; opencode: neither, `harnessTesting: false`). A separate `skillFiring` flag would be the A6 mirror — `true` beside a driver nothing ties it to.

`scan-behavioral.ts:600/1037` ("selection-collision is Claude Code only — no skill-selection event") is a fact about the TRACE, already carried as `EvalDriver.experimental` (`eval.ts:2324-2333`; Codex sets it at `codex/eval.ts:271`, the header at `:21-28` gives the vendor reason: no Skill-tool event, firing inferred from a `SKILL.md` read). Construction: `firing: { kind: "event" } | { kind: "inferred"; caveat }` on the live driver, and `measurePluginSelectionWith` / `measureGateAdversarialWith` take `EventFiringDriver` only. Probe P2 (RC 2, the one error is the expected TS2345 on passing an inferred driver; the `@ts-expect-error`s on the opencode-class shapes both fired, i.e. `harnessTesting: true` without `liveDriver` and `liveDriver` beside `false` are both unwritable):

```
p2-live-driver.ts(41,52): error TS2345: Argument of type 'HarnessLiveDriver' is not assignable to parameter of type 'EventFiringDriver'.
        Type '{ readonly kind: "inferred"; readonly caveat: string; }' is not assignable to type '{ readonly kind: "event"; }'.
```

Line 41 is the **positive** case `if (live.firing.kind === "event") measureSelection(live)` — TypeScript narrows `live.firing`, not `live`. P2b (RC 0) settles the construction: a type guard `isEventFiring(d): d is EventFiringDriver` narrows the driver itself; the negative arm still reaches `caveat` for the n/a note. Ship the guard in core beside the type.

`ProbeHarness` is then deleted; `ProbeOptions.harness` → `adapter`. One public-API cost: `SelectionOptions` (which carries `harness?: ProbeHarness`, `scan-behavioral.ts:365`) is exported from `vigiles/claude-code` (`src/claude-code.ts:58-63`). Keep `harness` one release, `@deprecated`, resolved through `getAdapter(name)` — the one sanctioned string→adapter conversion — then drop in the next major.

### Q3 — the adoptability pair (`cli-main.ts:8500` and `8775`) — **the gate is the defect; delete it**

The two branches state one fact in opposite directions: 8500 computes `adoptableRefs` only for Claude Code; 8775 prints _"adoptability preview … is Claude Code only for now — Codex support is a follow-up"_ only for Codex. Why is it CC-only? `ExecutableSurfaces.adoptableRefs`'s comment: _"drafting drives the `claude` CLI"_ (`cli-main.ts:7980-7983`). Read `defaultDraft` (`adoptability.ts:190-208`): `runner = opts.runner ?? spawnAgent`, `parse = opts.parse ?? parseClaudeRun` — those two are precisely the two members of `claudeEvalDriver` (`eval.ts:2349-2352`). The drafter is `evalDriver.parse(await evalDriver.runner({task: draftPrompt(content), …})).output → parseDraftJson`, and nothing else in it is harness-specific: the prompt is over an instruction file's prose and `AGENTS.md` is prose. The Codex side already exists: `codexEvalAgentRunner` (`codex/eval.ts:230-240`) takes the same `AgentRunArgs`, `parseCodexEvalRun` yields `.output` (`codex/eval.ts:133`). The one apparent snag — `model: "sonnet"` at `adoptability.ts:200` is a Claude alias — is already established practice: the trigger tier passes `opts.model ?? "sonnet"` to whichever runner (`scan-behavioral.ts:562`) and the Codex runner ignores `model` (`codex/eval.ts:234-238` forwards only `task/cwd/timeoutMs`).

So: `adoptableRefs = existsSync(resolve(root, adapter.layout.instructionFile))` for every adapter; `draft: draftWith((await adapter.liveDriver()).evalDriver)`; the reachability check at 8749 becomes `access.kind !== "none"`. **Both 8500 and 8775 die, and the "follow-up" note dies with them because Codex is not a follow-up.** What the number means on Codex: the verifier is deterministic and harness-free (`adoptability.ts:7-14`, _"LLM proposes, deterministic disposes"_), so "M broken right now" is exactly as trustworthy as on Claude Code; only the draft's recall varies by model, which it already does across Claude models. `AdoptabilityPorts` in the round-2 doc would have frozen a TODO into the type.

### Q2 — the Claude Code install checks (`cli-main.ts:8460`)

`checkDialectDrift()` reads the user's installed `@anthropic-ai/claude-code` (`dialect-drift.ts:155, 226-260`) and `checkSkillReachability(root)` reads `~/.claude/plugins/installed_plugins.json`, `.claude/skills`, `.claude/settings.json`, `node_modules/vigiles/skills`, `package.json` (`skill-reachability.ts:184-212`). Both are "is what vigiles assumes about THIS harness's install true on this machine", both are advisory-never-scored (the site's own comment, 8470), and both would be _wrong_ if run on a Codex repo (a `claude plugin install` fix line for a Codex user). So the gate is real, the value is not a choice, the consumer prints uniformly, and a stranger can implement it (T1–T3 pass) — a **required base method, no flag**: `advisories(read): readonly string[]`, `[]` legal. The two modules move under `src/adapters/claude-code/` (they are CC code by content — `dialect-drift.ts` even names the npm package). The discovery bound: `detect` was changed to take `exists` precisely so an adapter cannot enumerate a repo (`core/adapter.ts:83-99`); handing `advisories` a `root` would reopen that. The round-2 doc's `ClaimedReader` answers it and I keep the idea, trimmed: `repo(p)` serves only paths `adapter.claims(p)` covers, `home(p)` serves the home dir, and the two unclaimed reads become injected facts — `repoDependsOnVigiles` (from `package.json`) and `vendoredSkillNames` (from `node_modules/vigiles/skills`, `skill-reachability.ts:210-212`). Its §10.10 offers to leave the branch instead; I don't take that — after Q1/Q3/Q4 it would be one of two survivors, and this one has a clean port.

### The eighth site the brief did not list — `cli-main.ts:7582` `adapter.name !== "claude-code"` — **stays**

_"react output is confirmed only for Claude Code"_ (7590-7594): a per-channel MEASUREMENT status, and the right home is the event-capability table (`EventCapability` carries `carries/honours/matcher/denyShape` and no verified-status column, per round 1 §2 #3). That is the table owner's change, not this port's. It stays as the one sanctioned application-layer name-check, with a disable naming this reason — and after the design it is the **only** `adapter.name ===` in `src/` outside `init`.

## 3. The final TypeScript

**Stage-0 prerequisite (not optional):** `EvalDriver`, `AgentRunner`, `AgentRunArgs`, `RunOut`, `ParsedModelRun`, `ModelOutputParser` are declared in `src/eval.ts` (`:340, 348, 386, 1089, 1097, 2312`) and `Trace` in `src/harness-test.ts:159`. A core port cannot import either (`boundaries/dependencies`: core imports core). Move the TYPES to `src/core/eval-driver.ts`, exactly as `src/core/harness-driver.ts` did for `HarnessTestDriver` (_"the shared trace shapes live here in core so BOTH the adapters and the runner can reference them without a cross-adapter import"_, `harness-driver.ts:13-16`). `claudeEvalDriver` and `claudeCodeDriver` stay where they are (composition-root defaults, `eval.ts:2336-2348` explains the cycle); the thunk imports them, as `harnessTestDriver` already does at `adapters/claude-code/adapter.ts:34-35`.

```ts
// ───────────── src/core/live-driver.ts (new; imports only ./eval-driver.js) ─────────────

/**
 * Whether a REAL model is reachable for the executing tiers, and on whose bill.
 * A tagged union rather than a boolean because the CLI acts on all three arms
 * differently: it skips on `none` (printing `fix`), runs on the other two, and
 * words the consent prompt "spends API credits" only on `metered`.
 *
 * WHAT THIS REPLACES: `adapter.name === "codex" || hasModelAccess(process.env)`
 * (cli-main 8524, 8730), `hasModelAccess` alone (8749), `triggerCostWording`'s
 * name branch (8060), and two literal "authenticate the `claude` CLI or set
 * ANTHROPIC_API_KEY" strings (8733, 8766) that printed for every harness.
 */
export type ModelAccess =
  | {
      readonly kind: "none";
      /** One line: what is missing, in this harness's words. */ readonly fix: string;
    }
  | { readonly kind: "subscription" }
  | { readonly kind: "metered" };

/**
 * How a skill's FIRING shows up in this harness's eval trace.
 *
 * `event`: a discrete skill-selection record (Claude Code's `Skill` tool_use),
 * which the selection-collision matrix and the adversarial gate REQUIRE — they
 * ask "which skill fired", and an inference cannot answer that. `inferred`: no
 * such record; firing is deduced (Codex: the model READ `skills/<name>/SKILL.md`,
 * wrong in both directions — `adapters/codex/eval.ts:21-28`). `caveat` is the
 * sentence the report prints above an inferred number.
 *
 * The same fact as `EvalDriver.experimental` (a public field on `vigiles/codex`,
 * kept for compatibility); the contract test asserts the two agree.
 */
export type SkillFiringSignal =
  | { readonly kind: "event" }
  | { readonly kind: "inferred"; readonly caveat: string };

/**
 * How vigiles drives THIS harness against a REAL model on the user's own
 * credentials — the executing tiers' driver, as `HarnessTestDriver` is the
 * MOCK tiers'. It is what `scan-behavioral.ts:buildProbe` built by switching on
 * a name; the switch is gone because each adapter now brings the object.
 *
 * Lives in the `harnessTesting: true` arm of the adapter, not behind a flag of
 * its own: on every implementation live-eval ⇔ mock-testable, and a second flag
 * equal to the first everywhere is the A6 defect. If a harness ever goes live
 * without going mockable (a closed CLI with its own model), split the arm then.
 */
export interface HarnessLiveDriver {
  /** The runner + parser that spawn the real binary (`claudeEvalDriver`, `codexEvalDriver`). */
  readonly evalDriver: EvalDriver;
  /** See {@link ModelAccess}. Read from `env` where the harness allows it (Claude Code:
   *  env-only, never a spent token); a binary probe where it does not (Codex: `--version`). */
  access(env: Readonly<Record<string, string | undefined>>): ModelAccess;
  /** See {@link SkillFiringSignal}. */
  readonly firing: SkillFiringSignal;
  /**
   * The predicate "did `skill` fire" over one trace. `plugin.name` is the manifest
   * name the DOMAIN read (Claude Code namespaces a plugin's skill as
   * `<plugin>:<skill>`); handed in so this method reads no disk.
   */
  firedFor(
    skill: string,
    plugin: { readonly name: string | null },
  ): (t: Trace) => boolean;
  /**
   * Whether the probe may rebuild the plugin to skills-only STUBS before measuring.
   * `false` = the real bodies are installed (Codex: stubbing a non-Claude plugin is
   * unvalidated — a measured limitation, not a capability, and the docblock says so).
   */
  readonly installsStubs: boolean;
}

/** The only accepted argument for selection-collision and the adversarial gate. */
export type EventFiringDriver = HarnessLiveDriver & {
  readonly firing: { readonly kind: "event" };
};

/** Narrows the DRIVER, which `d.firing.kind === "event"` does not (probe P2/P2b). */
export function isEventFiring(d: HarnessLiveDriver): d is EventFiringDriver {
  return d.firing.kind === "event";
}

// ───────────── src/core/adapter.ts (changes only) ─────────────

/**
 * What `advisories` may read. A reader the DOMAIN builds, for the reason
 * `detect(exists)` takes a predicate and not a root: an adapter handed `root`
 * could enumerate anything under it. `repo` answers only for paths this
 * adapter `claims`; the two facts are what the shipped checks read from
 * UNCLAIMED files (`package.json`, `node_modules/vigiles/skills`).
 */
export interface InstallReader {
  readonly repo: (repoRelative: string) => string | null;
  readonly home: (homeRelative: string) => string | null;
  readonly repoDependsOnVigiles: boolean;
  readonly vendoredSkillNames: readonly string[];
}

interface AdapterBase {
  // …unchanged…
  /**
   * Diagnostics about THIS harness's install on this machine that bear on how far
   * the report can be trusted — never scored, printed as-is. Claude Code returns
   * the dialect-drift warning (our hand-maintained catalog vs the installed
   * `@anthropic-ai/claude-code`) and the plugin-reachability warning (vigiles's
   * skills present in `node_modules` and unreachable). `[]` is the honest answer
   * for a harness with nothing to say, which is why this is required and not a
   * flag: a flag with nothing behind it is the `subagents` argument again.
   */
  advisories(read: InstallReader): readonly string[];
}

type TestingPorts =
  | {
      readonly harnessTesting: true;
      readonly runtime: HarnessRuntime;
      readonly modelMock: ModelMock;
      readonly harnessTestDriver: () => Promise<HarnessTestDriver>;
      /** The executing tiers' driver; a thunk for the same load-cost reason as the
       *  line above (`adapter.ts:87-108`). See {@link HarnessLiveDriver}. */
      readonly liveDriver: () => Promise<HarnessLiveDriver>;
    }
  | {
      readonly harnessTesting: false;
      readonly runtime?: never;
      readonly modelMock?: never;
      readonly harnessTestDriver?: never;
      readonly liveDriver?: never;
    };
// HarnessAdapter = AdapterBase & TestingPorts & ShellHookPorts — unchanged arity.
```

Deleted: `ProbeHarness` (`scan-behavioral.ts:51`), `buildProbe` (`:113-131`), `pluginName` (`:133-143`, the `.claude-plugin` literal — the domain reads `layout.manifestPath`), `ExecutableSurfaces.adoptableRefs`'s CC comment, `hasModelAccess`/`isMeteredAccess` from `scan-trigger-suggest.ts` (moved), the `AdoptabilityPorts`/`SkillFiringPorts`/`AdvisoryPorts`/`skillSelectionEvent` proposals from the round-2 doc.

## 4. Ratchets — per question, the file, and why that file

| what must not come back                                                                                                     | held by                                                                                                                                                                                        | where, and why there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a harness name literal in the two application files that held 15 of the 21                                                  | **lint**, the existing `local/no-harness-names` (names read from `readdirSync("src/adapters")`, `eslint.config.mjs:30-33`), file set widened by `src/scan-behavioral.ts` and `src/cli-main.ts` | `eslint.config.mjs:319-327`. Measured on this tree: after the design `scan-behavioral.ts` has **0** hits (its 9 literal lines — `:51, 91, 114, 295, 364, 599-600, 1036-1037` — are all inside what moves); `cli-main.ts` has **5**, all enumerable: `3468, 4141, 4290, 4325` (`init` onboarding — the composition root's UI, exempt by the header at `eslint.config.mjs:79-85`) and `7582` (§2). Comments are not AST nodes (the 10 backtick mentions at 2045…6270 are all `//`/`*` lines), so zero template-literal findings. Five disables at introduction is under the rule's own precedent of eleven                                                  |
| why NOT the list-free selector as the ratchet (round-2 doc §3 last row)                                                     | —                                                                                                                                                                                              | measured with `selector.config.mjs` (`no-restricted-syntax`, `@typescript-eslint/parser`) over `src/**/*.ts` non-test: `adapter.name ===/!== <Literal>` → **8**, all in `cli-main.ts` (5823, 7582, 7899, 8460, 8500, 8524, 8730, 8775); `harness ===/!== <Literal>` → **8**, of which **2 are `""`** (`adapter-registry.ts:198`, `cli-main.ts:3540`) — false positives at `error` level, exactly the class constraint 3 forbids; bare `.name === <Literal>` → **19** (tool names `"Skill"`, `pkg.name === "vigiles"`), unusable. The list-bearing rule cannot match `""`; the selector can. Keep the selector as the census command, not the gate         |
| `liveDriver` absent on a testable adapter / present on an untestable one                                                    | **type**                                                                                                                                                                                       | `src/core/adapter.ts` — P2: both shapes are TS2322 under `as const satisfies`; conformance keeps a worded check for non-TS adapters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `firing` disagreeing with `EvalDriver.experimental`; `access()` returning outside the union; a driver that does not resolve | **test**                                                                                                                                                                                       | `src/adapter-contract.test.ts` — for every `harnessTesting` adapter in `ADAPTERS` + `PROTOTYPES`: `const d = await a.liveDriver()`; `expect(d.firing.kind === "inferred").toBe(d.evalDriver.experimental !== undefined)`; `expect(["none","subscription","metered"]).toContain(d.access({}).kind)`. **Why this file and not the core:** the assertion ranges over the registry, and the core may not import the registry (`src/core/CLAUDE.md`, the same reason `DEFAULT_INSTRUCTION_TARGETS` is pinned here at `:186-219`); `boundaries/dependencies` would stay green on a violation because `adapter-registry.ts` is the unclassified composition root |
| an inferred-firing driver reaching selection-collision                                                                      | **type**                                                                                                                                                                                       | `src/scan-behavioral.ts` — `measurePluginSelectionWith(dir, set, probe: EventFiringDriver)`; P2 TS2345                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| the adoptability gate returning by name                                                                                     | **test, real binary**                                                                                                                                                                          | `src/scan-cli.test.ts`, beside `#240` at `:308` (same shape: a real repo through `dist/cli.js`): a Codex fixture (`AGENTS.md` + `.codex/config.toml`) run `--no-interactive --json` → stdout must not match `/Claude Code only/` and the report's consent-eligibility must include the instruction file. Plus the `ANTHROPIC_` literal boundary: add `src/scan-trigger-suggest.ts` to `HARNESS_AGNOSTIC_DETECTORS` (`eslint.config.mjs:86-91`) — post-move it holds 0 `ANTHROPIC_` tokens, so `hasModelAccess` cannot be re-declared there                                                                                                                |
| `advisories` reading unclaimed repo paths                                                                                   | **test**                                                                                                                                                                                       | `src/adapter-properties.test.ts` — the property `detect` already has (`core/adapter.ts:95-99`): a recording `InstallReader`; every `repo(p)` request satisfies `adapter.claims(p)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ProbeHarness` returning as a hand union                                                                                    | **type + the widened lint**                                                                                                                                                                    | `HarnessName` (`adapter-registry.ts:65`) is the only union; a new `"claude-code" \| "codex"` alias in `scan-behavioral.ts` is now a lint error in TYPE position (the rule visits `TSLiteralType`, `no-harness-names.mjs` header)                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 5. #261 — `rulesDir`: stays, name and all

**Does it fold into `surfaces` as a `SurfaceKind`?** No, and the branch already counted why: `core/layout.ts:19-26` — five of the seven consumers ranging over surfaces would grow a `kind !== "rules"` branch (empty-machine decision, per-kind counts, shape table, known-homes map, `executableSourceDirs`), and `plugin-loader.ts:487-493` states the semantic split: surfaces decide whether a directory is a LOADABLE MACHINE; rules are read, not invoked. A record key would be the per-value branch the record exists to remove.

**Is it named after Claude Code's shape?** No — round 1 §3.3 and `core/instruction-chain.ts:203-207`: `rules` is the name Claude Code (`.claude/rules`), Cursor (`.cursor/rules`) and Windsurf (`.windsurf/rules`) all use; the dot-directory is the variable. Three vendors make it the shape's name.

**What makes Codex's path-scoped instructions expressible, then?** They already are at the level the port owns, and are not at the level the port refuses — and the refusal is a measurement, not an oversight:

- _Classification_: `codexInstructionChain` returns a nested `AGENTS.md` as `{kind:"on-demand", when:"subdirectory"}` (`adapters/codex/instruction-chain.ts:132`), the exact counterpart of Claude Code's `{kind:"on-demand", when:"path-scoped"}` for a `paths:`-scoped rule (`adapters/claude-code/instruction-chain.ts:461-475`). Both physical forms have a role and a reason today.
- _Discovery_: the two forms differ on the axis a layout FIELD encodes. `rulesDir` is a location under a dot-directory, which the domain enumerates inside its bound (`INSTRUCTION_SHAPES`, `instruction-chain.ts:214-223`, "dot-directory rules tree"). Codex's form is a location PATTERN over the whole tree — `**/AGENTS.md` — which is the glob `alwaysLoaded` shipped and the redesign removed for a reason with a number on it (#240: 53 vendored skills beside 37 real ones; `codex/layout.ts:24-45`). A single field that expressed both would have to be a pattern, and a pattern field is the adapter driving the walk. So the abstraction that covers both is wrong not because of its name but because of **who enumerates**; what replaces it is what the branch has: a bounded location field for the dot-directory shape, plus a chain method that classifies any nested file it is handed.

**The second "done when" bullet — `AGENTS.override.md` — is done on this branch:** `overrideSiblingOf` (`codex/instruction-chain.ts:37-39`), the override enters as `role: "root-local", scope: "local"` (`:84-89`), and the committed file it displaces carries `reason: {kind:"replaced", by: …}` (`:114`); covered in `adapters/codex/instruction-chain.test.ts`, `core/instruction-chain.test.ts` and `adapter-properties.test.ts` (grep `AGENTS.override.md`). The third bullet (a real-binary `scan-cli.test.ts` case) is not yet there — `grep -n override src/scan-cli.test.ts` finds only `--harness` overrides — and is the one thing #261 still needs. Suggested close: #261 closes with the paragraph above, an `.override` fixture added beside `#240`, and the nested-`AGENTS.md` gap referred to `codex/layout.ts:24-45` where it is already recorded as a deliberate trade.

## 6. What this deliberately does not fix

- **`cli-main.ts:7582`** — stays as a name-check with a disable (§2). The fix is a `verified` column on `EventCapability`, owned by the capability table, not this port.
- **`init` / `setup-plan.ts:450, 471` and `cli-main.ts:3468, 4141, 4290, 4325`** — onboarding installs vigiles's own plugin into a named harness; the composition root's UI, exempt by the existing header. Four disables, not a redesign.
- **Live-without-mock harnesses.** Folding `liveDriver` into `harnessTesting: true` makes "can go live, cannot be mocked" inexpressible. Zero implementations have that shape; splitting the arm is mechanical when one does (the rule-of-three the round-2 doc invokes at §10.9).
- **`EvalDriver.experimental` stays** as a public duplicate of `firing` — `codexEvalDriver` is exported from `vigiles/codex` and `measureTriggerRate` copies the field onto reports. Related by a contract assertion, not removed; removal is a major.
- **`SelectionOptions.harness`** on `vigiles/claude-code` — deprecated one release, not deleted.
- **`installsStubs: false` on Codex** encodes an unvalidated measurement, not a capability; it is on the port because the alternative was `probe.stub` keyed by name. The docblock says which it is.
- **`advisories` reading `~`** — the reader serves the home dir because `installed_plugins.json` lives there; that is a read of the machine, never of the repo, and it is advisory-only. If the owner wants no `~` reads at all, `home` goes and the reachability check loses its global-install source (it would then misreport a correctly installed plugin — the exact misread its header at `skill-reachability.ts:22-29` warns about).
- **The name stays a string.** P1 (RC 0): a `class HarnessId` makes `a.id === "codex"` TS2367 while `String(a.id)`, `JSON.stringify`, template strings and the registry lookup all compile — **and `a.id.value === "codex"` compiles too.** The comparison moves one member deeper; it does not go away. Not worth `--harness=`/report/config churn for a lint the rule already gives.
- **Nested `AGENTS.md` discovery** — #240's bound, `codex/layout.ts:24-45`, not this issue.

## 7. Migration order that stays green (each step builds and passes `check`)

1. Move the eval/trace TYPES to `src/core/eval-driver.ts`; re-export from `eval.ts`/`harness-test.ts` (no behaviour change). 2. Add `src/core/live-driver.ts`; add `liveDriver` to the `true` arm; implement on both adapters as thunks (`claudeCodeLiveDriver` assembled in `eval.ts`/`harness-test.ts` beside `claudeCodeDriver`; `codexLiveDriver` in `adapters/codex/`), `opencode` untouched (`false` arm). Contract assertions land here. 3. `scan-behavioral.ts`: `probeFor(adapter)` replaces `buildProbe`; `EventFiringDriver` on the two CC-only measurements; delete `ProbeHarness`, deprecate `SelectionOptions.harness`. 4. `cli-main.ts`: 5823/7899 → `adapter`; 8524/8730/8749/8060 + the two strings → `access`; 8500/8775 → deleted, drafter takes `evalDriver`; `hasModelAccess` moves. 5. `advisories` + `InstallReader`; move `dialect-drift.ts`/`skill-reachability.ts` under `adapters/claude-code/`; 8460 → `for (const l of adapter.advisories(read))`. 6. Widen the two lint scopes; add the five disables; add the `scan-cli.test.ts` Codex fixture. Round-2 doc §1 (`SkillFiringPorts`/`AdoptabilityPorts`/`AdvisoryPorts`/`skillSelectionEvent`/`runtime.modelAvailability`) is superseded by this and should say so in place, the way `fbae51c` marked its migration table stale.

## 8. Where this may be wrong

1. `access()` for Codex spawns `codex --version` where `hasModelAccess` never spawned; at 8524 it is evaluated once per audit before consent — same cost as today's `codexDriver.available()` inside the probe, but earlier. If that matters, Codex's `access` can return `subscription` unconditionally and let the run self-report, which is what the Codex path effectively does today.
2. The claim "the drafter has nothing else CC-specific" rests on reading `adoptability.ts:150-208` and `draftPrompt`; I did not run a Codex draft. The `scan-cli.test.ts` fixture in §4 is the check, and it needs a real `codex` on PATH to be more than a no-model no-op.
3. `vendoredSkillNames` as an injected fact assumes the domain is willing to `readdirSync(node_modules/vigiles/skills)` in `cli-main` — a read outside every bound, but of vigiles's own package. If not, the "stranded copies" sentence in the reachability warning goes.
4. The census selector counts `adapter.name` only when the receiver is literally named `adapter`; a renamed variable escapes it. The widened list-bearing rule does not have that hole (it matches the literal wherever it is), which is the other half of why it is the gate.
5. I did not run `npm run check` or vitest — only `tsc` on the probes and eslint with a scratch config. Every "0 findings post-fix" is counted from the sites listed, not measured on a modified tree.
