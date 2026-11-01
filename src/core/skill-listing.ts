/**
 * The skill listing: the block of one-line skill entries a harness puts into
 * every session before the model has made a single decision, so the model can
 * pick a skill by its description.
 *
 * WHY IT IS PART OF THE ALWAYS-LOADED CONTEXT. Each listed skill costs its entry on
 * every request of every session, whether or not it is ever invoked — the same
 * property that makes the instruction file a cost. A description moved out of
 * `CLAUDE.md` into a skill's frontmatter still loads at session start, so a
 * weight that counts the instruction file and not the listing rewards a move
 * that changes nothing (`./instruction-weight.ts` explains the same evasion for
 * split instruction files).
 *
 * The core knows only that idea. How one entry is rendered — which keys it
 * reads, the per-entry cap, which settings hide a skill — is each harness's own
 * format, given by its dialect as {@link SkillListingRules}. A dialect without
 * it is a harness whose listing vigiles does not model; that is a different
 * fact from "this harness lists nothing", and the always-loaded report keeps
 * the two apart.
 */

/** One skill as the harness would list it, read once by the core. */
export interface ListedSkill {
  /** The SKILL.md path, relative to the scanned directory, `/`-separated. */
  readonly path: string;
  /** The skill's directory name — the fallback name when frontmatter has none. */
  readonly dirName: string;
  /**
   * The parsed frontmatter mapping (`{}` when the file has no block). `null`
   * when a block exists and is not valid YAML: the harness decides what such a
   * file does, so the core does not guess a salvaged value for it.
   */
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  /** The markdown body, frontmatter removed. */
  readonly body: string;
}

/** How one harness renders a skill into its session-start listing. */
export interface SkillListingRules {
  /**
   * The entry exactly as the harness renders it, its own per-entry cap
   * applied — or `null` when the harness does not list this skill at all.
   * `settings` is the COMMITTED settings object (parsed by the layout's codec,
   * `{}` when there is none), because a listing setting there changes what
   * every teammate's session loads.
   */
  readonly entry: (
    skill: ListedSkill,
    settings: Readonly<Record<string, unknown>>,
  ) => string | null;
  /** The vendor artifact this was read from, version included. */
  readonly capturedFrom: string;
  /**
   * The size of the listing as a WHOLE past which the harness drops skill
   * descriptions, so some skills lose the text they trigger on. Absent when
   * the adapter does not model one — a different fact from "no limit".
   */
  readonly budget?: SkillListingBudget;
}

/** The listing's budget for one commit: the harness default, or a committed setting. */
export interface ListingLimit {
  /** In the harness's unit (the instruction budget's `unit`). */
  readonly limit: number;
  /** The committed setting that moved it off the default, when one did. */
  readonly setBy?: string;
}

/** How a harness sizes its whole skill listing. */
export interface SkillListingBudget {
  /**
   * The limit a session on this commit gets, from the COMMITTED settings
   * (`{}` when there are none). Per-machine environment variables that move
   * it are not a property of the commit and are not read.
   */
  readonly limit: (settings: Readonly<Record<string, unknown>>) => ListingLimit;
  /** The vendor artifact this was read from, version included. */
  readonly capturedFrom: string;
}
