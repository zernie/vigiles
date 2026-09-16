/**
 * The invariant that was missing when `Agent` sat in two catalogs at once.
 *
 * A `HarnessDialect` carries several name lists that describe the SAME
 * vocabulary from different angles — `builtinAgentTools` (declarable),
 * `neverAvailableTools` (dead), `sideEffectingTools` (a subset of declarable).
 * Nothing checked that they agreed. So `Agent` could be listed as
 * never-available while its own alias `Task` sat in the built-in catalog, and
 * `dialect-drift.ts` could read `Agent` out of the vendor's shipped
 * `sdk-tools.d.ts` every run, for months, without anything noticing the
 * contradiction. The lists were consistent with nothing, including each other.
 *
 * These checks are cheap, total, and adapter-agnostic, so they run in the
 * adapter conformance kit — every adapter, present and future, third-party
 * included. A dialect that contradicts itself now fails LOUDLY at the point an
 * author would first run the kit, instead of silently producing a confident
 * wrong finding in someone else's repo.
 *
 * Deliberately NOT here: any judgement about whether a name is *correct*. This
 * cannot tell you the platform renamed `Task` to `Agent` — only that you cannot
 * claim both at once. Freshness against the real platform is
 * `dialect-drift.ts`'s job; agreement between our own claims is this one's.
 */
import type { HarnessDialect } from "./dialect.js";
import type { HarnessVocabulary } from "./vocabulary.js";

/** Human-readable violations of the dialect's internal name invariants. */
export function dialectVocabularyProblems(dialect: HarnessDialect): string[] {
  const problems: string[] = [];
  const builtin = new Set(dialect.builtinAgentTools);
  const never = new Set(dialect.neverAvailableTools);

  // The exact state that shipped: a name claimed as both declarable and dead.
  for (const tool of never)
    if (builtin.has(tool))
      problems.push(
        `tool "${tool}" is in BOTH builtinAgentTools and neverAvailableTools — ` +
          `it cannot be both declarable and never available`,
      );

  // A side-effecting tool outside the catalog can never be reached by
  // `classifyToolEffect` (rule 1 only fires for names rule 2 could see), so the
  // entry is dead weight that reads as protection.
  for (const tool of dialect.sideEffectingTools ?? [])
    if (!builtin.has(tool))
      problems.push(
        `tool "${tool}" is in sideEffectingTools but not in builtinAgentTools — ` +
          `the effect classification can never reach it`,
      );

  // A block-semantics subset that names an event the dialect doesn't fire is a
  // rule about nothing.
  const events = new Set(dialect.hookEvents);
  // 🔴 READ THE DECLARED FIELDS, not the effective answer. This check is about
  // junk IN a dialect's own declarations, so routing it through the
  // capability-table readers (which prefer the table) made it stop looking at
  // the very field it polices — caught by `vocabulary.test.ts` the moment the
  // Claude Code dialect gained a table. The readers are for CONSUMERS asking
  // "what does this harness do?"; a consistency check is not one of those.
  /* eslint-disable @typescript-eslint/no-deprecated -- policing the legacy
     fields themselves is this function's entire job. */
  for (const [field, list] of [
    ["noEffectHookEvents", dialect.noEffectHookEvents ?? []],
    [
      "permissionDecisionHookEvents",
      dialect.permissionDecisionHookEvents ?? [],
    ],
    ["eventCapabilities", Object.keys(dialect.eventCapabilities?.events ?? {})],
  ] as const)
    for (const event of list)
      if (!events.has(event))
        problems.push(
          `hook event "${event}" is in ${field} but not in hookEvents — ` +
            `it describes an event this dialect says never fires`,
        );
  /* eslint-enable @typescript-eslint/no-deprecated */

  return problems;
}

/**
 * When a dialect declares a vocabulary, its legacy name lists must be exactly
 * that vocabulary's projections. This is what stops the two from drifting once
 * both exist: a dialect can carry the richer catalog AND the flat arrays other
 * code still reads, but it cannot let them disagree.
 */
export function vocabularyProjectionProblems(
  vocab: HarnessVocabulary,
  builtinAgentTools: readonly string[],
  neverAvailableTools: readonly string[],
): string[] {
  const problems: string[] = [];
  const declarable = new Set(
    vocab.terms.filter((t) => t.status !== "withheld").map((t) => t.name),
  );
  const withheld = new Set(
    vocab.terms.filter((t) => t.status === "withheld").map((t) => t.name),
  );

  const diff = (
    label: string,
    expected: ReadonlySet<string>,
    actual: readonly string[],
  ): void => {
    const got = new Set(actual);
    for (const n of expected)
      if (!got.has(n))
        problems.push(
          `${label} is missing "${n}", which the vocabulary declares`,
        );
    for (const n of got)
      if (!expected.has(n))
        problems.push(
          `${label} has "${n}", which the vocabulary does not declare`,
        );
  };

  diff("builtinAgentTools", declarable, builtinAgentTools);
  diff("neverAvailableTools", withheld, neverAvailableTools);

  // A conditional term with no condition cannot be reported as one — the whole
  // reason the status exists is to quote the platform's qualifier back.
  for (const t of vocab.terms)
    if (t.status === "conditional" && (t.condition ?? "").trim() === "")
      problems.push(
        `term "${t.name}" is conditional but states no condition — ` +
          `a condition we cannot quote is one we cannot report`,
      );

  // An alias pointing at a name the vocabulary doesn't hold sends the reader
  // somewhere that doesn't exist.
  for (const t of vocab.terms)
    if (
      t.aliasOf !== undefined &&
      !vocab.terms.some((o) => o.name === t.aliasOf)
    )
      problems.push(
        `term "${t.name}" is an alias of "${t.aliasOf}", which this vocabulary ` +
          `does not contain`,
      );

  // Two entries for one name make `classify` order-dependent.
  const seen = new Set<string>();
  for (const t of vocab.terms) {
    if (seen.has(t.name))
      problems.push(
        `term "${t.name}" appears more than once in the vocabulary`,
      );
    seen.add(t.name);
  }

  return problems;
}
