/**
 * `scanFiles` — the BROWSER-SAFE deterministic audit engine.
 *
 * `scanPlugin` (src/scan.ts) walks a directory on disk. `scanFiles` produces the
 * SAME {@link ScanReport} over an in-memory `Record<repoRelativePath, content>`
 * file map — exactly what an in-browser GitHub fetch yields — so the whole
 * deterministic audit (and the {@link buildAuditReport} it feeds) runs client-side
 * with NO filesystem, NO `child_process`, NO disk I/O at all.
 *
 * It mirrors `scanPlugin`'s body: it (a) reconstructs the `LoadedPlugin` shape
 * (`{settings.hooks, files, warnings, sources}`) from the map instead of a disk
 * walk, then (b) runs the SAME pure detectors `scanPlugin` runs (re-exported from
 * scan.ts — one detector, no drift), then (c) callers hand the result to
 * `buildAuditReport` unchanged. Every filesystem access in `scanPlugin` maps to a
 * lookup in the map: `existsSync(p)` → `p in files`, `readFileSync(p)` →
 * `files[p]`, "is a directory" → `keys.some(k => k.startsWith(p + "/"))`.
 *
 * Path model — a SYNTHETIC ROOT ({@link BROWSER_ROOT}): a browser has no real
 * directory, so we resolve every path against a fixed absolute sentinel. All the
 * report fields that embed the plugin root on disk (`meta.dir`, a resolved hook
 * `script`/`command`, a hook-block `scriptPath`) come out rooted at
 * {@link BROWSER_ROOT} instead of the checkout path. The parity test normalizes
 * the on-disk report's real absolute root to {@link BROWSER_ROOT} and asserts a
 * byte-identical {@link buildAuditReport} — the checkout path is the ONE thing that
 * legitimately differs between the two environments (it names WHERE the repo lives,
 * not WHAT the harness contains).
 *
 * The six filesystem touchpoints in `scanPlugin` are reimplemented here over the
 * map (never on disk): (1) hook-script resolution — scanHooks/collectHookBlockEntries
 * take an injected map-backed `exists`; (2) `collectMcpServers`; (3) the `hasSpec`
 * check; (4) `danglingRefs`; (5) `pluginDirLayoutIssues` (map-backed
 * existsSync/isDirectory); (6) `findUntestedSurfaces` (its globs → `Object.keys`
 * filters). `verifyLiveMcpTools` (spawns servers) is NOT part of `scanPlugin` and
 * is excluded. See research/report-view-and-browser-demo.md.
 */
import { basename, dirname, isAbsolute, join, relative } from "./posix-path.js";

import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { claudeCodeDialect } from "./adapters/claude-code/dialect.js";
import type { SettingsCodec } from "./core/settings-codec.js";
import {
  executableSourceDirs,
  materializePrefix,
  surfaceDirs,
  type PluginLayout,
} from "./core/layout.js";
import type { HarnessDialect } from "./core/dialect.js";
import { weighInstructions } from "./core/instruction-weight.js";
import {
  instructionCandidatePaths,
  resolveImports,
} from "./core/instruction-chain.js";
import type { LoadedPlugin } from "./plugin-loader.js";
import { normalizeHooks, hookEventNames } from "./core/hook-normalize.js";
import { verifyHookEvents, scoredIssues } from "./core/hook-events.js";
import { verifyMcpServers } from "./core/mcp-config.js";
import { agentPluginsMcpSources } from "./core/agent-plugins.js";
import { verifyMcpHookTargets } from "./core/mcp-hook.js";
import { pluginDirLayoutIssues } from "./core/plugin-dir-layout.js";
import { unclaimedSurfaceFindings } from "./core/surface-discovery.js";
import { REGISTERED_LAYOUTS } from "./layout-registry.js";
import {
  assertDistinctScopeKeys,
  multiScopeWarning,
  scopeKey,
  surfaceSource,
  type SurfaceScope,
} from "./core/surface-scopes.js";

