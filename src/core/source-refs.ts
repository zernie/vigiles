/**
 * vigiles — recovering a FILE REFERENCE from PLAIN SOURCE TEXT.
 *
 * The third of three reference grammars, and the only one with no parser behind
 * it. A markdown body is read by markdown-it (`core/markdown.ts` →
 * `markdownRefs`), a hook `command` is never read at all (it is compiled or it
 * is hand-written, by identity — `core/hook-command.ts`), and what is left — the
 * body of a hook script, a helper
 * `.js` / `.py` / `.rb` — is scanned for path-shaped character runs, because a
 * general-purpose "find every path this program touches" analysis is not a
 * thing this tool can be.
 *
 * Since that scan IS a character run, the only thing standing between it and a
 * false accusation is where the run may START and STOP. This module owns both
 * boundaries and the extension vocabularies, so no caller can build a pattern
 * without them.
 *
 * ## The two boundaries, and the two live defects that came from omitting them
 *
 * RIGHT — the extension must END the token. `INTRA_REF_EXTS` used to be a bare
 * alternation with no trailing assertion, and `js` sits ahead of `json` in it,
 * so `hooks/hooks.json` matched as `hooks/hooks.js`. Measured 2026-08-17 on
 * `microsoft/power-platform-skills`: a `//` comment naming `hooks/hooks.json`,
 * with that exact file sitting beside it on disk, was reported as
 * "hooks/hooks.js (referenced but MISSING)" — a maintainer told a file they
 * have is missing, under a name they never wrote.
 *
 * LEFT — the surface dir must START the token. `(?:agents|hooks|skills)/` with
 * nothing before it also matches the tail of `claude-agents/`. Measured the
 * same day on `fcakyon/claude-codex-settings`: a
 * `new URL("../../../claude-agents/fable-advisor.md", …)` — a correct,
 * resolving reference — was reported as a broken `agents/fable-advisor.md`.
 * That boundary is a predicate ({@link startsAtSeparator}) rather than a regex
 * lookbehind, because the browser twin (`scan-files.ts`) compiles this into the
 * demo engine, and because the caller already inspects `m.index` for its
 * plugin-rooted test.
 *
 * ## Comments are prose in every language, not only in shell
 *
 * `stripShellComments` had the right idea and too narrow a domain: a full-line
 * `#` in a `.sh` file is prose, and so is a full-line `//` or a JSDoc `*` in a
 * `.js` file. Both remaining corpus false accusations in this detector came out
 * of JSDoc — `* It is deliberately not registered in hooks/hooks.json:` and
 * "`git log --grep=.env -- hooks/x.mjs` is refused …". Neither is a file
 * operation; both were reported as broken references.
 *
 * FULL-LINE ONLY, the same rule the shell version already held. A trailing
 * comment on a real code line is left alone, so a genuine reference sharing a
 * line with code is never dropped. The cost is stated rather than hidden: a
 * path mentioned ONLY in a trailing comment still counts as a reference.
 */

// ---------------------------------------------------------------------------
// Boundaries — the two assertions no pattern here may be built without
// ---------------------------------------------------------------------------

/**
 * The right boundary: the matched extension must be the END of the token.
 * A negative lookahead over the characters an extension is drawn from, so `js`
 * cannot claim the head of `json` / `jsonl` and `py` cannot claim `pyc`. `.` is
 * deliberately NOT in the class, which preserves the prior `\b` behaviour on
 * `bundle.js.map`.
 */
const ENDS_TOKEN = "(?![A-Za-z0-9_])";

/**
 * Characters a path SEGMENT is made of. A match preceded by one of these landed
 * in the middle of a longer name (`claude-agents/`), which is not a reference
 * to the surface dir it happens to end with.
 */
const SEGMENT_CHAR = /[A-Za-z0-9._-]/;

