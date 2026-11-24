/**
 * Entries renamed since a base that still carries their old key, new -> old.
 * A renamed entry keeps its row's history, so it is compared against the old
 * row instead of looking like a brand-new entry (which must start with no
 * grandfathered names). Only a real rename belongs here: `./hook/testing` is a
 * MERGE of two entries (both with empty lists), so it is deliberately absent and
 * is judged as new, which is the right verdict. Added in v51; delete the rows
 * once a release has shipped with the new keys.
 */
export const RENAMED_ENTRIES = Object.freeze({
  "./harness/claude-code": "./claude-code",
  "./harness/codex": "./codex",
  "./harness/kit": "./adapter",
});

/**
 * The shrink-only half of the function budget (`api-surface/budget.json`).
 *
 * `scripts/export-gates.test.ts` checks the budget against the CURRENT exports,
 * but it cannot tell a grandfathered name that was always there from one a PR
 * added in the same commit as the export it excuses: both pass the count. Only
 * the base branch's copy of the file can say which names were grandfathered
 * before. This compares the two.
 *
 * @param {{ entries: Record<string, { ceiling: number, grandfathered: string[] }> }} base
 * @param {{ entries: Record<string, { ceiling: number, grandfathered: string[] }> }} head
 * @returns {string[]} one line per violation; empty when the budget only shrank
 */
export function budgetShrinkViolations(base, head) {
  const out = [];
  for (const [entry, row] of Object.entries(head.entries)) {
    const before =
      base.entries[entry] ?? base.entries[RENAMED_ENTRIES[entry] ?? ""];
    if (!before) {
      if (row.grandfathered.length > 0) {
        out.push(
          `${entry}: a new entry starts with no grandfathered names (got ${row.grandfathered.join(", ")})`,
        );
      }
      continue;
    }
    const added = row.grandfathered.filter(
      (name) => !before.grandfathered.includes(name),
    );
    if (added.length > 0) {
      out.push(
        `${entry}: grandfathered may only shrink, but ${added.join(", ")} ${added.length === 1 ? "was" : "were"} added`,
      );
    }
    if (row.ceiling > before.ceiling) {
      out.push(
        `${entry}: ceiling may only fall, but it rose from ${String(before.ceiling)} to ${String(row.ceiling)}`,
      );
    }
  }
  return out;
}
