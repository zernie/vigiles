/**
 * `vigiles/adapter` — the harness-adapter authoring kit.
 *
 * Everything you need to teach vigiles a new harness, in one import: the five
 * port interfaces to implement, the `HarnessAdapter` bundle that groups them,
 * the conformance kit to validate yours, and the registry the CLI detects
 * through. vigiles ships a Claude Code adapter; building your own is welcome and
 * supported — see `docs/authoring-an-adapter.md`.
 *
 *   import {
 *     type HarnessAdapter, type HarnessDialect, type PluginLayout,
 *     type HarnessRuntime, type HookProtocol, type ModelMock,
 *     assertAdapterConformance,
 *   } from "vigiles/adapter";
 *
 *   export const myHarnessAdapter: HarnessAdapter = { name: "my-harness", … };
 */
export type { HarnessAdapter, AdapterCapabilities } from "./core/adapter.js";
export type { HarnessDialect } from "./core/dialect.js";
export type { PluginLayout } from "./core/layout.js";
export type { HarnessRuntime } from "./core/runtime.js";
export type { HookProtocol } from "./core/hook-protocol.js";
export type { ModelMock } from "./core/model-mock.js";

/**
 * The `claims(path)` helper every shipped adapter uses: derive "is this path
 * mine?" from the adapter's own `PluginLayout`, so a layout that moves takes its
 * claim with it. Override `claims` by hand only for a location the layout fields
 * cannot express. See `core/surface-discovery.ts` for why a claim is a question
 * about a PATH and never about a root.
 */
export { layoutClaims } from "./core/surface-discovery.js";

export {
  checkAdapterConformance,
  assertAdapterConformance,
  assertAdapterLoadsHooks,
  assertHarnessTestable,
  type ConformanceResult,
} from "./adapter-conformance.js";
export {
  ADAPTERS,
  defaultAdapter,
  detectAdapter,
  detectAdapterResult,
  resolveAdapter,
  getAdapter,
  type DetectResult,
  type HarnessName,
} from "./adapter-registry.js";
