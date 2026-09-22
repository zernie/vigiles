/**
 * HarnessAdapter — the bundle that makes a harness a single, addable unit.
 *
 * Each port (HarnessDialect, PluginLayout, HarnessRuntime, HookProtocol,
 * ModelMock) decouples one axis of Claude-Code coupling. A `HarnessAdapter`
 * groups a harness's five port implementations plus a `detect` predicate, so
 * **adding a harness is writing one object** — `codexAdapter`, `geminiAdapter`,
 * `myHarnessAdapter` — not editing the core. The library stays import-named
 * (`import { claudeCodeAdapter } from "vigiles/claude-code"`); the bundle is the
 * thing the CLI auto-detects and the conformance kit checks.
 *
 * See `docs/authoring-an-adapter.md` (third-party guide) and
 * `research/code-adapter-architecture.md` (the design).
 */
import type { HarnessDialect } from "./dialect.js";
import type { PluginLayout } from "./layout.js";
import type { HarnessRuntime } from "./runtime.js";
import type { HookProtocol } from "./hook-protocol.js";
import type { ModelMock } from "./model-mock.js";
import type { HarnessTestDriver } from "./harness-driver.js";
import type { HarnessLiveDriver } from "./live-driver.js";

/**
 * Which vigiles pillars/tiers a harness can drive — the capability matrix made
 * executable (see `docs/harnesses.md`).
 *
 * 🔴 KEPT AS A TYPE, NOT AS A FIELD. The flags used to sit in a nested
 * `capabilities` object on the adapter, and that nesting is precisely what made
 * the illegal state below expressible: TypeScript narrows a union by a
 * discriminant on the object ITSELF, never by `a.capabilities.x`, so no shape
 * of this interface could have tied `harnessTesting: true` to the presence of a
 * driver. The flags are now discriminants on `HarnessAdapter` directly; this
 * interface remains as the documented projection of them.
 *
 * `referenceVerification` is gone. It was `true` on every adapter and its type
 * was the literal `true` — a field that can hold one value carries no
 * information, and the conformance check for it could not fail.
 */
export interface AdapterCapabilities {
  /**
   * Pillar 2 — deterministic harness tests + evals: the binary can be spawned
   * and pointed at a mock model. Requires `runtime` + `modelMock` +
   * `harnessTestDriver`. `false` for closed harnesses that route through a fixed
   * backend (no BYOM): Cursor, Devin, Amp, Amazon Q — pillar-1-only adapters.
   */
  readonly harnessTesting: boolean;
  /**
   * Hooks are shell processes speaking the exit-code/env block protocol —
   * Claude Code, Codex, Crush. Requires `hookProtocol`. `false` when hooks are
   * in-process code modules (OpenCode's TS plugins), so the `run-hook` unit
   * tier and the `HookProtocol` port do not apply.
   */
  readonly shellHooks: boolean;
  /**
   * The harness has **subagents** — a named, model-dispatched delegate with its
   * own tool contract and frontmatter (Claude Code's `agents/*.md`, OpenCode's
   * agent surface). Gates the subagent-surface lint rules (`subagent-tool-contract`,
   * `subagent-frontmatter`, `untested-subagent`, `mcp-tool-resolves`): where this
   * is `false` those rules report **n/a** rather than running. `false` for Codex,
   * whose `[agents]` TOML is a concurrency table, not a tool-contract file — a
   * wholly different concept that deliberately shares the word.
   *
   * No port sits behind it, so it stays a plain flag on the base rather than
   * becoming a discriminant of a union with nothing in its arms.
   */
  readonly subagents: boolean;
}

/**
 * How, and how strongly, a repo looks like this harness.
 *
 * `via` exists so the REGISTRY can break a tie without naming a harness. The
 * one false "both" tie is at the weak instruction-file level, where two
 * adapters match on mirrored root files; `via: "instruction-file"` is what
 * makes that case recognisable from the outside, and it used to be recognised
 * by comparing a winner's `name` against a literal in the registry.
 */
export interface DetectSignal {
  /** 0 = not this harness; higher = a more specific match. The registry picks
   *  the highest scorer, so a strong signal (a plugin manifest) beats a weak
   *  one (a shared `AGENTS.md`) regardless of registration order. */
  readonly specificity: number;
  /** WHICH kind of marker produced the score. */
  readonly via: "manifest" | "settings" | "instruction-file";
}

/**
 * The fields EVERY adapter has, whatever it can drive. The capability-gated
 * ports are deliberately NOT here — see the unions below.
 */