/** Mirror of plugin-loader.ts `MaterializedSurfaces`. */
interface MaterializedSurfaces {
  readonly counts: Record<string, number>;
  /**
   * Mirror of the disk loader's field — the tally EXCLUDING declared roots.
   *
   * Always equal to `counts` here TODAY, because this twin has no config to read
   * `harnesses.<name>.roots` from (the in-browser audit is handed a file map,
   * not a repo).
   * It exists anyway so the two materializers keep the same shape: the pair has
   * repeatedly been bitten by one side growing a field the other did not.
   */
  readonly harnessCounts: Record<string, number>;
  readonly scopes: readonly SurfaceScope[];
}
import { hookBlockIssues } from "./core/hook-block-ineffective.js";
import { hookMatcherIssues } from "./core/hook-matcher.js";
import { findUntestedSurfacesInFiles } from "./test-coverage-files.js";
import { countEvidence } from "./coverage-evidence.js";
import {
  intraRefPattern,
  startsAtSeparator,
  stripFullLineComments,
} from "./core/source-refs.js";
import {
  makeClassifier,
  scanAgents,
  scanSkills,
  skillRefSources,
  scanHooks,
  frontmatterIssuesFor,
  frontmatterValueIssuesFor,
  skillMetaIssuesFor,
  malformedFrontmatterFor,
  descriptionOverlapsFor,
  descriptionBudgetFor,
  collectSurfaceFindings,
  collectDelegationTrifecta,
  collectHookBlockEntries,
  collectHookMatchers,
  summarizePurity,
  detectOwnTestSignal,
  remapFindingPaths,
} from "./scan-core.js";
// Zero imports of its own — pure string work, safe in the browser engine.
import { brokenSkillRefs, formatSkillRefIssue } from "./skill-refs.js";
import {
  conflictedHarnessConfigs,
  mergeConflictWarning,
} from "./core/merge-conflict.js";
// TYPE-ONLY from ./scan.js (the report shapes) — elided at build, so the
// node-only runtime deps of scan.ts (plugin-loader/mcp/test-coverage/node:fs)
// never enter this browser-safe engine's graph. The runtime detectors come from
// the node-free ./scan-core.js above.
import type { ScanReport, ScanInstructions } from "./scan.js";
import { collectVocabularyNotes } from "./scan-core.js";
import {
  blockIneffectiveEventsOf,
  permissionDecisionEventsOf,
} from "./core/event-capability.js";

/**
 * The synthetic absolute root every path in a browser scan resolves against. A
 * pure, deterministic string (never `process.cwd()`), so `join`/`relative` stay
 * side-effect-free and identical on every machine. Exported so the parity test can
 * normalize an on-disk report's real absolute root to it before comparing.
 */
export const BROWSER_ROOT = "/__vigiles_repo__";

/** Mirror of loadPlugin's `MAX_SKILL_FILE_BYTES` — surface files over this are skipped. */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** UTF-8 byte length (mirrors disk `statSync(f).size` for a text file). */
const byteLen = (s: string): number => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------------------
// File-map primitives (repo-relative keys, POSIX-style)
// ---------------------------------------------------------------------------

/** `p in files` — a repo-relative path is present as a file key. */
function hasFile(files: Record<string, string>, rel: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, rel);
}

/** "is a directory" — some file key lives UNDER `rel/`. */
function isDirRel(files: Record<string, string>, rel: string): boolean {
  const prefix = rel === "" ? "" : `${rel}/`;
  if (rel === "") return Object.keys(files).length > 0;
  return Object.keys(files).some((k) => k.startsWith(prefix));
}

/**
 * The repo-relative form of an absolute BROWSER_ROOT-rooted path, or `null` when
 * the path escapes the root (a `../` outside the plugin — never a plugin file).
 */
