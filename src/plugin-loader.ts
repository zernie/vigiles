/**
 * vigiles — harness-agnostic plugin/repo harness loader (composition root).
 *
 * Lives at the app/composition root, NOT in any harness adapter, so every
 * adapter (Claude Code, Codex, OpenCode, …) loads its plugin through the SAME
 * loader by injecting its own `PluginLayout` — no adapter imports a sibling
 * adapter. The unit that matters is not a single hook but the *assembled
 * machine*: the hooks, settings, instruction file, skills, subagents, and
 * commands a plugin/repo actually ships, working together. `loadPlugin` reads
 * that real harness so a `runHarnessTest` / `runEval` runs against what ships —
 * not a hand-retyped subset that can drift. Hooks, instruction file and skills
 * are exercisable at the deterministic tier; subagents/commands/MCP are
 * materialized but only run under a real model, so `LoadedPlugin.warnings` flags
 * them (no silent empty machine).
 *
 *   runHarnessTest({ plugin: "./", model: scriptModel([...]) });
 *
 * Resolution order for hooks: inline `hooks` in the layout's manifest, a `hooks`
 * string path in the manifest, the layout's `hooks` convention path (e.g.
 * obra/superpowers' `hooks/hooks.json`), then a plain repo's settings file.
 * The layout's plugin-root token in any hook command is expanded to the plugin's
 * absolute path, so the real hook scripts run from where they live (no copying
 * needed). The plugin's instruction file and skills/ are materialized into the
 * sandbox so the assembled context is present too.
 *
 * `layout` is REQUIRED here — there is no harness default at the composition
 * root. Each adapter supplies its own (the Claude Code wrapper at
 * `src/adapters/claude-code/plugin-loader.ts` defaults it to `claudeCodeLayout`
 * to preserve `loadPlugin(dir)` ergonomics and the public `vigiles/*` exports).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";

import { parse as parseToml } from "@iarna/toml";

import { assertNever } from "./core/hash.js";
import type { PluginLayout } from "./core/layout.js";
import { excludedBy, excludesNothing, type Excluded } from "./exclude.js";
import type { ExcludeSet } from "./exclude.js";
import { entryOf, walkableRoot } from "./fs-walk.js";
import {
  intraRefPattern,
  startsAtSeparator,
  stripFullLineComments,
} from "./core/source-refs.js";
import {
  assertDistinctScopeKeys,
  multiScopeWarning,
  scopeKey,
  surfaceSource,
  type SurfaceScope,
} from "./core/surface-scopes.js";

/**
 * What one materialization pass produced: per-surface file counts, and the
 * discovery scopes it actually read from. They travel together because the
 * warnings need both — how much was read, and from how many levels.
 */
interface MaterializedSurfaces {
  readonly counts: Record<string, number>;
  readonly scopes: readonly SurfaceScope[];
}

