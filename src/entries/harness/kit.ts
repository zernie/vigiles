// 🔴 PUBLIC ENTRY POINT `vigiles/harness/kit` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-harness-kit.api.md`, which
// `npm run api:check` fails on.
/**
 * `vigiles/harness/kit` — the harness-adapter authoring kit.
 *
 * Everything you need to teach vigiles a new harness, in one import: the five
 * port interfaces to implement, the `HarnessAdapter` bundle that groups them,
 * the conformance kit to validate yours, and the driver ports the test and
 * eval runners call. vigiles ships a Claude Code adapter; building your own is welcome and
 * supported — see `docs/authoring-an-adapter.md`.
 *
 *   import {
 *     type HarnessAdapter, type HarnessDialect, type PluginLayout,
 *     type HarnessRuntime, type HookProtocol, type ModelMock,
 *     assertAdapterConformance,
 *   } from "vigiles/harness/kit";
 *
 *   export const myHarnessAdapter: HarnessAdapter = { name: "my-harness", … };
 */
export type {
  HarnessAdapter,
  AdapterCapabilities,
} from "../../core/adapter.js";
export type { HarnessDialect } from "../../core/dialect.js";
export type {
  PluginLayout,
  SkillDiscovery,
  SurfaceDirs,
  SurfaceKind,
} from "../../core/layout.js";
// `PluginLayout.outputStyles` is on the port, so an adapter author must be able
// to name its type and the request its `reached` reads.
export type {
  OutputStyle,
  OutputStyleRules,
  StyleSelection,
} from "../../core/output-style.js";
// `HarnessDialect.skillListing` is on the port too: an author implementing it
// names the rules and the one skill its `entry` reads.
export type {
  ListedSkill,
  ListingLimit,
  SkillListingBudget,
  SkillListingRules,
} from "../../core/skill-listing.js";
// The driver PORTS: what `harnessTestDriver()` returns (the free test tier)
// and what an eval driver supplies (the paid tiers). An adapter implements
// them, so their types live on this door.
export type { HarnessTestDriver } from "../../core/harness-driver.js";
export type {
  AgentRunArgs,
  AgentRunner,
  EvalDriver,
  ModelOutputParser,
  ParsedModelRun,
  RunOut,
} from "../../core/eval-driver.js";
// The derived readers. They are part of the port's surface, not helpers: an
// adapter author reads a layout through them, and they are what replaced the
// `surfaceDirs` / `intraRefDirs` FIELDS.
export { executableSourceDirs, surfaceDirs } from "../../core/layout.js";
/**
 * The instruction-chain vocabulary `PluginLayout.instructionChain` speaks.
 *
 * Exported because the method is on the port: without these an adapter author
 * cannot write a return type, which makes the interface unimplementable from
 * outside this package.
 */
export type {
  InstructionChain,
  InstructionRole,
  InstructionScope,
  LoadedInstruction,
  NamedImport,
  NotLoadedReason,
  PatternFrom,
  UnloadedInstruction,
} from "../../core/instruction-chain.js";
/**
 * ⚠️ `SettingsCodec` was in the same position and is exported here for the same
 * reason: `PluginLayout.settings` has been typed as one since the codec landed,
 * and the authoring barrel never re-exported it, so `docs/adapter-api.md`
 * documents a field whose type a third party could not name. One line, and the
 * alternative is a port that cannot be implemented from outside.
 */
export type { SettingsCodec } from "../../core/settings-codec.js";
export {
  jsonSettingsCodec,
  tomlSettingsCodec,
} from "../../core/settings-codec.js";
export type {
  ContainerImageDeclaration,
  HarnessRuntime,
  RequestCapture,
  RequestChannel,
  RunEnvPolicy,
} from "../../core/runtime.js";
export type { HarnessImageRecipe } from "../../core/container.js";
export type { HookProtocol } from "../../core/hook-protocol.js";
export type { ModelMock } from "../../core/model-mock.js";

/**
 * The `claims(path)` helper every shipped adapter uses: derive "is this path
 * mine?" from the adapter's own `PluginLayout`, so a layout that moves takes its
 * claim with it. Override `claims` by hand only for a location the layout fields
 * cannot express. See `core/surface-discovery.ts` for why a claim is a question
 * about a PATH and never about a root.
 */
export { layoutClaims } from "../../core/surface-discovery.js";

// The conformance kit: `assert*` throws naming every port that does not hold,
// `runAdapterConformance` returns the same findings for you to print.
export {
  runAdapterConformance,
  assertAdapterConformance,
  assertAdapterLoadsHooks,
  type ConformanceResult,
} from "../../adapter-conformance.js";
// The registry the CLI detects through (`ADAPTERS`, `detectAdapter`, …) is the
// CLI's composition root, not an authoring tool: an adapter is a value you pass
// (`runHarnessTest(spec, { adapter })`), so it is not exported.
