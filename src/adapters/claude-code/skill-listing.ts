/**
 * How Claude Code renders a skill into the listing it loads at session start.
 *
 * MODELLED ON THE PINNED VERSION, `VALIDATED_CC_VERSION` in `dialect-drift.ts`
 * (2.1.187) — the version the dialect is validated against and the one CI
 * installs, so `skill-listing-delivery.test.ts` proves these rules against the
 * binary on every run. Read from https://code.claude.com/docs/en/skills
 * (fetched 2026-10-31) and measured against the mock model:
 *
 *   - the LABEL is the skill's directory name, whatever the frontmatter `name`;
 *   - the text is the `description`, else the first non-empty line of the
 *     body, else the word `Skill`, trimmed; `when_to_use` "is appended to
 *     `description` … and counts toward the 1,536-character cap", joined by
 *     ` - `;
 *   - nothing else is rewritten: `<`, `>`, `&` and control characters reach
 *     the model as written;
 *   - the CAP applies to the combined text: over 1,536 UTF-16 units (or
 *     `skillListingMaxDescChars`), the first cap−1 units are kept and `…`
 *     appended — a cut that can split a surrogate pair, as Claude Code's does;
 *   - `disable-model-invocation: true` "removes the skill from Claude's context
 *     entirely";
 *   - `skillOverrides` is keyed by the DIRECTORY name (a key equal to the
 *     frontmatter name does nothing): `"name-only"` lists `- dir` alone,
 *     `"off"` and `"user-invocable-only"` do not list it.
 *
 * ⚠️ NEWER RELEASES RENDER MORE, so on them this is an UNDER-count. Measured on
 * 2.1.316, against the same fixture:
 *
 *   - `<` and `>` become `&lt;` and `&gt;` BEFORE the cap — +3 characters
 *     each (`- alpha: Run <cmd> now & then - When the user says <go>`, 55
 *     characters on 2.1.187, is 67 on 2.1.316);
 *   - a frontmatter `name` that differs from the directory follows it in
 *     parentheses, `- dir (name): …` — +3 plus the name's length;
 *   - each control, format, private-use or separator code point becomes one
 *     space — the same length, a different text.
 *
 * Moving to those rules is a bump of `VALIDATED_CC_VERSION`, which moves CI's
 * binary with it; modelling them while CI runs the pinned release would leave
 * the delivery test proving nothing.
 *
 * The listing as a WHOLE also has a budget, past which descriptions are
 * dropped by least use. Read from the pinned 2.1.187 binary
 * (`@anthropic-ai/claude-code-linux-x64@2.1.187`, sha256 bb02fcb3…bf361):
 *
 *   budget = floor(contextWindowTokens × charsPerToken × fraction)
 *
 *   - `fraction` is `skillListingBudgetFraction` from settings, default 0.01
 *     (`var FRd=0.01`);
 *   - `contextWindowTokens` defaults to 200 000 (`URd=200000`), 1 000 000 on
 *     a 1M-context model;
 *   - `charsPerToken` is 4 for the models in a fixed set (claude-3-*,
 *     opus-4-0/4-1/4-5/4-6, sonnet-4-0/4-5/4-6, haiku-4-5) and 3 for every
 *     other model (`function oA(e){if(!e)return 4;…return l3u.has(n)?4:3}`);
 *   - the env var `SLASH_COMMAND_TOOL_CHAR_BUDGET` replaces the whole number.
 *
 * The listing is measured against it as the sum of each entry's display width
 * (`Bun.stringWidth`, not `.length`) plus one newline between entries, over
 * every listed skill — bundled, user and plugin skills included, not only the
 * repository's. Its floor is 200 000 × 3 × 0.01 = 6 000 characters, and that
 * floor is {@link claudeCodeListingBudget}: the window and the chars per token
 * depend on the model a person picks, so the smallest a commit can be sure of
 * is what vigiles holds it to. A committed `skillListingBudgetFraction` moves
 * it; the environment variable is per machine and is not read. vigiles sums
 * entry LENGTHS without the newlines, an under-count of one character per
 * listed skill (and more for wide characters, which `stringWidth` counts as 2).
 */
import type {
  ListedSkill,
  ListingLimit,
  SkillListingBudget,
  SkillListingRules,
} from "../../core/skill-listing.js";