function toRel(absPath: string): string | null {
  const rel = relative(BROWSER_ROOT, absPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * A map-backed `existsSync` over absolute BROWSER_ROOT-rooted paths. Mirrors
 * node's `fs.existsSync`, which is true for a FILE **or a DIRECTORY** — so a
 * detector like `pluginDirLayoutIssues` (`exists(dir) && isDirectory(dir)`)
 * resolves the same in the browser as on disk. File-only here would silently miss
 * any directory-existence check the CLI reports.
 */
function mapExists(files: Record<string, string>): (p: string) => boolean {
  return (p: string): boolean => {
    const rel = toRel(p);
    return rel !== null && (hasFile(files, rel) || isDirRel(files, rel));
  };
}

/** A map-backed `isDirectory` over absolute BROWSER_ROOT-rooted paths. */
function mapIsDirectory(files: Record<string, string>): (p: string) => boolean {
  return (p: string): boolean => {
    const rel = toRel(p);
    return rel !== null && isDirRel(files, rel);
  };
}

/** A map-backed `readFileSync` (returns "" on a miss, like the detector default). */
function mapReadFile(files: Record<string, string>): (p: string) => string {
  return (p: string): string => {
    const rel = toRel(p);
    return rel !== null && hasFile(files, rel) ? files[rel] : "";
  };
}

/**
 * Read a subtree of the map as `relativeToBase → content`, mirroring
 * loadPlugin's `readTree(dir, base)` — including its `MAX_SKILL_FILE_BYTES` cap.
 * `baseRel === ""` reads the whole repo (the single-skill case's `readTree(root,
 * root)`).
 */
function readTreeUnder(
  files: Record<string, string>,
  dirRel: string,
  baseRel: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const underPrefix = dirRel === "" ? "" : `${dirRel}/`;
  const basePrefix = baseRel === "" ? "" : `${baseRel}/`;
  for (const [k, content] of Object.entries(files)) {
    if (dirRel !== "" && !k.startsWith(underPrefix)) continue;
    if (byteLen(content) > MAX_SKILL_FILE_BYTES) continue;
    const rel = baseRel === "" ? k : k.slice(basePrefix.length);
    out[rel] = content;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest / hooks reading (mirrors plugin-loader.ts readHooks/safeReadManifest)
// ---------------------------------------------------------------------------

/** Parse a JSON file's text, or null on any error. */
function safeParseJson(
  text: string | undefined,
): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse the layout's manifest from the map through its CODEC, or null. */
function readManifest(
  files: Record<string, string>,
  layout: PluginLayout,
): Record<string, unknown> | null {
  const text = files[layout.manifestPath];
  if (text === undefined) return null;
  try {
    return layout.settings.parse(text);
  } catch {
    return null;
  }
}

/** The `.hooks` field of a JSON file in the map, or undefined. */
function readHooksJsonFile(
  files: Record<string, string>,
  rel: string,
): unknown {
  return safeParseJson(files[rel])?.hooks;
}

/** The `.hooks` of a settings file in the map, through the layout's codec. */
function readSettingsHooks(text: string, codec: SettingsCodec): unknown {
  try {
    return codec.parse(text).hooks;
  } catch {
    return undefined;
  }
}

/** Mirror of plugin-loader.ts `readHooks`, over the file map. */
function readHooks(
  files: Record<string, string>,
  layout: PluginLayout,
): unknown {
  const m = readManifest(files, layout);
  if (m) {
    if (typeof m.hooks === "string") {
      return readHooksJsonFile(files, m.hooks.replace(/^\.\//, ""));
    }
    if (m.hooks !== undefined) return m.hooks;
  }
  // Optional: a harness whose hooks are in-process code modules has no
  // standalone hooks FILE. Mirrors the disk loader.
  if (
    layout.hooksConventionPath !== undefined &&
    hasFile(files, layout.hooksConventionPath)
  ) {
    return readHooksJsonFile(files, layout.hooksConventionPath);
  }
  const settings = files[layout.settingsPath];
  if (settings !== undefined) {
    return readSettingsHooks(settings, layout.settings);
  }
  return undefined;
}

/** Whether the plugin declares any MCP servers (standalone file or manifest key). */
function hasMcp(files: Record<string, string>, layout: PluginLayout): boolean {
  if (hasFile(files, layout.mcpConfigFile)) return true;
  return readManifest(files, layout)?.[layout.mcpManifestKey] !== undefined;
}

// ---------------------------------------------------------------------------
// Surface materialization (mirrors plugin-loader.ts materializeSurfaces)
// ---------------------------------------------------------------------------

/**
 * Mirror of plugin-loader.ts `surfaceHasLoadable`. The SCOPING DECISION itself is
 * not mirrored — it lives once, IO-free, in `src/core/surface-scopes.ts`, and both
 * engines call it. That pair used to be two copies of the same precedence rules,
 * which is exactly the shape this repo keeps getting bitten by fixing on one side.
 */
function surfaceHasLoadable(
  layout: PluginLayout,
  surface: string,
  tree: Record<string, string>,
): boolean {
  const keys = Object.keys(tree);
  return surface === layout.surfaces.skill
    ? keys.some((k) => basename(k) === "SKILL.md")
    : keys.some((k) => k.endsWith(".md"));
}

/** The materialization accumulator — surface contents + their on-disk source paths. */
interface Materialized {
  out: Record<string, string>;
  sources: Record<string, string>;
}

/** Mirror of plugin-loader.ts `materializeSurfaces`, over the file map. */
function materializeSurfaces(
  files: Record<string, string>,
  layout: PluginLayout,
  acc: Materialized,
  repoName?: string,
): MaterializedSurfaces {
  const { out, sources } = acc;
  const counts: Record<string, number> = {};
  const harnessCounts: Record<string, number> = {};
  const scopeTrees = (base: string): Map<string, Record<string, string>> => {
    const trees = new Map<string, Record<string, string>>();
    for (const surface of surfaceDirs(layout)) {
      const dirRel = base === "" ? surface : `${base}/${surface}`;
      trees.set(
        surface,
        isDirRel(files, dirRel) ? readTreeUnder(files, dirRel, dirRel) : {},
      );
    }
    return trees;
  };
  const hasLoadable = (trees: ReadonlyMap<string, Record<string, string>>) =>
    surfaceDirs(layout).some((s) =>
      surfaceHasLoadable(layout, s, trees.get(s) ?? {}),
    );
  const add = (key: string, content: string, onDisk: string): void => {
    out[key] = content;
    sources[key] = onDisk;
  };

  const rootTrees = scopeTrees("");
  const userTrees =
    layout.userSurfaceRoot !== undefined
      ? scopeTrees(layout.userSurfaceRoot)
      : new Map<string, Record<string, string>>();

  /** Mirror of the disk loader's `materializeScope`. */
  const materializeScope = (
    scope: SurfaceScope,
    trees: ReadonlyMap<string, Record<string, string>>,
  ): void => {
    for (const surface of surfaceDirs(layout)) {
      const tree = trees.get(surface) ?? {};
      const dirRel = scope.base === "" ? surface : `${scope.base}/${surface}`;
      for (const [rel, content] of Object.entries(tree))
        add(
          scopeKey(scope, surface, rel),
          content,
          join(BROWSER_ROOT, dirRel, rel),
        );
      const n = Object.keys(tree).length;
      counts[surface] = (counts[surface] ?? 0) + n;
      if (scope.declared !== true)
        harnessCounts[surface] = (harnessCounts[surface] ?? 0) + n;
    }
  };

  const source = surfaceSource(layout, {
    hasRootSkillFile:
      layout.surfaces.skill !== undefined && hasFile(files, "SKILL.md"),
    // Disk mirrors the CLI: a nameless root SKILL.md takes the audited dir's
    // basename. In-browser there's no real dir, so use the repo name when the
    // caller (runAudit) supplies it, else the synthetic BROWSER_ROOT basename.
    skillName: repoName ?? basename(BROWSER_ROOT),
    rootHasLoadable: hasLoadable(rootTrees),
    isPluginShaped:
      hasFile(files, layout.manifestPath) ||
      (layout.hooksConventionPath !== undefined &&
        hasFile(files, layout.hooksConventionPath)),
    userHasLoadable: hasLoadable(userTrees),
  });

  switch (source.kind) {
    case "single-skill": {
      const tree = readTreeUnder(files, "", "");
      // Mirrors the disk loader: the skill dir is carried on the variant, so
      // there is no `undefined` case to guard and no dead branch to keep in
      // sync across the two engines.
      const { skillDir } = source;
      for (const [rel, content] of Object.entries(tree)) {
        add(
          join(materializePrefix(layout), skillDir, source.skillName, rel),
          content,
          join(BROWSER_ROOT, rel),
        );
      }
      counts[skillDir] = Object.keys(tree).length;
      harnessCounts[skillDir] = counts[skillDir];
      return { counts, harnessCounts, scopes: [] };
    }
    case "scopes": {
      assertDistinctScopeKeys(source.scopes, layout.name);
      for (const scope of source.scopes)
        materializeScope(scope, scope.base === "" ? rootTrees : userTrees);
      return { counts, harnessCounts, scopes: source.scopes };
    }
  }
}

// ---------------------------------------------------------------------------
// Dangling intra-plugin refs (mirrors plugin-loader.ts danglingRefs)
// ---------------------------------------------------------------------------

// Extensions + BOTH token boundaries live in core/source-refs.ts, so this and
// its disk twin (plugin-loader.ts) cannot disagree and neither can omit one.
function intraRefRe(layout: PluginLayout): RegExp {
  return intraRefPattern(executableSourceDirs(layout));
}

const NON_PLUGIN_VARS = new Set([
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PROJECT",
  "HOME",
  "PWD",
  "OLDPWD",
]);

/** Mirror of plugin-loader.ts `isPluginRooted`, including its boundary test:
 *  a match preceded by a path-segment character landed INSIDE a longer name
 *  (`claude-agents/`) and refers to nothing. */
function isPluginRooted(content: string, idx: number): boolean {
  // Start-of-content is handled by `startsAtSeparator` itself (`idx <= 0`), not
  // by a guard here — see the twin in plugin-loader.ts.
  if (content[idx - 1] !== "/") return startsAtSeparator(content, idx);
  const seg = /([^\s"'`(=:/]*)$/.exec(content.slice(0, idx - 1))?.[1] ?? "";
  const varName = /^\$\{?(\w+)\}?$/.exec(seg)?.[1];
  if (varName !== undefined) return !NON_PLUGIN_VARS.has(varName);
  return false;
}

const DOC_SOURCE_RE = /\.(?:md|markdown|mdx|txt|rst)$/i;

/** The plugin's executable (non-prose) source-file CONTENTS under the surface dirs. */
function executableContents(
  files: Record<string, string>,
  layout: PluginLayout,
): string[] {
  const out: string[] = [];
  for (const surface of executableSourceDirs(layout)) {
    if (!isDirRel(files, surface)) continue;
    for (const [k, content] of Object.entries(files)) {
      if (!k.startsWith(`${surface}/`)) continue;
      if (DOC_SOURCE_RE.test(k)) continue;
      if (byteLen(content) > MAX_SKILL_FILE_BYTES) continue;
      // A full-line comment is prose in EVERY language, not only in shell.
      out.push(stripFullLineComments(k, content));
    }
  }
  return out;
}

/**
 * Mirror of plugin-loader.ts `resolvesUnderRoot`, over the file map. `rootName`
 * is the audited root's own directory name (the map-backed analog of
 * `basename(root)` on disk — see `scanFiles`'s `repoName` param) — used to
 * detect a REPO-CHECKOUT-RELATIVE echo of the plugin's own containing surface
 * dir + name (`skills/<plugin>/hooks/setup.sh`) ahead of the real
 * plugin-relative path (`hooks/setup.sh`), issue #110.
 */
function resolvesUnderRoot(
  files: Record<string, string>,
  ref: string,
  rootName: string,
): boolean {
  if (hasFile(files, ref)) return true;
  const segs = ref.split("/");
  if (segs.length > 2 && segs[1] === rootName) {
    const rest = segs.slice(2).join("/");
    if (rest.length > 0 && hasFile(files, rest)) return true;
  }
  return false;
}

/** Mirror of plugin-loader.ts `danglingRefs`, over the file map. */
function danglingRefs(
  files: Record<string, string>,
  layout: PluginLayout,
  rootName: string,
): string[] {
  const re = intraRefRe(layout);
  const missing = new Set<string>();
  for (const content of executableContents(files, layout)) {
    for (const m of content.matchAll(re)) {
      if (m.index !== undefined && !isPluginRooted(content, m.index)) continue;
      if (!resolvesUnderRoot(files, m[0], rootName)) missing.add(m[0]);
    }
  }
  return [...missing];
}

// ---------------------------------------------------------------------------
// Warnings (mirrors plugin-loader.ts pluginWarnings)
// ---------------------------------------------------------------------------

function pluginWarnings(
  files: Record<string, string>,
  layout: PluginLayout,
  { counts, harnessCounts, scopes }: MaterializedSurfaces,
  hooks: unknown,
  materialized: Record<string, string>,
  rootName: string,
): string[] {
  const warnings: string[] = [];
  const multiScope = multiScopeWarning(scopes, harnessCounts);
  if (multiScope !== undefined) warnings.push(multiScope);
  if (counts.agents) {
    warnings.push(
      `plugin defines ${String(counts.agents)} subagent file(s) under agents/ — these run only under a real model; test them at the eval tier (runEval), not the deterministic mock.`,
    );
  }
  if (counts.commands) {
    warnings.push(
      `plugin defines ${String(counts.commands)} slash-command file(s) under commands/ — slash-command invocation needs a real model; test at the eval tier.`,
    );
  }
  if (hasMcp(files, layout)) {
    warnings.push(
      `plugin declares MCP server(s) (${layout.mcpManifestKey} / ${layout.mcpConfigFile}) — the loader does not wire MCP; bring the server up yourself if your test needs it.`,
    );
  }
  const dangling = danglingRefs(files, layout, rootName);
  if (dangling.length) {
    const shown = dangling.slice(0, 5).join(", ");
    const more =
      dangling.length > 5 ? `, … (+${String(dangling.length - 5)})` : "";
    warnings.push(
      `plugin references ${String(dangling.length)} intra-plugin file(s) that don't exist (broken path / partial vendor): ${shown}${more}`,
    );
  }
  if (!hooks && Object.keys(materialized).length === 0) {
    warnings.push(
      `nothing was loaded (no hooks, CLAUDE.md, skills, agents, or commands) — the deterministic harness would run an effectively empty machine.`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// loadPluginFromFiles (mirrors plugin-loader.ts loadPlugin)
// ---------------------------------------------------------------------------

/**
 * Reconstruct the `LoadedPlugin` shape from a repo-relative file map, exactly as
 * `loadPlugin` builds it off disk — surface files materialized under the layout's
 * `materializeRoot`, hook commands with the plugin-root token expanded to
 * {@link BROWSER_ROOT}, and the same `warnings`.
 */
export function loadPluginFromFiles(
  files: Record<string, string>,
  layout: PluginLayout,
  repoName?: string,
): LoadedPlugin {
  const hooks = readHooks(files, layout);
  const resolvedHooks = hooks
    ? (JSON.parse(
        JSON.stringify(hooks).replaceAll(layout.pluginRootToken, BROWSER_ROOT),
      ) as unknown)
    : undefined;

  const out: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const instructionText = files[layout.instructionFile];
  if (instructionText !== undefined) {
    out[layout.instructionFile] = instructionText;
    sources[layout.instructionFile] = join(
      BROWSER_ROOT,
      layout.instructionFile,
    );
  }
  const surfaces = materializeSurfaces(
    files,
    layout,
    { out, sources },
    repoName,
  );

  return {
    settings: resolvedHooks ? { hooks: resolvedHooks } : {},
    files: out,
    sources,
    warnings: pluginWarnings(
      files,
      layout,
      surfaces,
      resolvedHooks,
      out,
      repoName ?? basename(BROWSER_ROOT),
    ),
  };
}

// ---------------------------------------------------------------------------
// collectMcpServers (mirrors scan.ts collectMcpServers)
// ---------------------------------------------------------------------------

function collectMcpServers(
  files: Record<string, string>,
  layout: PluginLayout,
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  const read = (file: string): string | undefined => files[file];
  const collect = (file: string): void => {
    const text = read(file);
    if (text === undefined) return;
    try {
      const parsed = JSON.parse(text) as { mcpServers?: unknown };
      if (parsed.mcpServers !== null && typeof parsed.mcpServers === "object") {
        Object.assign(servers, parsed.mcpServers);
      }
    } catch {
      /* malformed JSON is the loader's concern, not this check's */
    }
  };
  // Mirrors the fs-backed collector in scan.ts: the layout's own locations plus
  // the Agent Plugins standard's root `mcp.json` when this repo ships that
  // manifest (no harness layout names it, so the MCP checks would miss it).
  for (const file of [
    layout.mcpConfigFile,
    layout.manifestPath,
    ...agentPluginsMcpSources(read),
  ]) {
    collect(file);
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan an in-memory repo-relative file map and report its surfaces + structural
 * issues — the browser-safe twin of {@link scanPlugin}. `files` is
 * `repoRelativePath → content` (as a GitHub fetch yields). Produces a
 * {@link ScanReport} that {@link buildAuditReport} turns into the exact same
 * `AuditReport` the CLI's `audit --json` produces over the same files (modulo the
 * checkout path — see {@link BROWSER_ROOT}).
 */
export function scanFiles(
  files: Record<string, string>,
  layout: PluginLayout = claudeCodeLayout,
  dialect: HarnessDialect = claudeCodeDialect,
  repoName?: string,
): ScanReport {
  const lay = layout;
  const cls = makeClassifier(lay);
  const loaded = loadPluginFromFiles(files, lay, repoName);
  const exists = mapExists(files);
  const hookRegs = normalizeHooks(loaded.settings.hooks);
  const { hooks, inline, manual } = scanHooks(
    hookRegs,
    BROWSER_ROOT,
    lay.pluginRootToken,
    exists,
  );
  const eventNames = hookEventNames(loaded.settings.hooks);
  const allHookEventIssues = verifyHookEvents(eventNames, dialect);
  const hookEventIssues = scoredIssues(allHookEventIssues);
  const instructions: ScanInstructions | null =
    loaded.files[lay.instructionFile] !== undefined
      ? {
          file: lay.instructionFile,
          hasSpec: hasFile(files, `${lay.instructionFile}.spec.ts`),
        }
      : null;
  // The BOUNDED candidate set over the map, then the same one-level import pass
  // the disk walk runs — `resolveImports` lives in the core precisely so these
  // two cannot drift. An import the fetcher never fetched simply stays unread,
  // and the weight says so (`unreadImports`) instead of quietly omitting it.
  const instructionFiles = resolveImports(
    lay,
    Object.fromEntries(
      instructionCandidatePaths(Object.keys(files), lay).map((p) => [
        p,
        files[p] ?? "",
      ]),
    ),
    (p) => files[p],
  );
  const mcpServers = collectMcpServers(files, lay);
  const declaredServers = Object.keys(mcpServers);
  // The repo's own test signal — same shared detector as the disk path, over the
  // map-backed IO, so the demo report matches `audit --json` byte-for-byte.
  const ownTestSignal = detectOwnTestSignal(BROWSER_ROOT, {
    readFile: mapReadFile(files),
    existsSync: exists,
  });
  const agents = scanAgents(loaded.files, dialect, declaredServers, cls, {
    root: BROWSER_ROOT,
    sources: loaded.sources,
  });
  const skills = scanSkills(loaded.files, cls, {
    root: BROWSER_ROOT,
    materializeRoot: materializePrefix(lay),
    dialect,
    sources: loaded.sources,
    existsSync: exists,
  });
  const puritySummary = summarizePurity(agents);
  const { trifectaFindings, skillResourceFindings, skillFenceFindings } =
    collectSurfaceFindings(agents, skills);
  // Remap frontmatter-family finding paths to the real on-disk path (dogfood E1),
  // same as the disk scanner — keeps the demo report byte-identical.
  const remap = <
    T extends { readonly path: string; readonly message?: string },
  >(
    findings: readonly T[],
  ): T[] => remapFindingPaths(findings, loaded.sources, BROWSER_ROOT);
  // ONE discovery pass, read three ways — the union, the free deterministic tier
  // (`Tested`), and the paid real-model tier (`Evaluated`). Mirrors scanPlugin.
  const coverage = findUntestedSurfacesInFiles(
    files,
    lay,
    repoName ?? basename(BROWSER_ROOT),
  );
  return {
    dir: BROWSER_ROOT,
    instructions,
    ownTestSignal,
    skills,
    agents,
    hooks,
    inlineHooks: inline,
    manualHookCount: manual,
    commands: Object.keys(loaded.files).filter(cls.isCommand).length,
    // A declared server set counts even when the loader emitted no warning —
    // otherwise a plugin whose servers come from the Agent Plugins `mcp.json`
    // reports "MCP servers: no" while the report lists an MCP finding.
    mcp:
      loaded.warnings.some((w) => w.includes("MCP server")) ||
      declaredServers.length > 0,
    danglingRefs: danglingRefs(files, lay, repoName ?? basename(BROWSER_ROOT)),
    // Kept in step with `scanPlugin`: skill→skill references BY NAME, which
    // `danglingRefs` structurally cannot see. The parity test is the only thing
    // holding these two report builders together, and it caught this field
    // landing in one of them and not the other.
    skillRefIssues: brokenSkillRefs(
      skillRefSources(loaded.files, cls, {
        root: BROWSER_ROOT,
        sources: loaded.sources,
      }),
    ).map(formatSkillRefIssue),
    hookEventIssues,
    vocabularyNotes: collectVocabularyNotes(allHookEventIssues, agents),
    frontmatterIssues: remap(frontmatterIssuesFor(loaded.files, cls)),
    frontmatterValueIssues: remap(frontmatterValueIssuesFor(loaded.files, cls)),
    skillMetaIssues: remap(skillMetaIssuesFor(loaded.files, cls)),
    mcpIssues: verifyMcpServers(mcpServers),
    mcpHookIssues: verifyMcpHookTargets(
      loaded.settings.hooks,
      declaredServers,
      dialect,
    ),
    descriptionOverlaps: descriptionOverlapsFor(loaded.files, cls, {
      root: BROWSER_ROOT,
      sources: loaded.sources,
    }),
    descriptionBudgetIssues: descriptionBudgetFor(loaded.files, cls),
    trifectaFindings,
    skillResourceIssues: skillResourceFindings,
    skillFenceIssues: skillFenceFindings,
    // The browser twin has the WHOLE fetched key set in hand, so discovery needs
    // no walk here — the pure classifier re-applies the same bounded-root rule.
    unclaimedSurfaces: unclaimedSurfaceFindings(
      Object.keys(files),
      REGISTERED_LAYOUTS,
    ),
    pluginLayoutIssues: pluginDirLayoutIssues(
      join(BROWSER_ROOT, dirname(lay.manifestPath)),
      // See the note in scan.ts: the scripts dir is NAMED by the layout, not
      // derived from the registration file's first segment.
      executableSourceDirs(lay),
      { existsSync: exists, isDirectory: mapIsDirectory(files) },
    ),
    delegationTrifecta: collectDelegationTrifecta(agents, dialect),
    hookBlockFindings:
      blockIneffectiveEventsOf(dialect).length > 0
        ? hookBlockIssues(
            collectHookBlockEntries(
              hookRegs,
              BROWSER_ROOT,
              lay.pluginRootToken,
              exists,
            ),
            {
              noEffectEvents: new Set(blockIneffectiveEventsOf(dialect)),
              permissionDecisionEvents: new Set(
                permissionDecisionEventsOf(dialect),
              ),
              readFileSync: mapReadFile(files),
            },
          )
        : [],
    hookMatcherFindings: hookMatcherIssues(
      collectHookMatchers(hookRegs),
      declaredServers,
      dialect,
    ),
    malformedFrontmatter: remap(malformedFrontmatterFor(loaded.files, cls)),
    // Same detector as `scanPlugin`, over the map instead of disk — the parity
    // gate is byte-identical reports, so a finding that existed on only one side
    // would fail it.
    warnings: [
      ...loaded.warnings,
      ...conflictedHarnessConfigs((f) => files[f]).map(mergeConflictWarning),
    ],
    // 🔴 THE TWIN APPLIES THE SAME BOUND AS THE DISK WALK, and until now it
    // applied none. The comment here used to read "the file map IS the repo, so
    // the glob filter does the whole job" — which was true of a glob and is not
    // true of a bound: `boundedInstructionFiles` enumerates the repo root plus
    // depth-1 dot-directories and nothing else, so handing the whole fetched map
    // over would make the browser weigh files the CLI never opens. Same filter,
    // same import pass, same chain; only the storage differs.
    instructionWeight: dialect.instructionBudget
      ? weighInstructions(
          lay.instructionChain(instructionFiles),
          instructionFiles,
          dialect.instructionBudget,
        )
      : null,
    untested: coverage.untested.length,
    untestedHarness: coverage.harness.untested.length,
    unevaluated: coverage.evals.untested.length,
    evaluable: coverage.evals.covered.length + coverage.evals.untested.length,
    coverageEvidence: countEvidence(coverage.decisions),
    puritySummary,
  };
}
