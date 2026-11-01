/**
 * How Codex renders a skill into the listing it loads at session start.
 *
 * Read from the Codex source (`openai/codex`, main, fetched 2026-10-31) and
 * measured on codex-cli 0.153.0 against the mock model
 * (`skill-listing-delivery.test.ts` pins it):
 *
 *   - WHICH SKILLS ARE LISTED (`codex-rs/skills/src/parser.rs`,
 *     `parse_skill_frontmatter_metadata`). A SKILL.md with no frontmatter
 *     block, with a block that is not valid YAML, with an empty description,
 *     or with a name over 64 characters fails to parse, is pushed to the
 *     loader's errors, and is not listed at all.
 *   - THE TEXT. Name and description each pass through `sanitize_single_line`
 *     (`split_whitespace().join(" ")`), so a multi-line description is one
 *     line. A missing name falls back to the skill's directory name.
 *   - THE ENTRY (`codex-rs/ext/skills/src/render.rs`): one line,
 *     `- {name}: {description} ({locator_kind}: {locator})`, where a skill on
 *     disk prints `file`.
 *   - THE CAP (`truncate_catalog_skill_description`): a description longer
 *     than 1,024 characters keeps its first 1,021 and gains `...`. Characters
 *     are Unicode scalar values, so an emoji is one character, not two.
 *
 * ⚠️ NOT MIRRORED, each an UNDER-count:
 *
 *   - Codex repairs one kind of invalid YAML before giving up: an unquoted
 *     scalar holding `: `, as in `description: Build for AWS: ECS`, is quoted
 *     line by line and parsed again. vigiles reads such a block as malformed
 *     and does not list the skill, where Codex does.
 *   - THE LOCATOR is per machine. Codex prints either the absolute path or a
 *     short alias (`r1/<path under the skills folder>`, beside a table that
 *     maps `r1` to the absolute folder), whichever renders cheaper. Neither can
 *     be committed and compared in CI, so this module writes the repo-relative
 *     path; the size is reproducible from a commit, and each entry is off by
 *     the difference between that path and the one Codex printed.
 *
 * The listing as a whole has a budget, past which descriptions are shortened
 * and then skills omitted ("Exceeded skills context budget …"). Read from
 * `codex-rs/ext/skills/src/render.rs` and `extension.rs` at tag rust-v0.153.0
 * (`skill_metadata_budget`):
 *
 *   - a configured `max_context_tokens` wins, capped at 10 000 tokens;
 *   - else, at THREAD START (`CatalogSurface::ThreadContext`), the window is
 *     passed as `None`, so the budget is 8 000 CHARACTERS
 *     (`DEFAULT_SKILL_METADATA_CHAR_BUDGET`), each line costing its Unicode
 *     scalar count plus one newline;
 *   - on a TURN (`CatalogSurface::TurnInput`) it is 2% of the model's context
 *     window in tokens, each line costing ceil((bytes + 1) / 4).
 *
 * The thread-start number does not depend on the model, so it is
 * {@link codexListingBudget}: 8 000 — compared against vigiles's Codex unit,
 * BYTES, which is never smaller than the characters Codex counts, so a
 * non-ASCII listing is reported over a little early, never late. A committed
 * `[skills] max_context_tokens` in `.codex/config.toml` replaces it with that
 * many tokens (at most 10 000), four bytes each. vigiles sums entries without
 * the newline Codex adds to each line: one byte per listed skill under.
 */
import type {
  ListedSkill,
  ListingLimit,
  SkillListingBudget,
  SkillListingRules,
} from "../../core/skill-listing.js";

/** Longer descriptions are cut, in Unicode scalar values. */
const DESCRIPTION_CAP = 1024;
/** What replaces the cut tail; the cap includes it. */
const TRUNCATION_SUFFIX = "...";
/** A longer name fails to parse, in Unicode scalar values. */
const NAME_CAP = 64;

/** `sanitize_single_line`: every run of whitespace becomes one space. */
const singleLine = (v: string): string =>
  v.split(/\s+/u).filter(Boolean).join(" ");

/** A frontmatter value as Codex reads it, or `""` when it is not text. */
const field = (v: unknown): string =>
  typeof v === "string" ? singleLine(v) : "";

/** `truncate_catalog_skill_description`, counted in code points. */
function capped(description: string): string {
  // Code points, as Rust's `chars()` counts — not UTF-16 units, not graphemes.
  const chars = Array.from(description);
  return chars.length <= DESCRIPTION_CAP
    ? description
    : chars.slice(0, DESCRIPTION_CAP - TRUNCATION_SUFFIX.length).join("") +
        TRUNCATION_SUFFIX;
}

const entry = (skill: ListedSkill): string | null => {
  const fm = skill.frontmatter;
  // `{}` is a file with no block, `null` a block that is not valid YAML; both
  // are parse errors to Codex, and an empty description is one too.
  if (fm === null) return null;
  const name = field(fm["name"]) || singleLine(skill.dirName);
  const description = field(fm["description"]);
  if (description === "" || name === "" || Array.from(name).length > NAME_CAP) {
    return null;
  }
  return `- ${name}: ${capped(description)} (file: ${skill.path})`;
};

/** `DEFAULT_SKILL_METADATA_CHAR_BUDGET`: the thread-start budget, no window passed. */
const THREAD_START_BUDGET = 8000;
/** `MAX_CONFIGURED_SKILL_METADATA_TOKEN_BUDGET`: a configured budget is capped here. */
const MAX_CONFIGURED_TOKENS = 10_000;
/** `APPROX_BYTES_PER_TOKEN`, the conversion `approx_token_count` uses. */
const BYTES_PER_TOKEN = 4;
/** The committed setting, as `.codex/config.toml` spells it. */
const TOKENS_SETTING = "skills.max_context_tokens";

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `[skills] max_context_tokens` when it is a positive integer (`NonZeroUsize`). */
const configuredTokens = (
  settings: Readonly<Record<string, unknown>>,
): number | undefined => {
  const skills = settings["skills"];
  const v = isRecord(skills) ? skills["max_context_tokens"] : undefined;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
};

const listingLimit = (
  settings: Readonly<Record<string, unknown>>,
): ListingLimit => {
  const tokens = configuredTokens(settings);
  return tokens === undefined
    ? { limit: THREAD_START_BUDGET }
    : {
        limit: Math.min(tokens, MAX_CONFIGURED_TOKENS) * BYTES_PER_TOKEN,
        setBy: TOKENS_SETTING,
      };
};

export const codexListingBudget: SkillListingBudget = {
  limit: listingLimit,
  capturedFrom:
    "openai/codex rust-v0.153.0 codex-rs/ext/skills/src/render.rs skill_metadata_budget + extension.rs:234 (thread start passes no window → 8_000 chars; max_context_tokens capped at 10_000)",
};

export const codexSkillListing: SkillListingRules = {
  entry,
  budget: codexListingBudget,
  capturedFrom:
    "openai/codex codex-rs/skills/src/parser.rs + codex-rs/ext/skills/src/render.rs (main, fetched 2026-10-31); measured on codex-cli 0.153.0",
};
