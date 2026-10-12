/**
 * Root-relative globs as `.vigilesrc.json` spells them — THE one glob semantics
 * for the config's path lists: top-level `exclude` (`src/exclude.ts`) and
 * `overrides[].files` (`./overrides.ts`) both match through this, so "which
 * paths does this pattern cover" cannot differ between the two.
 *
 * The rules: a path is relative to the repository root (where `.vigilesrc.json`
 * lives), `\` and a leading `./` are normalized away, dotfiles match, and a
 * bare directory name covers its subtree (`bench` → `bench`, `bench/**`), as
 * tsconfig and ESLint read it.
 */
import { Minimatch } from "minimatch";
import { sep } from "node:path";

/** `a\b\c` → `a/b/c`, drop a leading `./`, drop a trailing `/`. */
export function normalizeRel(rel: string): string {
  const slashed = rel
    .split(sep)
    .join("/")
    .replace(/^(?:\.\/)+/, "");
  return slashed.replace(/\/+$/, "");
}

/**
 * The first pattern that covers a root-relative path, or `null` — the matcher
 * for a list of root-relative globs. A path outside the root (`../x`) and the
 * root itself are covered by nothing.
 */
export function rootGlobMatcher(
  patterns: readonly string[],
): (rel: string) => string | null {
  const compiled = patterns
    .map(normalizeRel)
    .filter((p) => p !== "")
    .map((p) => ({
      pattern: p,
      self: new Minimatch(p, { dot: true }),
      subtree: new Minimatch(`${p}/**`, { dot: true }),
    }));
  return (rel) => {
    const r = normalizeRel(rel);
    if (r === "" || r === "." || r.startsWith("../")) return null;
    return (
      compiled.find((c) => c.self.match(r) || c.subtree.match(r))?.pattern ??
      null
    );
  };
}