/**
 * Whether a match at `idx` begins at a path boundary rather than inside a
 * longer name. Position 0 counts as a boundary.
 *
 * `/` is a boundary on purpose: `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh` is the
 * standard spelling, and the caller's plugin-rooted test decides whether the
 * segment before that slash roots the path inside the plugin or outside it.
 */
export function startsAtSeparator(content: string, idx: number): boolean {
  if (idx <= 0) return true;
  return !SEGMENT_CHAR.test(content[idx - 1] ?? "");
}

// ---------------------------------------------------------------------------
// Extension vocabularies
// ---------------------------------------------------------------------------

/**
 * Extensions an intra-plugin reference may carry — the file kinds a plugin's
 * own hook / helper source legitimately points at.
 */
export const INTRA_REF_EXTENSIONS = [
  "md",
  "sh",
  "cmd",
  "mjs",
  "cjs",
  "js",
  "ts",
  "py",
  "rb",
  "txt",
  "json",
] as const;

/**
 * Extensions a RUNNABLE script carries. Shared by the hook scanner and the
 * coverage twins, which each declared their own copy before.
 */
export const SCRIPT_REF_EXTENSIONS = [
  "sh",
  "mjs",
  "cjs",
  "js",
  "ts",
  "py",
  "rb",
] as const;

/**
 * A plugin-relative path under one of `dirs`, carrying a known extension — the
 * pattern for scanning a plugin's own SOURCE TEXT.
 *
 * The left boundary is not baked into the returned regex (see
 * {@link startsAtSeparator}): a caller scanning raw text must apply that
 * predicate at `m.index`, which both the disk detector and its browser twin do
 * inside their plugin-rooted test.
 */
export function intraRefPattern(dirs: readonly string[]): RegExp {
  const exts = INTRA_REF_EXTENSIONS.join("|");
  return new RegExp(
    `(?:${dirs.join("|")})/[A-Za-z0-9._/-]+\\.(?:${exts})${ENDS_TOKEN}`,
    "g",
  );
}

/**
 * A script path appearing anywhere inside a string — for the one caller with no
 * shell parse to hand (the coverage twins scan a serialized settings blob).
 * Carries the right boundary; it cannot carry the left one, and its callers
 * gate every hit on the file existing, so a stray match is dropped rather than
 * reported.
 */
export function scriptRefPattern(): RegExp {
  const exts = SCRIPT_REF_EXTENSIONS.join("|");
  return new RegExp("[\\w./$" + "{}@-]+\\." + `(?:${exts})${ENDS_TOKEN}`, "g");
}

// ---------------------------------------------------------------------------
// Comments (prose inside an executable source)
// ---------------------------------------------------------------------------

/** Source kinds whose full-line comments this module knows how to drop. */
const HASH_COMMENT = /\.(?:sh|bash|zsh|cmd|py|rb|pl)$/i;
const SLASH_COMMENT = /\.(?:m|c)?[jt]s$/i;

/**
 * A line that is ENTIRELY a comment in a `//`-style language: a `//` line, a
 * block-comment delimiter, or a JSDoc continuation `*` followed by whitespace
 * or end of line.
 *
 * A bare `*name` does NOT count — `*run() {}` is a generator method, and
 * dropping that line would silently delete a real reference from code.
 */
const SLASH_COMMENT_LINE = /^(?:\/\/|\/\*|\*\/|\*(?:\s|$))/;

/**
 * Drop FULL-LINE comments (including a shebang, which also starts with `#`)
 * from an executable source before it is scanned for path references.
 *
 * A file of unknown kind is returned unchanged: guessing a comment syntax is
 * how a real reference gets deleted, and this detector's contract is that it
 * under-reports rather than accuses.
 */
export function stripFullLineComments(path: string, content: string): string {
  const isHash = HASH_COMMENT.test(path);
  const isSlash = SLASH_COMMENT.test(path);
  if (!isHash && !isSlash) return content;
  return content
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return isHash ? !t.startsWith("#") : !SLASH_COMMENT_LINE.test(t);
    })
    .join("\n");
}