interface AdapterBase {
  /** Stable identifier, e.g. "claude-code". The CLI/registry key. */
  readonly name: string;
  /** Format axis: tool catalog, hook events, instruction targets, plugin-root token. */
  readonly dialect: HarnessDialect;
  /** Layout axis: where the instruction file / skills / agents / hooks live on disk. */
  readonly layout: PluginLayout;
  /** See {@link AdapterCapabilities.subagents}. */
  readonly subagents: boolean;
  /**
   * How strongly, and by WHAT, a repo looks like it targets this harness — the
   * CLI uses it to auto-detect which adapter to use (the library selects by
   * import).
   *
   * 🔴 IT TAKES A PREDICATE, NOT A ROOT, and that is the same rule `claims`
   * follows one docblock down. `detect(root: string)` handed every adapter a
   * directory and `node:fs`: an adapter could enumerate anything under it, so
   * registering an adapter COULD change what vigiles reads in someone's
   * repository — the exact inversion `claims` exists to prevent, sitting
   * unnoticed beside it. With `exists` injected, an adapter can ask about a
   * path and nothing else, and the domain decides what asking means. It also
   * removes `node:fs` from the adapter bundles.
   *
   * The property a test asserts (`adapter-properties.test.ts`): `detect` may
   * only ask about paths its own `claims` returns true for. An adapter that
   * wanted to detect by a marker it does not read would be refused by that,
   * which is the intended trade — a detector that reads what it does not claim
   * is how a grade starts covering files nobody declared.
   */
  detect(exists: (repoRelative: string) => boolean): DetectSignal;
  /**
   * Is this repo-relative path one THIS harness reads — "is it mine?"
   *
   * 🔴 THE POINT OF THIS METHOD IS WHAT IT CANNOT DO. It takes a path and
   * returns a boolean: no root, no filesystem, no enumeration. An adapter can
   * therefore LABEL a surface the domain already found and nothing else —
   * **registering a new adapter cannot make vigiles read more in anyone's
   * repository.** The rejected alternative was each adapter DECLARING roots for
   * the audit to walk, which inverts that: shipping a Cursor adapter would start
   * reading `.cursor/rules` in every user's repo, and a surface no adapter
   * declared would stay invisible. Discovery is the domain's job
   * (`core/surface-discovery.ts`); a claim is an adapter's. See
   * `research/audit-harness-dx.md` §9.
   *
   * The consequence the audit reports: a surface NO registered adapter claims is
   * a FINDING, not silence — measured on a real repo whose 37 skills under
   * `.ai/` graded A (100/100) precisely because nothing read them (#240).
   *
   * Every shipped adapter implements this as `layoutClaims(<its layout>, path)`,
   * so a layout that moves takes its claim with it and the two cannot drift.
   * Override it only for a location the `PluginLayout` fields cannot express.
   */
  claims(path: string): boolean;
  /**
   * Diagnostics about THIS harness's INSTALL on this machine that bear on how
   * far the report can be trusted — never scored, printed as-is, one string per
   * line. `[]` is the honest answer for a harness with nothing to say.
   *
   * 🔴 REQUIRED, NOT A CAPABILITY FLAG. A `localAdvisories: boolean` would be a
   * flag with nothing behind it — the argument {@link AdapterCapabilities.subagents}
   * already makes from the other side — because an empty array says exactly what
   * `false` would say, and cannot fall out of step with the method the way a
   * flag beside a port can.
   *
   * WHAT IT REPLACES: `if (adapter.name === "claude-code") { …two Claude Code
   * install checks… }` in the CLI. Those checks are real and they are genuinely
   * this harness's (one reads the installed vendor package, the other the
   * plugin install), and run against another harness's repo they would print a
   * fix line for a CLI that repo does not use. So the gate was right and its
   * SHAPE was wrong: the consumer now prints uniformly and the knowledge sits
   * with the adapter that has it.
   *
   * 🔴 IT TAKES A READER, NOT A ROOT — the same bound as `detect(exists)` one
   * docblock up, for the same reason: handed a root, an adapter could enumerate
   * anything in the repository, and registering an adapter would change what
   * vigiles reads. {@link InstallReader.repo} answers only for paths this
   * adapter `claims`, which `adapter-properties.test.ts` asserts.
   */
  advisories(read: InstallReader): readonly string[];
}

/**
 * What {@link AdapterBase.advisories} may read.
 *
 * Built by the DOMAIN and handed in, so the adapter holds no filesystem. The two
 * plain FACTS are here rather than as reads because the shipped checks need them
 * from files NO adapter claims (`package.json`, and vigiles's own package inside
 * `node_modules`) — an unclaimed read is exactly what the bound forbids, so the
 * domain reads them once and passes the answer.
 */
export interface InstallReader {
  /**
   * A repo file's contents, or null when it is missing, unreadable, or NOT a
   * path this adapter claims. A refusal and an absence are deliberately the same
   * answer: an adapter must not be able to probe for the existence of files
   * outside its own surface.
   */
  readonly repo: (repoRelative: string) => string | null;
  /**
   * A file under the user's HOME, or null. This is a read of the MACHINE, never
   * of the repository — the plugin-install record lives there — and everything
   * it feeds is advisory-only.
   */
  readonly home: (homeRelative: string) => string | null;
  /** Does this repo take a dependency on vigiles? (From `package.json`, unclaimed.) */
  readonly repoDependsOnVigiles: boolean;
  /** Skill names vigiles ships inside its own installed package, if it is installed. */
  readonly vendoredSkillNames: readonly string[];
}