export interface LoadedPlugin {
  /** A `.claude/settings.json`-shaped object with hooks resolved. */
  readonly settings: { hooks?: unknown };
  /** Files to materialize in the sandbox (CLAUDE.md, skills, agents, commands). */
  readonly files: Record<string, string>;
  /**
   * Surfaces that are present in the plugin but cannot be exercised at the
   * deterministic tier (subagents and slash commands need a real model; MCP
   * servers aren't wired by the loader). Empty when the plugin is fully
   * covered. Surfaced so "load the whole plugin" never silently tests nothing —
   * read it in a test, or just to know what the deterministic run won't reach.
   */
  readonly warnings: readonly string[];
  /**
   * Map from a materialized `files` key to the ABSOLUTE on-disk path it was read
   * from. A surface can be materialized under a canonical key (`.claude/skills/
   * foo/SKILL.md`) while living on disk at a different root (the repo-root
   * `skills/` OR the project-level `.claude/skills/`), so a consumer that needs
   * the real dir (e.g. resolving a skill's bundled resources) must reverse-map
   * through this instead of guessing from the key. Present for every surface file.
   */
  readonly sources: Record<string, string>;
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Parse a JSON file, or null on any error (missing / malformed). */
function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read and return the `.hooks` field of a JSON file, or undefined on any error. */
function readHooksFile(path: string): unknown {
  return safeReadJson(path)?.hooks;
}

/**
 * Parse the layout's manifest in its declared `settingsFormat` — JSON (Claude
 * Code's plugin.json) or TOML (Codex's `config.toml`). A TOML harness's manifest
 * (hooks, `[mcp_servers]`) would otherwise read as empty through the JSON path.
 * Behaviour-identical to `safeReadJson` when the format is JSON.
 */
function safeReadManifest(
  root: string,
  layout: PluginLayout,
): Record<string, unknown> | null {
  const path = join(root, layout.manifestPath);
  if (layout.settingsFormat === "toml") {
    try {
      return parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return safeReadJson(path);
}

/**
 * Read the `.hooks` field of a settings file in the layout's format — JSON
 * (Claude Code's settings.json) or TOML (Codex's `config.toml` `[hooks]`). A
 * TOML harness's hooks would otherwise be read as zero by the JSON path.
 */
function readSettingsHooks(path: string, format: "json" | "toml"): unknown {
  if (format === "json") return readHooksFile(path);
  try {
    return (parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>)
      .hooks;
  } catch {
    return undefined;
  }
}

/**
 * Read the hooks block, handling the real-world plugin layouts:
 *   1. inline `hooks` object in .claude-plugin/plugin.json,
 *   2. a `hooks` *string* in plugin.json pointing at a hooks JSON file,
 *   3. the `hooks/hooks.json` convention (e.g. obra/superpowers) — auto-discovered,
 *   4. a plain repo's `.claude/settings.json`.
 */
function readHooks(root: string, layout: PluginLayout): unknown {
  // A malformed manifest must not crash the loader — fall through to the
  // other layouts (safeReadManifest returns null on a parse error). Format-aware
  // so a Codex `config.toml` manifest's `[hooks]` is read, not skipped.
  const m = safeReadManifest(root, layout);
  if (m) {
    if (typeof m.hooks === "string") return readHooksFile(join(root, m.hooks));
    if (m.hooks !== undefined) return m.hooks;
  }
  const conventionPath = join(root, layout.hooksConventionPath);
  if (existsSync(conventionPath)) return readHooksFile(conventionPath);

  const settingsPath = join(root, layout.settingsPath);
  if (existsSync(settingsPath))
    return readSettingsHooks(settingsPath, layout.settingsFormat);

  return undefined;
}

/**
 * Recursively collect text files under `dir` as `relativePath → contents`.
 *
 * 🔴 A DIRECTORY SYMLINK IS NOT DESCENDED INTO. `statSync` FOLLOWS a link, so a
 * surface dir containing `self -> ..` (an ancestor, or any backlink inside a
 * linked-in tree) recursed forever. Measured 2026-08-12 on a two-file fixture:
 * `scanPlugin` did not merely slow down, it THREW —
 * `ELOOP: too many symbolic links encountered` out of `readTree`, up through
 * `loadPlugin`, and out of the audit. A link to a large external tree is the
 * quieter half of the same bug: the loader reads a foreign tree into the file map
 * that the entire report is computed from.
 *
 * The decision is {@link entryOf}, which lives in `fs-walk.ts` rather than here.
 * It was shared with `harnessSurfaceFilesOnDisk` in `scan.ts` — the other walk
 * over the same trees, and exactly the kind of pair this repo has been bitten by
 * fixing on only one side — until that walk was deleted with the foreign-runner
 * warning it fed (tombstone in `core/foreign-runner.ts`). That module carries the
 * full rationale: a symlinked FILE is still read (it cannot recurse), and an
 * unreadable entry is skipped rather than thrown, so a dangling link cannot take
 * down an audit.
 *
 * The walk's own ENTRY POINTS are classified by `walkableRoot` at each call site,
 * not here: this function is also the recursion step, and re-checking a directory
 * `entryOf` has already cleared would cost a syscall per directory to answer a
 * question that cannot come out differently.
 */
function readTree(
  dir: string,
  base: string,
  excluded: Excluded = excludesNothing,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `.vigilesrc.json#exclude`, applied HERE — per entry, inside the recursion —
    // and not merely at the surface-dir entry point. A vendored tree is usually
    // excluded at its own root (`bench`, `vendor/corpus`), which is a descendant
    // of a surface dir, so a check that only guarded the walk's start would let
    // every one of its files into the file map the whole report is computed from.
    if (excluded(full)) continue;
    const { kind, size } = entryOf(full);
    if (kind === "dir") Object.assign(out, readTree(full, base, excluded));
    // The cap keeps a stray binary out of the in-memory file map, and the size
    // comes from the SAME stat that classified the entry. Asking a second time
    // needed its own `catch` — reachable only if the file vanished between the two
    // calls — which is dead code the 100% coverage gate could only ever fail on.
    else if (kind === "file" && size <= MAX_SKILL_FILE_BYTES) {
      out[relative(base, full)] = readFileSync(full, "utf-8");
    }
  }
  return out;
}

/**
 * Load the real harness at `pluginPath`. Returns the resolved settings (hooks),
 * the files (CLAUDE.md + skills + agents + commands) to write into the test
 * sandbox, and `warnings` for surfaces the deterministic tier can't drive. Merge
 * `settings` with any inline settings and spread `files` into the fixture.
 */
export function loadPlugin(
  pluginPath: string,
  layout: PluginLayout,
  excludes?: ExcludeSet,
): LoadedPlugin {
  const root = resolve(pluginPath);
  const excluded = excludedBy(excludes);
  const hooks = readHooks(root, layout);
  // Expand the plugin-root token to the real absolute path so the actual hook
  // scripts execute — we test the shipped wiring, not a reimplementation.
  const resolvedHooks = hooks
    ? (JSON.parse(
        JSON.stringify(hooks).replaceAll(layout.pluginRootToken, root),
      ) as unknown)
    : undefined;

  const files: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const instructions = join(root, layout.instructionFile);
  if (existsSync(instructions) && !excluded(instructions)) {
    files[layout.instructionFile] = readFileSync(instructions, "utf-8");
    sources[layout.instructionFile] = instructions;
  }
  const surfaces = materializeSurfaces(root, layout, files, sources, excluded);

  return {
    settings: resolvedHooks ? { hooks: resolvedHooks } : {},
    files,
    sources,
    warnings: pluginWarnings(root, surfaces, resolvedHooks, files, layout),
  };
}

/**
 * Materialize every model surface (skills/agents/commands) into `files`, and
 * record each file's real on-disk path in `sources`. Best-effort (headless
 * activation of plugin skills/subagents/commands is not guaranteed; the body is
 * present to read).
 *
 * EVERY discovery level present is read — the repo-root `<surface>` (the
 * published-plugin / skills-library shape) AND the project-level
 * `<userSurfaceRoot>/<surface>` (the shape a plain Claude Code user has). The
 * loader used to read one OR the other and materialize the winner under the
 * loser's canonical key; `src/core/surface-scopes.ts` carries the measurement
 * that killed that, and the vendor quote that settles which one the harness
 * loads (both, in different namespaces). The KEY now comes from the scope, so
 * two files can no longer claim one. Plus the single-skill-directory case
 * (`<root>/SKILL.md`), so pointing at one skill dir works. Returns the
 * per-surface counts (drives the surface warnings).
 */

/**
 * A surface holds a LOADABLE file — a `<name>/SKILL.md` for skills, a `.md` for
 * agents/commands. A stray non-surface file (`skills/README.md`, `.gitkeep`) does
 * NOT count, else an empty-but-present dir would mark a scope populated.
 */
function surfaceHasLoadable(
  layout: PluginLayout,
  surface: string,
  tree: Record<string, string>,
): boolean {
  const keys = Object.keys(tree);
  return surface === layout.skillDir
    ? keys.some((k) => basename(k) === "SKILL.md")
    : keys.some((k) => k.endsWith(".md"));
}

function materializeSurfaces(
  root: string,
  layout: PluginLayout,
  files: Record<string, string>,
  sources: Record<string, string>,
  excluded: Excluded = excludesNothing,
): MaterializedSurfaces {
  const counts: Record<string, number> = {};
  const isDir = (p: string): boolean =>
    existsSync(p) && statSync(p).isDirectory();
  /**
   * One surface dir's tree, or `{}` when there is nothing to read.
   *
   * `walkableRoot` classifies the walk's ENTRY POINT — `isDir` follows a symlink,
   * so a `skills -> ..` link handed the whole repo (node_modules included) to the
   * file map the entire report is computed from. It is a DIFFERENT rule from the
   * per-entry one and that function says why; a shared skills dir linked in from
   * outside is still read.
   */
  const surfaceTree = (dir: string): Record<string, string> =>
    isDir(dir) && walkableRoot(dir, root) && !excluded(dir)
      ? readTree(dir, dir, excluded)
      : {};
  /** Every surface tree of one scope, read once, keyed by surface dir. */
  const scopeTrees = (base: string): Map<string, Record<string, string>> => {
    const trees = new Map<string, Record<string, string>>();
    for (const surface of layout.surfaceDirs)
      trees.set(surface, surfaceTree(join(root, base, surface)));
    return trees;
  };
  const hasLoadable = (trees: ReadonlyMap<string, Record<string, string>>) =>
    layout.surfaceDirs.some((s) =>
      surfaceHasLoadable(layout, s, trees.get(s) ?? {}),
    );
  const add = (key: string, content: string, onDisk: string): void => {
    files[key] = content;
    sources[key] = onDisk;
  };

  // Both candidate scopes are read ONCE, up front, because the decision needs to
  // know whether each holds anything — and then the same trees are materialized.
  const rootTrees = scopeTrees("");
  const userTrees =
    layout.userSurfaceRoot !== undefined
      ? scopeTrees(layout.userSurfaceRoot)
      : new Map<string, Record<string, string>>();

  /** Copy one scope's already-read trees into `files`, keyed by that scope. */
  const materializeScope = (
    scope: SurfaceScope,
    trees: ReadonlyMap<string, Record<string, string>>,
  ): void => {
    for (const surface of layout.surfaceDirs) {
      const tree = trees.get(surface) ?? {};
      for (const [rel, content] of Object.entries(tree))
        add(
          scopeKey(scope, surface, rel),
          content,
          join(root, scope.base, surface, rel),
        );
      counts[surface] = (counts[surface] ?? 0) + Object.keys(tree).length;
    }
  };

  /**
   * Read the path-scoped RULES dir (`.claude/rules/*.md` on Claude Code).
   *
   * DELIBERATELY NOT a `surfaceDirs` entry, and the distinction is the whole
   * design: `surfaceDirs` decides whether a directory counts as a LOADABLE
   * MACHINE, and rules are instructions, not an invocable surface — folding them
   * in would silently change what "an empty machine" means for every harness.
   * So they are read here, added to `files` for the checks that read text
   * (frontmatter-valid, the rule map), and left out of `counts` and
   * `hasLoadable`. A layout with no `rulesDir` reads nothing and behaves exactly
   * as before. Closes #175.3: a whole instruction layer the audit could not see.
   */
  const materializeRules = (): void => {
    const dir = layout.rulesDir;
    if (!dir) return;
    // Read BOTH candidate bases, and NOT the resolved `scopes`. Rules are not
    // tied to where the invocable surfaces live: a repo can keep its skills at
    // the root (a published plugin) while its rules sit under `.claude/`, and
    // keying off scopes then read the wrong directory and found nothing —
    // measured on exactly that shape while building this.
    //
    // Each base keys at its own real path (`rules/…` and `.claude/rules/…`), so
    // a repo with both loses neither and nothing collides.
    const bases = [
      "",
      ...(layout.userSurfaceRoot !== undefined ? [layout.userSurfaceRoot] : []),
    ];
    for (const base of bases) {
      const tree = surfaceTree(join(root, base, dir));
      for (const [rel, content] of Object.entries(tree))
        add(join(base, dir, rel), content, join(root, base, dir, rel));
    }
  };

  const source = surfaceSource(layout, {
    hasRootSkillFile: existsSync(join(root, "SKILL.md")),
    skillName: basename(root),
    rootHasLoadable: hasLoadable(rootTrees),
    isPluginShaped:
      existsSync(join(root, layout.manifestPath)) ||
      existsSync(join(root, layout.hooksConventionPath)),
    userHasLoadable: hasLoadable(userTrees),
  });

  switch (source.kind) {
    case "single-skill": {
      // Materialize the WHOLE skill dir under the canonical skills key, so its
      // bundled resources (scripts/references/assets) ship too, not just SKILL.md.
      // No `walkableRoot` here on purpose: `root` is the directory the CALLER
      // named (`vigiles audit <dir>`), not one this walk discovered, and refusing
      // to read the path someone explicitly pointed at is not a containment rule.
      const tree = readTree(root, root, excluded);
      for (const [rel, content] of Object.entries(tree)) {
        add(
          join(layout.materializeRoot, layout.skillDir, source.skillName, rel),
          content,
          join(root, rel),
        );
      }
      counts[layout.skillDir] = Object.keys(tree).length;
      return { counts, scopes: [] };
    }
    case "scopes": {
      assertDistinctScopeKeys(source.scopes, layout.name);
      for (const scope of source.scopes)
        materializeScope(scope, scope.base === "" ? rootTrees : userTrees);
      materializeRules();
      return { counts, scopes: source.scopes };
    }
    /* v8 ignore next 2 -- exhaustiveness guard, unreachable given SurfaceSource */
    default:
      return assertNever(source);
  }
}

/**
 * Flag surfaces present-but-not-deterministically-exercisable. Subagents
 * (`agents/`) and slash commands (`commands/`) are materialized into the sandbox
 * but only run under a real model (Task / slash invocation), so they belong to
 * the eval tier. MCP servers aren't wired by the loader at all. And a plugin
 * that yields neither hooks nor files would otherwise be a silent empty machine.
 */
function pluginWarnings(
  root: string,
  { counts, scopes }: MaterializedSurfaces,
  hooks: unknown,
  files: Record<string, string>,
  layout: PluginLayout,
): string[] {
  const warnings: string[] = [];
  const multiScope = multiScopeWarning(scopes, counts);
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
  if (hasMcp(root, layout)) {
    warnings.push(
      `plugin declares MCP server(s) (${layout.mcpManifestKey} / ${layout.mcpConfigFile}) — the loader does not wire MCP; bring the server up yourself if your test needs it.`,
    );
  }
  const dangling = danglingRefs(root, layout);
  if (dangling.length) {
    const shown = dangling.slice(0, 5).join(", ");
    const more =
      dangling.length > 5 ? `, … (+${String(dangling.length - 5)})` : "";
    warnings.push(
      `plugin references ${String(dangling.length)} intra-plugin file(s) that don't exist (broken path / partial vendor): ${shown}${more}`,
    );
  }
  if (!hooks && Object.keys(files).length === 0) {
    warnings.push(
      `nothing was loaded (no hooks, CLAUDE.md, skills, agents, or commands) — the deterministic harness would run an effectively empty machine.`,
    );
  }
  return warnings;
}

/** Whether the plugin declares any MCP servers (manifest key or standalone file).
 *  Format-aware: reads the layout's `mcpManifestKey` from a JSON OR TOML manifest,
 *  so Codex's `[mcp_servers]` TOML table is detected, not silently missed. */
function hasMcp(root: string, layout: PluginLayout): boolean {
  if (existsSync(join(root, layout.mcpConfigFile))) return true;
  return safeReadManifest(root, layout)?.[layout.mcpManifestKey] !== undefined;
}

// A plugin-relative path reference to a file under a standard surface dir, with a
// known extension — e.g. a hook script that `cat`s `skills/using-superpowers/SKILL.md`.
// The extension vocabulary and BOTH token boundaries live in core/source-refs.ts,
// so this and its browser twin (scan-files.ts) cannot disagree on them and
// neither can omit one. See that module for the two boundary defects.
function intraRefRe(layout: PluginLayout): RegExp {
  return intraRefPattern(layout.intraRefDirs);
}

// Shell vars that root a path OUTSIDE the plugin (the user's project / home), so
// a `surface/…` after one is NOT a plugin-root ref. Anything else ($ROOT,
// $PLUGIN_ROOT, ${CLAUDE_PLUGIN_ROOT}, …) is taken as the plugin root.
const NON_PLUGIN_VARS = new Set([
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PROJECT",
  "HOME",
  "PWD",
  "OLDPWD",
]);

/**
 * Is a surface-dir match at `idx` actually rooted at the PLUGIN (so checkable
 * under `root`), vs nested under a literal dir or a project/home var? A match
 * preceded by a literal segment (`.claude/hooks/…` — a PROJECT path, the
 * gmickel/flow-next false positive) or a project var (`$CLAUDE_PROJECT_DIR/…`)
 * is NOT a plugin ref. A bare ref (`cat skills/…`) or one after a plugin-root
 * var (`${PLUGIN_ROOT}/skills/…`, obra/superpowers) IS.
 *
 * 🔴 THE FIRST QUESTION IS WHETHER THE MATCH STARTS AT A PATH BOUNDARY AT ALL.
 * "Not preceded by a slash" used to be read as "bare reference", which made
 * `claude-agents/fable-advisor.md` a bare reference to `agents/fable-advisor.md`
 * — a resolving path reported broken (`fcakyon/claude-codex-settings`,
 * 2026-08-17). A preceding path-segment character means the match landed inside
 * a longer name, which is not a reference to anything.
 */
function isPluginRooted(content: string, idx: number): boolean {
  // No `idx === 0` case: start-of-content IS a boundary, and that rule belongs
  // to `startsAtSeparator` (`idx <= 0 → true`), which the next line reaches with
  // `content[-1] === undefined`. Restating it here would be a second copy of a
  // boundary this module deliberately does not own.
  if (content[idx - 1] !== "/") return startsAtSeparator(content, idx);
  // The path component immediately before the separating slash.
  const seg = /([^\s"'`(=:/]*)$/.exec(content.slice(0, idx - 1))?.[1] ?? "";
  const varName = /^\$\{?(\w+)\}?$/.exec(seg)?.[1];
  if (varName !== undefined) return !NON_PLUGIN_VARS.has(varName); // a var root
  return false; // a literal dir segment → nested, not a plugin-root ref
}

// Documentation files (skill bodies, command docs, reference notes) are PROSE —
// a `skills/foo/SKILL.md` path inside them is almost always an example, a
// template placeholder (`wc -w skills/path/SKILL.md`), or a "❌ Bad" sample, not
// a real file operation. Scanning them produced near-100% false positives across
// real plugins (wshobson/agents, obra/superpowers), so we skip them as SOURCES.
// A path in an executable hook/helper script (incl. extensionless ones like
// obra/superpowers' `hooks/session-start`) IS a real file op — those we scan.
const DOC_SOURCE_RE = /\.(?:md|markdown|mdx|txt|rst)$/i;

/**
 * Intra-plugin file references that don't resolve — the partial-vendor / broken-
 * path class (e.g. obra/superpowers' `hooks/session-start` reads
 * `skills/using-superpowers/SKILL.md`, which a sliced vendor snapshot omits). We
 * scan the plugin's own EXECUTABLE files under the surface dirs (hook/helper
 * scripts — those aren't materialized into `files`) for root-relative path refs
 * and report the ones missing on disk. Documentation sources are deliberately
 * excluded (see `DOC_SOURCE_RE`) — a path in prose is undecidably ref-or-example,
 * the same heuristic-scanning anti-pattern reference verification rejects. A
 * static check that would have caught a bug the dogfood hit twice. Best-effort:
 * a warning, not an error.
 */
/**
 * Whether ref `ref` (a matched intra-plugin path) resolves under `root` — the
 * direct plugin-relative reading first, then, as a fallback (issue #110), a
 * REPO-CHECKOUT-RELATIVE reading: a usage comment/echo written as it would run
 * from the repo root (`skills/<plugin>/hooks/setup.sh`) echoes the PLUGIN'S OWN
 * containing surface dir + directory name ahead of the real plugin-relative
 * path (`hooks/setup.sh`) — joining that straight onto `root` double-roots it
 * and always misses. When the ref's first two segments are `<surfaceDir>/<name>`
 * and `<name>` is this plugin's own directory name, strip them and retry. BOTH
 * readings must miss before we call it dangling, so a genuinely broken ref is
 * never masked by the fallback.
 */
function resolvesUnderRoot(ref: string, root: string): boolean {
  if (existsSync(join(root, ref))) return true;
  const segs = ref.split("/");
  if (segs.length > 2 && segs[1] === basename(root)) {
    const rest = segs.slice(2).join("/");
    if (rest.length > 0 && existsSync(join(root, rest))) return true;
  }
  return false;
}

/** Path refs in `content` (matched by `re`) that don't resolve under `root`. */
function missingRefsIn(content: string, re: RegExp, root: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(re)) {
    if (m.index !== undefined && !isPluginRooted(content, m.index)) continue;
    if (!resolvesUnderRoot(m[0], root)) out.push(m[0]);
  }
  return out;
}

/** The plugin's executable (non-prose) source files under the surface dirs. */
function executableSources(
  root: string,
  layout: PluginLayout,
): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const surface of layout.intraRefDirs) {
    const dir = join(root, surface);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    if (!walkableRoot(dir, root)) continue; // the walk's entry point, see fs-walk
    for (const [path, content] of Object.entries(readTree(dir, root))) {
      if (DOC_SOURCE_RE.test(path)) continue; // skip prose
      // A full-line comment is prose in EVERY language, not only in shell —
      // both remaining corpus false positives here came out of JSDoc. See
      // core/source-refs.ts.
      sources[path] = stripFullLineComments(path, content);
    }
  }
  return sources;
}

export function danglingRefs(root: string, layout: PluginLayout): string[] {
  const re = intraRefRe(layout);
  const missing = new Set<string>();
  for (const content of Object.values(executableSources(root, layout))) {
    for (const ref of missingRefsIn(content, re, root)) missing.add(ref);
  }
  return [...missing];
}

type HooksObj = { hooks?: Record<string, unknown[]> };

/**
 * Merge a loaded plugin's settings with inline settings. Inline wins; when both
 * declare hooks, the per-event arrays are concatenated (plugin hooks first), so
 * a test can layer an extra hook on top of the real plugin. Returns `undefined`
 * when neither side has hooks (so the caller skips `--settings`).
 */
function mergeSettings(base: { hooks?: unknown }, override: unknown): unknown {
  const baseHasHooks = base.hooks !== undefined;
  if (override === undefined) return baseHasHooks ? base : undefined;
  if (!baseHasHooks) return override;
  const b = base as HooksObj;
  const o = override as HooksObj;
  const events = new Set([
    ...Object.keys(b.hooks ?? {}),
    ...Object.keys(o.hooks ?? {}),
  ]);
  const hooks: Record<string, unknown[]> = {};
  for (const e of events) {
    hooks[e] = [...(b.hooks?.[e] ?? []), ...(o.hooks?.[e] ?? [])];
  }
  return { ...o, hooks };
}

/**
 * Resolve the effective harness for a test/eval (arm): load the plugin if given,
 * then layer inline settings + files on top. Shared by `runHarnessTest` and
 * `runEval` so both test the assembled machine the same way. `layout` is
 * REQUIRED (no harness default at the composition root) — the Claude Code
 * wrapper supplies `claudeCodeLayout` to preserve `resolveHarness(opts)`.
 */
export function resolveHarness(
  opts: {
    plugin?: string;
    settings?: unknown;
    files?: Record<string, string>;
  },
  layout: PluginLayout,
): { settings: unknown; files: Record<string, string> } {
  const loaded = opts.plugin
    ? loadPlugin(opts.plugin, layout)
    : { settings: {}, files: {} };
  return {
    files: { ...loaded.files, ...opts.files },
    settings: mergeSettings(loaded.settings, opts.settings),
  };
}
