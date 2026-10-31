/**
 * How Claude Code renders a skill into the listing it loads at session start.
 *
 * Read from https://code.claude.com/docs/en/skills (fetched 2026-10-31) and
 * MEASURED on Claude Code 2.1.316 against the mock model, where the page is
 * silent or the rendering differs from the shape it suggests
 * (`skill-listing-delivery.test.ts` pins each of these against the real
 * binary, so a change in a later release fails a test rather than a number):
 *
 *   - the LABEL is the skill's directory name; a frontmatter `name` that
 *     differs from it, even only in case, follows in parentheses:
 *     `- dir (name): …`;
 *   - the text is the `description`, else the first non-empty line of the
 *     body, else the word `Skill`; `when_to_use` "is appended to
 *     `description` … and counts toward the 1,536-character cap", joined by
 *     ` - `;
 *   - the page: "It removes control characters, and in text that reaches
 *     Claude, such as the description, it also escapes angle brackets". As
 *     measured, each control, format, private-use or line-separator code
 *     point becomes ONE SPACE (spaces are not collapsed), the text is trimmed,
 *     and `<`/`>` become `&lt;`/`&gt;` — `&` is left alone;
 *   - the CAP applies AFTER the escape, to the combined text: over 1,536
 *     UTF-16 units (or `skillListingMaxDescChars`), the first cap−1 units are
 *     kept and `…` appended — a cut that can split an escape or a surrogate
 *     pair, as Claude Code's does;
 *   - `disable-model-invocation: true` "removes the skill from Claude's context
 *     entirely";
 *   - `skillOverrides` is keyed by the DIRECTORY name (a key equal to the
 *     frontmatter name does nothing): `"name-only"` lists `- dir` alone,
 *     `"off"` and `"user-invocable-only"` do not list it.
 *
 * The listing as a WHOLE also has a budget (1% of the model's context window),
 * past which descriptions are dropped by least use. That budget depends on the
 * model and on this machine's usage, so it is not a property of a commit and
 * is not modelled here; every entry is counted at its full capped size.
 */
import type {
  ListedSkill,
  SkillListingRules,
} from "../../core/skill-listing.js";

/** The documented per-entry cap, in characters (UTF-16 units, as measured). */
const ENTRY_CAP = 1536;
/** What replaces the cut tail; the cap includes it. */
const ELLIPSIS = "…";
/** The text an entry carries when the skill gives none. */
const NO_DESCRIPTION = "Skill";

/**
 * Control (Cc), format (Cf), private-use (Co), unassigned (Cn) and
 * line/paragraph-separator (Zl, Zp) code points: each becomes one space. A
 * plain or no-break space (Zs) is kept as it is.
 */
const REPLACED = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/** The sanitised, escaped text, or `undefined` when nothing is left. */
function sanitized(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = v
    .replace(REPLACED, " ")
    .trim()
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    .map(sanitized)
    .find((l) => l !== undefined);

/** `skillOverrides[dir]`, when the settings carry one for this skill. */
const overrideFor = (
  settings: Readonly<Record<string, unknown>>,
  dirName: string,
): unknown => {
  const overrides = settings["skillOverrides"];
  return isRecord(overrides) ? overrides[dirName] : undefined;
};

/** `dir`, or `dir (name)` when the frontmatter names it otherwise. */
function label(skill: ListedSkill): string {
  const name = skill.frontmatter?.["name"];
  return typeof name === "string" &&
    name.trim() !== "" &&
    name.trim() !== skill.dirName
    ? `${skill.dirName} (${name.trim()})`
    : skill.dirName;
}

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
    sanitized(fm["description"]) ?? firstLine(skill.body) ?? NO_DESCRIPTION;
  const whenToUse = sanitized(fm["when_to_use"]);
  const combined =
    whenToUse === undefined ? description : `${description} - ${whenToUse}`;
  return `- ${label(skill)}: ${capped(combined, capFrom(settings))}`;
};

export const claudeCodeSkillListing: SkillListingRules = {
  entry,
  capturedFrom:
    "code.claude.com/docs/en/skills (fetched 2026-10-31); measured on Claude Code 2.1.316",
};