/**
 * Pillar 2's three ports, present IFF `harnessTesting` — as a union, so
 * declaring the capability without the ports is a COMPILE error.
 *
 * 🔴 THE STATE THIS REMOVES WAS SHIPPING. `opencodeAdapter` declared
 * `harnessTesting: true` and carried no `harnessTestDriver`; the runner threw
 * at `harness-test.ts:782` — at RUN time, after a driver was asked for — and
 * the conformance kit did not catch it, because it checked `runtime` and
 * `modelMock` and not the thunk. Adding a third check would have been the
 * third place to remember. The union needs no check at all: the shape is
 * unwritable.
 *
 * The `?: never` arms matter as much as the `true` arm. Without them a
 * `false` adapter could still carry a driver, which is the same defect
 * pointing the other way — a port nothing will ever call, read by a reader as
 * capability that is not there.
 */
type TestingPorts =
  | {
      readonly harnessTesting: true;
      /** Transport axis: the agent binary to spawn + the mock-model env. */
      readonly runtime: HarnessRuntime;
      /** Transport axis: the mock model's wire format + endpoints. */
      readonly modelMock: ModelMock;
      /**
       * Pillar-2 deterministic-runner driver: how `runHarnessTest` builds this
       * harness's argv, starts its scripted mock, and parses its stdout.
       *
       * 🔴 A THUNK, NOT THE DRIVER, and the indirection is the whole point. A
       * driver lives in `harness-test.ts`, which imports the conformance suite,
       * which imports the compiler, which imports the cross-language symbol
       * index, which loads a NATIVE binary. Holding the driver eagerly meant
       * every consumer of an adapter paid for all of it — including the hook
       * runtime, which reads only `dialect` and `hookProtocol` and never runs a
       * harness test at all.
       *
       * Measured 2026-09-19, `require("./adapter-registry.js")`:
       *
       *     eager:  107 modules, 7 ast-grep, 1 native .node
       *
       * ...on a path whose actual work takes about a millisecond. Calling the
       * thunk is what loads the driver, so the test tier pays and the runtime
       * does not.
       *
       * ASYNC because a dynamic `import()` is the only form that defers in BOTH
       * environments this code runs in: the CJS `dist/` build (where TypeScript
       * lowers it to a deferred `require`) and vitest loading the TS sources
       * directly, where a synchronous `require` of a sibling `.ts` does not
       * resolve at all — measured, not assumed.
       */
      readonly harnessTestDriver: () => Promise<HarnessTestDriver>;
      /**
       * The EXECUTING tiers' driver: how vigiles drives this harness against a
       * REAL model on the user's own credentials — which eval transport, how
       * firing shows in the trace, whether a model is reachable and on whose
       * bill, and whether the probe may stub the skill bodies. See
       * {@link HarnessLiveDriver}.
       *
       * A THUNK, for the same measured load-cost reason as the line above: the
       * eval transport reaches the whole real-model graph, and an adapter is
       * read by the hook runtime, which never runs a model at all.
       *
       * 🔴 IN THIS ARM RATHER THAN BEHIND A FLAG OF ITS OWN. Every
       * implementation that can go live can also be mocked, and this
       * capability's own docblock already claims both tiers. A `liveEval:
       * boolean` beside it would be `true` exactly when `harnessTesting` is —
       * a second copy of one fact, which is the state this union exists to
       * make unwritable. The `?: never` below is the other half: a `false`
       * adapter cannot carry a live driver nothing will ever call.
       */
      readonly liveDriver: () => Promise<HarnessLiveDriver>;
    }
  | {
      readonly harnessTesting: false;
      readonly runtime?: never;
      readonly modelMock?: never;
      readonly harnessTestDriver?: never;
      readonly liveDriver?: never;
    };

/** The shell-hook port, present IFF `shellHooks`. Same construction, same reason. */
type ShellHookPorts =
  | {
      readonly shellHooks: true;
      /** Transport axis: how a hook signals a block/deny. */
      readonly hookProtocol: HookProtocol;
    }
  | { readonly shellHooks: false; readonly hookProtocol?: never };

/**
 * A harness, as one addable unit: the ports it implements plus the flags that
 * say which ones those are.
 *
 * ⚠️ THE COST, NAMED SO NOBODY IS SURPRISED BY IT: a wrong adapter literal
 * produces a TypeScript error against an INTERSECTION OF UNIONS, which reads
 * badly — it will list both arms of each union rather than say "you declared
 * harnessTesting and gave me no driver". That is why the conformance kit keeps
 * its per-flag messages: the TYPE is the gate, the KIT is the explanation.
 */
export type HarnessAdapter = AdapterBase & TestingPorts & ShellHookPorts;
