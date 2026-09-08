/**
 * The ONE exclusion policy for every walk that polices the user's repository (#192) — the parsed `.vigilesrc.json#exclude` as an `ExcludeSet`, built ONCE where `loadConfig()` runs and taken as a REQUIRED parameter by every in-scope discovery (`findSpecs`, `findInstructionFiles`, `discoverNestedBundles`, `collectDocumentedRules`, `gatherInstructionFiles` in cli.ts; the string face handed to `findDocRefs`, `findOrphanDocs` (`repoExclude`), `findUntestedSurfaces`/`skillTestNudge`, `discoverScripts`, `computeScriptCoverage`).
 * Two faces: `globIgnore` (an `IgnoreLike` keyed on the path's position relative to the REPO root, so a glob rooted below it — `vigiles lint some/dir` — still applies a root-relative exclude) and `ignore` (the normalized string list for pure core detectors that glob from the root).
 * A bare directory name excludes its subtree, as tsconfig/ESLint do — measured 2026-09-03: glob's own string `ignore` treated `bench` and `bench/` as matching NOTHING while the minimatch helper in `discoverNestedBundles` accepted them, so the two walks that honoured `exclude` disagreed.
 * The floor (node_modules/dist/.git/.vigiles) lives here, not per walk.
 * `exclude` filters DISCOVERY only: an explicitly named path is processed and ONE line names the pattern it matched (rg/tsc semantics with ESLint's loudness; never prettier's silent 'all clean').
 * Rule-level `orphans.exclude` / `untested-*` `exclude` NARROW (union with the floor), never override.
 * The header carries the exception table — `validateGlobRef` (reference verification), `specReferencedElsewhere` (eject safety), `expandGlobs` (a typed argument), surface walks inside a bundle, and internal machinery — so the next reader does not 'fix' them.
 * Enforced by the ESLint discovery guard (eslint.config.mjs: `globSync` without `ignore`, a literal in an ignore list, a raw `readdirSync` in cli.ts) and the source gate in exclude-cli.test.ts
 */
import { Minimatch } from "minimatch";
import { relative, sep } from "node:path";
import type { IgnoreLike } from "glob";

/** Always excluded, whatever the config says. Root-relative, like `exclude`. */
export const EXCLUDE_FLOOR: readonly string[] = [
  "node_modules/**",
  "dist/**",
  ".git/**",
  ".vigiles/**",
];

/** The parsed `.vigilesrc.json#exclude`, in the forms a walk consumes. */
export interface ExcludeSet {
  /** Absolute repo root every pattern is relative to. */
  readonly root: string;
  /** The user's patterns, as written (for messages). */
  readonly patterns: readonly string[];
  /**
   * The string-list face for a glob rooted AT `root`: the floor, then each user
   * pattern normalized so a bare directory name excludes its subtree (`bench` →
   * `bench`, `bench/**`), which is what "tsconfig-style" promises.
   */
  readonly ignore: readonly string[];
  /** The function face for `globSync`, correct whatever the glob's `cwd` is. */
  readonly globIgnore: IgnoreLike;
  /** Is this root-relative path excluded (floor or user pattern)? */
  matches(rel: string): boolean;
  /** The pattern that excludes this root-relative path, or null when none does. */
  explain(rel: string): string | null;
}

/** `a\b\c` → `a/b/c`, drop a leading `./`, drop a trailing `/`. */
function normalizeRel(rel: string): string {
  let r = rel
    .split(sep)
    .join("/")
    .replace(/^(?:\.\/)+/, "");
  while (r.endsWith("/")) r = r.slice(0, -1);
  return r;
}

/** Parse `.vigilesrc.json#exclude` once, against `root`. */
export function excludeSet(
  root: string,
  patterns: readonly string[] | undefined,
): ExcludeSet {
  const user = (patterns ?? []).map(normalizeRel).filter((p) => p !== "");
  const all = [...EXCLUDE_FLOOR, ...user];
  // One compiled matcher pair per pattern: the pattern itself and its subtree.
  const compiled = all.map((p) => ({
    pattern: p,
    self: new Minimatch(p, { dot: true }),
    subtree: new Minimatch(`${p}/**`, { dot: true }),
  }));
  const explain = (rel: string): string | null => {
    const r = normalizeRel(rel);
    if (r === "" || r === "." || r.startsWith("../")) return null;
    for (const c of compiled) {
      if (c.self.match(r) || c.subtree.match(r)) return c.pattern;
    }
    return null;
  };
  const matches = (rel: string): boolean => explain(rel) !== null;
  const relOf = (p: { fullpath(): string }): string =>
    normalizeRel(relative(root, p.fullpath()));
  return {
    root,
    patterns: user,
    ignore: [...EXCLUDE_FLOOR, ...user.flatMap((p) => [p, `${p}/**`])],
    globIgnore: {
      ignored: (p) => matches(relOf(p)),
      childrenIgnored: (p) => matches(relOf(p)),
    },
    matches,
    explain,
  };
}
