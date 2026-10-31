/**
 * How Claude Code renders a skill into the listing it loads at session start.
 *
 * Read from https://code.claude.com/docs/en/skills (fetched 2026-10-31):
 *
 *   - the entry is `- <name>: <description>`, the shape seen in a session's own
 *     listing;
 *   - `when_to_use` is "Appended to `description` in the skill listing and
 *     counts toward the 1,536-character cap" — the SEPARATOR between the two is
 *     not documented, and a single space is assumed here;
 *   - "each entry's combined text is capped at 1,536 characters regardless of
 *     budget. The cap is configurable with `skillListingMaxDescChars`";
 *   - with no `description`, the first non-empty line of the body is used;
 *   - `disable-model-invocation: true` "removes the skill from Claude's context
 *     entirely";
 *   - `skillOverrides` maps a name to `"name-only"` (listed without its
 *     description), `"off"` or `"user-invocable-only"` (not listed).
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

/** The documented per-entry cap, in characters. */
const ENTRY_CAP = 1536;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The configured cap when it is a positive integer, else the documented one. */
const capFrom = (settings: Readonly<Record<string, unknown>>): number => {
  const v = settings["skillListingMaxDescChars"];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : ENTRY_CAP;
};

const firstLine = (body: string): string | undefined =>
  body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");

/** `skillOverrides[name]`, when the settings carry one for this skill. */
const overrideFor = (
  settings: Readonly<Record<string, unknown>>,
  name: string,
): unknown => {
  const overrides = settings["skillOverrides"];
  return isRecord(overrides) ? overrides[name] : undefined;
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
  const name = text(fm["name"]) ?? skill.dirName;
  const override = overrideFor(settings, name);
  if (override === "off" || override === "user-invocable-only") return null;
  if (override === "name-only") return `- ${name}`;
  const description = text(fm["description"]) ?? firstLine(skill.body) ?? "";
  const whenToUse = text(fm["when_to_use"]);
  const combined =
    whenToUse === undefined ? description : `${description} ${whenToUse}`;
  return `- ${name}: ${combined.slice(0, capFrom(settings))}`;
};

export const claudeCodeSkillListing: SkillListingRules = {
  entry,
  capturedFrom:
    "code.claude.com/docs/en/skills, 'Skill descriptions are cut short', fetched 2026-10-31",
};
