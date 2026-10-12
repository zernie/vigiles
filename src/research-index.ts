/**
 * Research-index completeness — the deterministic FLOOR keeping the `research/`
 * corpus and its index (`research/CLAUDE.md.spec.ts`) in sync. The spec's
 * `file()` references are the AGENT-FACING index of every research doc; the
 * compiler already verifies the OTHER direction (every referenced path EXISTS,
 * else `vigiles compile` fails), so the only open gap is a doc that was ADDED but
 * never indexed. This check closes it: every `research/*.md` (except the
 * human-facing `README.md`) must appear in the index, or the dogfood test fails.
 *
 * Pure — the caller supplies the doc filenames and the index content (the spec
 * source, where an entry is AUTHORED), so it runs over the real `research/` dir
 * in a test or over any file set. Bidirectional sync = compiler (index ⊆ docs)
 * + this check (docs ⊆ index).
 */

/** Docs that are the index itself / human front-door, not indexed entries. */
export const INDEX_EXEMPT = ["README.md"] as const;

/**
 * Research doc basenames (e.g. `roadmap.md`) NOT referenced anywhere in
 * `indexContent`. A doc counts as indexed if its repo-relative path
 * (`research/<name>.md`) appears in the index — the exact form a `file()`
 * reference takes. Exempt docs (the README) are never flagged.
 */
export function unindexedResearchDocs(
  docFilenames: readonly string[],
  indexContent: string,
  exempt: readonly string[] = INDEX_EXEMPT,
): string[] {
  return docFilenames.filter(
    (name) =>
      !exempt.includes(name) && !indexContent.includes(`research/${name}`),
  );
}

/**
 * Index entries pointing at a `research/<name>.md` that no longer exists on
 * disk. The compiler catches this at compile time (a missing `file()` path is
 * a compile error), so this is a belt-and-suspenders reader for a test that
 * wants to assert it directly without invoking the compiler.
 */
export function deadIndexEntries(
  docFilenames: readonly string[],
  indexContent: string,
): string[] {
  const present = new Set(docFilenames);
  const refs = indexContent.matchAll(/research\/([\w.-]+\.md)/g);
  const dead = new Set<string>();
  for (const m of refs) {
    const name = m[1];
    if (!present.has(name)) dead.add(name);
  }
  return [...dead];
}
