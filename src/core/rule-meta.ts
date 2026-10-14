/**
 * TRANSITIONAL — the last piece of the old rule-meta registry, kept only until
 * the experimental block is rendered from the group record (the next commit of
 * PR #387 removes this file). The registry itself is now the rule set in
 * `src/rules/`, which `src/rules/index.test.ts` binds to this list.
 */
/**
 * The **`experimental`** rule GROUP — checks vigiles ships but has not measured
 * as reliable enough to grade anyone on: their MEASURED precision on real public
 * repositories is below the bar a default-on rule must clear. The fourth group
 * beside the three confidence groups (`structural` = `vigiles:recommended`,
 * `workflow` = `init --strict`, `nudge`); one group owns each rule.
 *
 * What membership means, everywhere at once:
 *
 * - OFF by default (`defaultSeverity: "off"`; `rule-meta.test.ts` holds it).
 * - Turned on ONLY when asked: the `vigiles:experimental` preset, from config
 *   (`"extends"`) or for one run (`audit`/`lint --preset=experimental`), sets the
 *   whole group to `warn`; a `rules` entry turns one rule on. Nothing vigiles
 *   writes raises one to `error` — not `init`, not `--strict`.
 * - NEVER in the audit score. The scan keeps the group's findings under
 *   `ScanReport.experimental`, apart from every field a grader reads, so an
 *   experimental finding cannot move a ring, the overall, the grade or the
 *   verdict even when it is shown. When on, `audit` lists it in a separate
 *   "Experimental — not graded" block on every surface.
 *
 * Adding a rule here is one line, plus moving its scan findings under
 * `ScanReport.experimental` — the mapped type there will not compile until
 * every rule in this list has a findings shape, and its old graded field stops
 * existing, so every grader that read it fails to compile too.
 */
export const EXPERIMENTAL_RULES = ["skill-resource-resolves"] as const;

/** A rule in the {@link EXPERIMENTAL_RULES} group. */
export type ExperimentalRuleName = (typeof EXPERIMENTAL_RULES)[number];

/** Whether `id` names a rule in the experimental group. */
export function isExperimentalRule(id: string): id is ExperimentalRuleName {
  return EXPERIMENTAL_RULES.some((r) => r === id);
}
