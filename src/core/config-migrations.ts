/**
 * The configs that USED TO WORK — keys and rules whose shape changed, and the
 * sentence each one gets instead of the schema's "unknown key".
 *
 * Read BEFORE the schema (`./validate.ts` `loadConfig`): the reader of these
 * messages is someone whose config was valid in an earlier release, so
 * `.strict()`'s "Unrecognized key" would be true and useless — they need the
 * new spelling. Kept apart from `./config-schema.ts`, which describes the
 * config as it is today; this file describes how it got here.
 */

/**
 * The two keys `harnesses` replaced, and the sentence each one gets (#240).
 *
 * They are listed here rather than left to `.strict()`'s "Unrecognized key"
 * because the reader of that message is someone whose config USED to work: they
 * need the new spelling, not the news that the old one is unknown. `.strict()`
 * would tell them the truth in the least useful possible way.
 */
export const REPLACED_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly was: string;
  readonly now: string;
}> = [
  {
    key: "harness",
    // The literal OLD config text this migration notice quotes back at the user:
    // a historical artefact, not a fact about a harness, so there is no port to
    // read it off. This is the one exemption here that is not debt.
    // eslint-disable-next-line local/no-harness-names -- quoted legacy config
    was: '"harness": ["claude-code", "codex"]',
    now: "a KEY per harness",
  },
  {
    key: "surfaceRoots",
    was: '"surfaceRoots": [".ai"]',
    now: '"roots" INSIDE the harness that reads them',
  },
];

/**
 * The message a config written in the replaced shape gets.
 *
 * `names` are the harnesses the user's OWN config named under the removed
 * `harness` key, so the worked example below shows THEIR migration.
 *
 * 🔴 IT USED TO BE A FIXED EXAMPLE — `{ "harnesses": { "claude-code": …,
 * "codex": {} } }`, two names typed into the core. Its own comment called that
 * debt and predicted the failure: "with a third adapter this sample goes
 * stale". Reading the names from the config being migrated is better than
 * reading them from the registry would have been, and it is available here:
 * it shows the reader their own keys instead of somebody else's.
 */
export function replacedKeyMessage(
  present: ReadonlyArray<(typeof REPLACED_KEYS)[number]>,
  names: readonly string[],
): string {
  // Empty when the config used only `surfaceRoots`, or named no harness — a
  // placeholder the reader will obviously replace, never an invented name.
  const example = (names.length > 0 ? names : ["<harness>"])
    .map((n, i) => `"${n}": ${i === 0 ? '{ "roots": [".ai"] }' : "{}"}`)
    .join(", ");
  return (
    `.vigilesrc.json: ${present.map((k) => `"${k.key}"`).join(" and ")} ` +
    `${present.length === 1 ? "was" : "were"} replaced by one nested key, "harnesses".\n` +
    `  Write:  { "harnesses": { ${example} } }\n` +
    present.map((k) => `  - ${k.was}  →  ${k.now}`).join("\n") +
    `\n  The old harness ARRAY's order silently decided what got read: one order graded the ` +
    `skills and read no instruction file, the other read the instruction file and found no ` +
    `skills. Scoping each root under the harness that reads it removes the order.`
  );
}

/**
 * The per-rule `exclude` options that became `overrides`, and the rules an
 * equivalent override turns off. `untested-*` shared ONE merged option set, so
 * an `exclude` on any of them skipped those paths for all four.
 */
export const MOVED_TO_OVERRIDES: ReadonlyArray<{
  /** Where the option sat: a rule name, or the `orphans` block. */
  readonly owner: string;
  /** The rules the equivalent override turns off. */
  readonly rules: readonly string[];
}> = [
  ...[
    "untested-skill",
    "untested-subagent",
    "untested-hook",
    "untested-output-style",
  ].map((owner, _i, all) => ({ owner, rules: all })),
  { owner: "orphans", rules: ["orphan-docs"] },
];

/** A plain JSON object, narrowed without a cast. */
function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `exclude` an old config wrote under `owner`, as a glob list, if any. */
function movedExclude(raw: unknown, owner: string): readonly string[] | null {
  if (!isRecord(raw)) return null;
  const value = isRecord(raw.rules) ? raw.rules[owner] : undefined;
  const tuple: readonly unknown[] = Array.isArray(value) ? value : [];
  const holder = owner === "orphans" ? raw.orphans : tuple[1];
  if (!isRecord(holder) || holder.exclude === undefined) return null;
  const globs = [holder.exclude].flat();
  return globs.filter((g): g is string => typeof g === "string");
}

/**
 * The message an old config with a per-rule `exclude` gets — the user's OWN
 * globs, written as the `overrides` entry that does what the option did.
 *
 * Read BEFORE the schema, like {@link REPLACED_KEYS}: the reader's config used
 * to work, so "unknown key exclude" would be true and useless.
 */
export function movedToOverridesMessages(raw: unknown): readonly string[] {
  return MOVED_TO_OVERRIDES.flatMap(({ owner, rules }) => {
    const globs = movedExclude(raw, owner);
    if (globs === null) return [];
    const files = globs.map((g) => JSON.stringify(g)).join(", ");
    const off = rules.map((r) => `"${r}": "off"`).join(", ");
    return [
      `.vigilesrc.json: "exclude" inside "${owner}" moved to "overrides" — skipping paths is not a rule option any more; an override turns the rule off for them.\n` +
        `  Write:  "overrides": [{ "files": [${files}], "rules": { ${off} } }]\n` +
        `  and remove "exclude" from "${owner}". Paths top-level "exclude" removes are not read at all; an override only changes what a rule reports.`,
    ];
  });
}

/** Rules whose findings another rule now reports, and what changed. */
export const FOLDED_RULES: ReadonlyArray<{
  readonly rule: string;
  readonly into: string;
  readonly what: string;
}> = [
  {
    rule: "prefer-compiled-hooks",
    into: "hand-written-hook",
    what: "every hook line vigiles did not write is now one hand-written-hook finding that names it",
  },
];

/**
 * The message a config naming a folded rule gets — in `rules` or in an
 * `overrides` entry. Read BEFORE the schema, like {@link REPLACED_KEYS}: the
 * reader's config used to work, so "unknown key" would be true and useless.
 */
export function foldedRuleMessages(raw: unknown): readonly string[] {
  if (!isRecord(raw)) return [];
  const overrides: readonly unknown[] = Array.isArray(raw.overrides)
    ? raw.overrides
    : [];
  const ruleBlocks = [
    raw.rules,
    ...overrides.map((o) => (isRecord(o) ? o.rules : undefined)),
  ];
  return FOLDED_RULES.filter(({ rule }) =>
    ruleBlocks.some((b) => isRecord(b) && rule in b),
  ).map(
    ({ rule, into, what }) =>
      `.vigilesrc.json: rule "${rule}" was folded into "${into}": ${what}.\n` +
      `  Remove "${rule}"; set "${into}" to change how those findings report.`,
  );
}