/** The documented per-entry cap, in characters (UTF-16 units, as measured). */
const ENTRY_CAP = 1536;
/** What replaces the cut tail; the cap includes it. */
const ELLIPSIS = "…";
/** The text an entry carries when the skill gives none. */
const NO_DESCRIPTION = "Skill";

/** The trimmed text, or `undefined` when nothing is left. */
function trimmed(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = v.trim();
  return text === "" ? undefined : text;
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The configured cap when it is a positive integer, else the documented one. */
const capFrom = (settings: Readonly<Record<string, unknown>>): number => {
  const v = settings["skillListingMaxDescChars"];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : ENTRY_CAP;
};

const capped = (text: string, cap: number): string =>
  text.length <= cap ? text : text.slice(0, cap - 1) + ELLIPSIS;

const firstLine = (body: string): string | undefined =>
  body
    .split("\n")
    .map(trimmed)
    .find((l) => l !== undefined);

/** `skillOverrides[dir]`, when the settings carry one for this skill. */
const overrideFor = (
  settings: Readonly<Record<string, unknown>>,
  dirName: string,
): unknown => {
  const overrides = settings["skillOverrides"];
  return isRecord(overrides) ? overrides[dirName] : undefined;
};

const entry = (
  skill: ListedSkill,
  settings: Readonly<Record<string, unknown>>,
): string | null => {
  const fm = skill.frontmatter;
  // A skill whose frontmatter is not valid YAML is not registered by the
  // harness (observed in a dogfood session: fixing the YAML made the skill
  // appear in the listing it had been missing from).
  if (fm === null || fm["disable-model-invocation"] === true) return null;
  const override = overrideFor(settings, skill.dirName);
  if (override === "off" || override === "user-invocable-only") return null;
  if (override === "name-only") return `- ${skill.dirName}`;
  const description =
    trimmed(fm["description"]) ?? firstLine(skill.body) ?? NO_DESCRIPTION;
  const whenToUse = trimmed(fm["when_to_use"]);
  const combined =
    whenToUse === undefined ? description : `${description} - ${whenToUse}`;
  return `- ${skill.dirName}: ${capped(combined, capFrom(settings))}`;
};

/** The context window the budget is computed on: the CLI's default, `URd=200000`. */
const FLOOR_WINDOW_TOKENS = 200_000;
/** Characters per token for every model outside the CLI's older-model set. */
const FLOOR_CHARS_PER_TOKEN = 3;
/** `skillListingBudgetFraction`'s default, `FRd=0.01`. */
const DEFAULT_FRACTION = 0.01;
/** The setting that moves the fraction, as the settings schema names it. */
const FRACTION_SETTING = "skillListingBudgetFraction";

/** The committed fraction when the CLI would accept it (`gt(0).lte(1)`), else none. */
const fractionFrom = (
  settings: Readonly<Record<string, unknown>>,
): number | undefined => {
  const v = settings[FRACTION_SETTING];
  return typeof v === "number" && v > 0 && v <= 1 ? v : undefined;
};

/** `Math.max(1, Math.floor(window × charsPerToken × fraction))`, as the CLI computes it. */
const listingLimit = (
  settings: Readonly<Record<string, unknown>>,
): ListingLimit => {
  const fraction = fractionFrom(settings);
  const limit = Math.max(
    1,
    Math.floor(
      FLOOR_WINDOW_TOKENS *
        FLOOR_CHARS_PER_TOKEN *
        (fraction ?? DEFAULT_FRACTION),
    ),
  );
  return fraction === undefined
    ? { limit }
    : { limit, setBy: FRACTION_SETTING };
};

export const claudeCodeListingBudget: SkillListingBudget = {
  limit: listingLimit,
  capturedFrom:
    "claude-code 2.1.187 binary (sha256 bb02fcb3…bf361): function E2e — floor((window ?? 200000) × oA(model) × (skillListingBudgetFraction ?? 0.01)), oA = 4 for an older-model set else 3; floor at 200000 × 3",
};

export const claudeCodeSkillListing: SkillListingRules = {
  entry,
  budget: claudeCodeListingBudget,
  capturedFrom:
    "code.claude.com/docs/en/skills (fetched 2026-10-31); measured on Claude Code 2.1.187 (VALIDATED_CC_VERSION)",
};
