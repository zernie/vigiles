/**
 * The disk engine's hook inventory: the {@link HookInventory} of a repository
 * on disk, built from what the plugin loader reads — the one answer `scanPlugin`
 * reads the `Hooks` block, the inventory count and `hook-script-exists` from.
 * The browser twin builds the same inventory from its file map
 * (`scan-files.ts`), from the same pure parts in `scan-core.ts`.
 */
import { join, resolve } from "node:path";
import type { PluginLayout } from "./core/layout.js";
import { hookLinePlan } from "./core/hook-command.js";
import { HOOKS_DIR } from "./core/hook-paths.js";
import { normalizeHooks } from "./core/hook-normalize.js";
import type { LoadedPlugin } from "./plugin-loader.js";
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
