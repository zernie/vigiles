/**
 * How Codex renders a skill into the listing it loads at session start.
 *
 * Read from the Codex source (`openai/codex`, `codex-rs/ext/skills/src/
 * render.rs`, main, fetched 2026-10-31): each skill is one line,
 * `- {name}: {description} ({locator_kind}: {locator})`, where a skill on disk
 * prints `file` and its path, and an empty description renders as
 * `- {name}: ({kind}: {locator})`. The description is cut at 1,024 characters
 * before rendering.
 *
 * ⚠️ THE LOCATOR IS THE PATH ON THIS MACHINE, and this module writes the
 * repo-relative one instead. The absolute path differs per checkout, so a
 * number built from it could not be committed and compared in CI; the
 * relative path keeps the size reproducible from a commit, at the price of
 * under-counting each entry by the length of the checkout prefix.
 *
 * The listing as a whole has a budget (2% of the model's context window, or a
 * configured token count), past which descriptions are dropped. It depends on
 * the model, so it is not a property of a commit and is not modelled here.
 */
import type {
  ListedSkill,
  SkillListingRules,
} from "../../core/skill-listing.js";

/** The documented description cap, in characters. */
const DESCRIPTION_CAP = 1024;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

const entry = (skill: ListedSkill): string => {
  const fm = skill.frontmatter ?? {};
  const name = text(fm["name"]) ?? skill.dirName;
  const description = (text(fm["description"]) ?? "").slice(0, DESCRIPTION_CAP);
  const locator = `(file: ${skill.path})`;
  return description === ""
    ? `- ${name}: ${locator}`
    : `- ${name}: ${description} ${locator}`;
};

export const codexSkillListing: SkillListingRules = {
  entry,
  capturedFrom:
    "openai/codex codex-rs/ext/skills/src/render.rs (main, fetched 2026-10-31)",
};
