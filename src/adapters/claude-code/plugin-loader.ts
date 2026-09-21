/**
 * vigiles — the Claude Code wrapper over the harness-agnostic plugin loader.
 *
 * The generic loader lives at the composition root (`src/plugin-loader.ts`) and
 * takes a `PluginLayout` by injection, so no adapter imports a sibling adapter.
 * This thin wrapper supplies the Claude Code layout as the default, preserving
 * the `loadPlugin(dir)` / `resolveHarness(opts)` ergonomics and the public
 * `vigiles/claude-code` + `vigiles/plugin-loader` exports unchanged.
 */
import type { PluginLayout } from "../../core/layout.js";
import {
  loadPlugin as loadPluginWith,
  resolveHarness as resolveHarnessWith,
} from "../../plugin-loader.js";
import { claudeCodeLayout } from "./layout.js";

export type { LoadedPlugin } from "../../plugin-loader.js";

/**
 * Load the real Claude Code harness at `pluginPath` (defaults to `claudeCodeLayout`).
 *
 * 🔴 DELIBERATELY NOT FORWARDING an `ExcludeSet`. The generic loader takes one
 * (`.vigilesrc.json#exclude` filters surface discovery), but this is the PUBLIC
 * `vigiles/claude-code` face, and a parameter whose type and constructor are both
 * internal would land in the published surface as a name no consumer can write.
 * In-repo callers that hold an ExcludeSet — `scan.ts` — import the composition
 * root directly, which is where the layout is required anyway.
 */
export function loadPlugin(
  pluginPath: string,
  layout: PluginLayout = claudeCodeLayout,
): ReturnType<typeof loadPluginWith> {
  return loadPluginWith(pluginPath, layout);
}

/**
 * Resolve the effective harness for a test/eval (arm) under the Claude Code
 * layout by default. Delegates to the generic `resolveHarness` at the
 * composition root.
 */
export function resolveHarness(
  opts: {
    plugin?: string;
    settings?: unknown;
    files?: Record<string, string>;
  },
  layout: PluginLayout = claudeCodeLayout,
): ReturnType<typeof resolveHarnessWith> {
  return resolveHarnessWith(opts, layout);
}
