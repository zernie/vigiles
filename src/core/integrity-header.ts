/**
 * Where the vigiles integrity header sits in a file, and whether an
 * instruction file is under a spec — the node-free half of `integrity.ts`.
 *
 * Split out (like `assert-never.ts` from `hash.ts`) so the browser scan twin
 * can read these facts without `node:crypto`; `integrity.ts` re-exports all of
 * it, so callers import from there as before.
 */

const HASH_LINE_RE =
  /^<!-- vigiles:sha256:([a-f0-9]+) compiled from (.+) -->\r?\n\r?\n?/;

/**
 * A YAML frontmatter block at the very start of a file: `---\n … \n---\n`.
 *
 * 🔴 THIS EXISTS BECAUSE THE INVARIANT WAS STATED IN THIS FILE AND VIOLATED IN ANOTHER.
 * `ejectMarkdown` (bottom of this module) has documented since it was written that a compiled
 * SKILL.md begins with frontmatter which MUST stay in first position, or "the harness would lose
 * the skill's name/description/tools". `addHash` in compile.ts prepended the integrity header to
 * every compiled file unconditionally — including those same skills.
 *
 * Measured 2026-08-17 on five real skills: after compiling, a reader anchored to `^---` finds NO
 * frontmatter at all. The header was the ENTIRE delta — body byte-identical, section order
 * untouched — so one misplaced line was the whole reason a compiled skill could not be adopted.
 *
 * The header now goes AFTER the frontmatter when there is one. Readers must ask this module where
 * the header is rather than anchoring their own regex at `^`: four call sites had independently
 * encoded "first line", and that duplication is what let the invariant drift unnoticed.
 */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/;

/** Same header, matched where it sits below a frontmatter block (blank line allowed). */
const HASH_LINE_IN_BODY_RE =
  /^\s*<!-- vigiles:sha256:([a-f0-9]+) compiled from (.+) -->\r?\n\r?\n?/;

/**
 * Split off a leading frontmatter block. `head` is `""` when the file has none, so a caller can
 * concatenate `head + body` unconditionally and get the original content back.
 */
export function splitFrontmatter(content: string): Readonly<{
  head: string;
  body: string;
}> {
  const m = FRONTMATTER_RE.exec(content);
  return m
    ? { head: m[0], body: content.slice(m[0].length) }
    : { head: "", body: content };
}

/**
 * Locate the integrity header wherever it legitimately sits — before the frontmatter (files
 * compiled before 2026-08-17) or after it (files compiled since). Returns the hash, the spec
 * path, and the content with the header removed and everything else intact.
 *
 * This is the ONLY place that knows where the header can be. Matching `/^<!-- vigiles:sha256/`
 * by hand elsewhere is the bug this function exists to make unnecessary.
 */
export function findIntegrityHeader(content: string): Readonly<{
  hash: string;
  specFile: string;
  /** `content` minus the header, frontmatter still in place. */
  withoutHeader: string;
}> | null {
  const { head, body } = splitFrontmatter(content);
  // After the frontmatter — the current placement. The leading `\s*` is load-bearing: the header
  // is written one blank line below the closing `---` for readability, so an anchor at position 0
  // of the body misses it. A test caught exactly that before it shipped.
  const inBody = body.match(HASH_LINE_IN_BODY_RE);
  if (inBody) {
    return {
      hash: inBody[1],
      specFile: inBody[2],
      withoutHeader: head + body.replace(HASH_LINE_IN_BODY_RE, ""),
    };
  }
  // Or at the very top, which is what a file compiled before the fix looks like. Such a file has
  // no leading frontmatter by definition — the header displaced it — so `head` is empty here.
  const atTop = content.match(HASH_LINE_RE);
  if (!atTop) return null;
  return {
    hash: atTop[1],
    specFile: atTop[2],
    withoutHeader: content.replace(HASH_LINE_RE, ""),
  };
}

/** The marker that tells `require-instructions-spec` a file is intentionally
 * hand-owned (no `.spec.ts` expected). */
export const REQUIRE_INSTRUCTIONS_SPEC_DISABLE =
  "<!-- vigiles-disable require-instructions-spec -->";

/** The disable marker as written by hand: whitespace inside the comment varies. */
const REQUIRE_INSTRUCTIONS_SPEC_DISABLE_RE =
  /<!--\s*vigiles-disable\s+require-instructions-spec\s*-->/;

/**
 * Whether an instruction file is under a spec, opted out of one, or neither.
 *
 * 🔴 THE ONE ANSWER to "is this instruction file hand-written?". `lint`'s
 * `require-instructions-spec`, `audit`'s adoption list and the scan's
 * `Instructions:` line each used to decide it with their own test — a sibling
 * spec only, a spec or a compiled header, with or without the marker — so the
 * same repo could be one hand-written file to `audit` and six to `lint`.
 *
 * - `spec-managed`: a sibling `<file>.spec.ts`, or a compiled integrity header
 *   (a multi-target file such as `AGENTS.md` compiled from `CLAUDE.md.spec.ts`
 *   has no sibling spec and is still compiled);
 * - `opted-out`: the {@link REQUIRE_INSTRUCTIONS_SPEC_DISABLE} marker — kept
 *   hand-written on purpose, and that decision is remembered;
 * - `hand-written`: neither.
 *
 * Pure: the caller says whether the sibling spec exists.
 */
export type InstructionSpecState =
  | "spec-managed"
  | "opted-out"
  | "hand-written";

export function instructionSpecState(
  content: string,
  siblingSpecExists: boolean,
): InstructionSpecState {
  if (siblingSpecExists || findIntegrityHeader(content) !== null)
    return "spec-managed";
  if (REQUIRE_INSTRUCTIONS_SPEC_DISABLE_RE.test(content)) return "opted-out";
  return "hand-written";
}
