/**
 * The disk engine's hook inventory: the {@link HookInventory} of a repository
 * on disk, built from what the plugin loader reads.
 *
 * Two callers need it, and both used to answer "which hooks exist" their own
 * way: `scanPlugin` (the `Hooks` block, the inventory count, `hook-script-exists`)
 * and `findUntestedSurfaces` (`untested-hook`). Coverage kept a second reader
 * that searched the raw manifest JSON for script-shaped strings, over its own
 * list of files — so it never saw a plugin's hook-convention file (#283) and
 * guessed a script out of hand-written lines. Both now read this one inventory;
 * the browser twin builds the same inventory from its file map
 * (`scan-files.ts`), from the same pure parts in `scan-core.ts`.
 */
import type { AnyNonEmptyArray } from "ts-essentials";
import { join, resolve } from "node:path";
import type { PluginLayout } from "./core/layout.js";
import { hookLinePlan } from "./core/hook-command.js";
import { HOOKS_DIR } from "./core/hook-paths.js";
import { normalizeHooks } from "./core/hook-normalize.js";
import type { ExcludeSet } from "./exclude.js";
import { loadPlugins, type LoadedPlugin } from "./plugin-loader.js";
import {
  hookInventory,
  hookSourceRefs,
  type HookInventory,
  type HookScriptScan,
} from "./scan-core.js";

/**
 * The three reads the disk hook scan makes, injected: this module does no I/O
 * of its own, so the callers that already hold `node:fs` hand it in.
 */
export interface HookDisk {
  readonly exists: (absPath: string) => boolean;
  /** A file's text; only asked for a path `exists` said is there. */
  readonly read: (absPath: string) => string;
  /** A directory's entry names; only asked for a path `exists` said is there. */
  readonly list: (absPath: string) => readonly string[];
}

/** The hook scan as the disk answers it: every file is observable. */
export function diskHookScan(
  dir: string,
  layout: Pick<PluginLayout, "pluginRootToken" | "projectRootTokens">,
  disk: HookDisk,
): HookScriptScan {
  const read = (ref: string): string | undefined => {
    const abs = join(dir, ref);
    return disk.exists(abs) ? disk.read(abs) : undefined;
  };
  const hooksDir = join(dir, HOOKS_DIR);
  return {
    root: resolve(dir),
    layout,
    exists: disk.exists,
    // On disk a dependency is as observable as any other file.
    observable: () => true,
    plan: hookLinePlan(
      hookSourceRefs(disk.exists(hooksDir) ? disk.list(hooksDir) : []),
      read,
      layout.projectRootTokens,
    ),
  };
}

/** The inventory of what a loaded plugin registers, read by `scan`. */
export function loadedHookInventory(
  loaded: Pick<LoadedPlugin, "hooksAsWritten" | "shadowedSettingsHooks">,
  scan: Pick<HookScriptScan, "plan" | "root" | "layout">,
): HookInventory {
  // As WRITTEN: a line is read by identity with what compile would write, so
  // no root variable may be expanded first.
  return hookInventory(
    normalizeHooks(loaded.hooksAsWritten),
    normalizeHooks(loaded.shadowedSettingsHooks),
    scan,
  );
}

/**
 * The inventory of the repository at `dir`, loaded under every declared
 * harness layout. The first layout spells the plan's root variables, as in
 * `scanPlugin`.
 */
export function diskHookInventory(
  dir: string,
  layouts: Readonly<AnyNonEmptyArray<PluginLayout>>,
  disk: HookDisk,
  excludes?: ExcludeSet,
): HookInventory {
  const loaded = loadPlugins(
    dir,
    layouts.map((layout) => ({ layout, roots: [] })),
    excludes,
  );
  return loadedHookInventory(loaded, diskHookScan(dir, layouts[0], disk));
}
