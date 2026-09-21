/**
 * The registered harnesses' LAYOUTS, as pure data — the claim side of surface
 * discovery, available where the adapter bundle is not.
 *
 * 🔴 WHY THIS IS NOT JUST `ADAPTERS.map(a => a.layout)`. `src/adapter-registry.ts`
 * imports the full `HarnessAdapter` bundles, and an adapter's `detect(root)` does
 * real filesystem work — so that module pulls `node:fs` in. `src/scan-files.ts`
 * is the BROWSER-SAFE twin of the scan ("NO filesystem, NO child_process, NO disk
 * I/O at all") and needs exactly one thing from the registry: which paths a
 * shipped harness reads. A `PluginLayout` is a plain object of strings, so this
 * list is importable from both sides.
 *
 * The drift that split lists invite is CHECKED, not hoped for:
 * `src/layout-registry.test.ts` asserts this list is exactly the layouts the
 * `ADAPTERS` registry carries, and that every adapter's `claims` agrees with
 * `layoutClaims` over its own layout — so adding a harness to one registry and
 * not the other fails a test instead of quietly halving discovery.
 */
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { codexLayout } from "./adapters/codex/layout.js";
import type { PluginLayout } from "./core/layout.js";
import { layoutClaims } from "./core/surface-discovery.js";

/** Every SHIPPED harness layout, in registry order. */
export const REGISTERED_LAYOUTS: readonly PluginLayout[] = [
  claudeCodeLayout,
  codexLayout,
];

/**
 * "Is this repo-relative path read by some harness vigiles knows about?" — one
 * predicate per registered layout, the input to `unclaimedSurfaces`.
 *
 * Note it is the layouts of every REGISTERED harness, not of the DETECTED one.
 * A repo carrying both `.claude/skills` and `.agents/skills` has each half
 * claimed by a different harness and neither is a finding; a repo whose skills
 * sit under `.ai/` has them claimed by nobody, and that is the finding (#240).
 */
export const registeredClaims: ReadonlyArray<(path: string) => boolean> =
  REGISTERED_LAYOUTS.map((l) => (path: string) => layoutClaims(l, path));
