/**
 * The disk engine's hook inventory: the {@link HookInventory} of a repository
 * on disk, built from the hook blocks every declared harness reads.
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
import { join, resolve } from "node:path";
import type { PluginLayout } from "./core/layout.js";
import { hookLinePlan } from "./core/hook-command.js";
import { HOOKS_DIR } from "./core/hook-paths.js";
import { stampHook } from "./core/hook-program.js";
import { staleHookStamps, type StaleHookStamp } from "./core/hook-stamp.js";
import { readHookBlocks } from "./plugin-loader.js";
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
  layout: HookScriptScan["layout"],
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

/**
 * The inventory of the repository at `dir`, for EVERY declared harness layout:
 * each harness's blocks read under its own layout, each line read by identity
 * with what `compile` writes for THAT harness. Not built from `loadPlugins`,
 * which keeps one harness's hooks for a run to execute.
 */
export function diskHookInventory(
  dir: string,
  layouts: readonly PluginLayout[],
  disk: HookDisk,
): HookInventory {
  return hookInventory(
    layouts.map((layout) => ({
      blocks: readHookBlocks(dir, layout),
      scan: diskHookScan(dir, layout, disk),
    })),
  );
}

/**
 * Every stamp sidecar in the repository at `dir` whose hook source was edited
 * after `compile` — the detector `lint`, `audit` and the runtime share
 * (`core/hook-stamp.ts`), over the disk. A sidecar names its source as `compile`
 * was given it, relative to the project root, so it resolves against `dir`.
 */
export function diskStaleHookStamps(
  dir: string,
  disk: HookDisk,
): readonly StaleHookStamp[] {
  const hooksDir = join(dir, HOOKS_DIR);
  if (!disk.exists(hooksDir)) return [];
  const read = (ref: string): string | undefined => {
    const abs = resolve(dir, ref);
    return disk.exists(abs) ? disk.read(abs) : undefined;
  };
  return staleHookStamps(
    disk.list(hooksDir).map((name) => `${HOOKS_DIR}/${name}`),
    read,
    stampHook,
  );
}
