/**
 * vigiles — the ONE markdown-structure helper.
 *
 * Every place that needs to know "is this source line inside a fenced code
 * block?" routes through here, so no detector hand-rolls a fence toggle again.
 * The naive `inFence = !inFence` toggle (copy-pasted across five detectors
 * before this) is WRONG on nested / unbalanced fences: a 4-backtick block
 * containing a bare ``` line mis-toggles, and a `##` inside the block leaks out
 * as a real heading (demonstrated against `adopt`'s block splitter). Backed by
 * markdown-it (CommonMark) — the same "use the real parser, not regex"
 * discipline this repo already applies to Bash (mvdan-sh), code (ast-grep),
 * YAML (js-yaml), and TOML (@iarna/toml). Markdown was the one structured format
 * still parsed by hand.
 *
 * Node-free by construction: markdown-it is pure JS with no node builtins, so
 * this bundles clean in the browser scan engine (reached via skill-resources).
 */
/**
 * 🔴 `markdown-it` IS REQUIRED LAZILY, AND THAT IS A MEASUREMENT, NOT A STYLE.
 * The same wrapper is in `core/settings-codec.ts` with the reason recorded: a
 * top-level import puts the parser into the module graph of every HOOK
 * DECISION, because the hook runtime reaches the adapter registry and from
 * there a layout. This module became reachable that way on 2026-09-21 when
 * `PluginLayout.instructionChain` landed — measured by
 * `src/hook-runtime-graph.test.ts`: the react graph went from 37 modules to 92
 * with an eager import, and that test now names `markdown-it` so the regression
 * cannot come back unnamed. `tsc` lowers this to CommonJS, so the `require`
 * genuinely does not run until a parse is asked for.
 *
 * Each parser is built on FIRST USE and kept: construction is not free, and
 * `parse()` is stateless across calls, so one instance per configuration is
 * both correct and what the eager version did.
 */
type MarkdownItCtor = typeof import("markdown-it");
type MarkdownItParser = InstanceType<MarkdownItCtor>;
const MarkdownIt = (): MarkdownItCtor =>
  require("markdown-it") as MarkdownItCtor;

// One reusable parser; parse() is stateless across calls.
let mdCached: MarkdownItParser | null = null;
const md = (): MarkdownItParser => (mdCached ??= new (MarkdownIt())());

/**
 * A SECOND parser, used only by {@link markdownRefs}, with link handling turned
 * down to "report exactly what the author wrote":
 *
 * - `normalizeLink` is neutered because the default percent-ENCODES the
 *   destination. A detector downstream reads `%NN` as the signature of a URL or
 *   of a documentation example about escaping spaces, and skips it; letting
 *   markdown-it encode on the way in would manufacture that signature for any
 *   destination holding a space or a non-ASCII character.
 * - `validateLink` is opened because the default silently REFUSES to build a
 *   link token for schemes it distrusts (`javascript:`, `data:`), which would
 *   turn "a destination this tool declines to resolve" into "no destination at
 *   all". Skipping by scheme is the caller's job and it already does it.
 */
let mdRefsCached: MarkdownItParser | null = null;
const mdRefs = (): MarkdownItParser => {
  if (mdRefsCached === null) {
    const parser = new (MarkdownIt())();
    parser.normalizeLink = (url: string): string => url;
    parser.validateLink = (): boolean => true;
    mdRefsCached = parser;
  }
  return mdRefsCached;
};

/**
 * A boolean per source line (0-based): `true` when the line lies inside a fenced
 * code block (` ``` ` or `~~~`), the delimiter lines included — matching the
 * scope of the hand-rolled `FENCE` regexes this replaces. Indented code blocks
 * are deliberately NOT flagged, to preserve the prior detectors' behavior (they
 * only ever recognized fenced blocks). Correct on nested and unbalanced fences,
 * which the naive toggle was not.
 *
 * Pass the SAME string the caller iterates with `.split("\n")` so the returned
 * indices line up 1:1 with the caller's line array.
 */
export function fencedLineFlags(src: string): boolean[] {
  const lineCount = src.split("\n").length;
  const flags = new Array<boolean>(lineCount).fill(false);
  for (const tok of md().parse(src, {})) {
    // Only real ``` / ~~~ fences (a block-level token); markdown-it's `map` is
    // a [start, end) 0-based line range covering the delimiters + body.
    if (tok.type !== "fence" || tok.map === null) continue;
    const [start, end] = tok.map;
    for (let i = start; i < end && i < lineCount; i++) flags[i] = true;
  }
  return flags;
}

/**
 * A THIRD parser, with `html: true`, used only by {@link proseLines}.
 *
 * The default `md` above has HTML disabled, so `<!-- maintainer note -->` comes
 * back as ordinary paragraph TEXT rather than as an `html_block` token — which
 * would put an author's commented-out line into the prose a caller is reading.
 * Measured: with the default parser, `"<!-- note -->\n\n@AGENTS.md"` yields two
 * prose lines; with this one, one. Enabling html on the shared parser would
 * change what every existing caller sees, so this is a sibling rather than a
 * setting, exactly as `mdRefs` is.
 */
let mdProseCached: MarkdownItParser | null = null;
const mdProse = (): MarkdownItParser =>
  (mdProseCached ??= new (MarkdownIt())({ html: true }));

/**
 * The document's PROSE, as CommonMark sees it: one entry per source line that
 * carries author text, with fenced code, indented code, raw HTML blocks, inline
 * code spans and inline HTML removed, and blank lines dropped.
 *
 * 🔴 WHY A CALLER MUST NOT DO THIS BY SPLITTING LINES. The module header already
 * records that the naive `inFence = !inFence` toggle was copy-pasted into five
 * detectors and is wrong on nested or unbalanced fences. The same applies to
 * every other part of "what is the author actually saying here": a `<!-- -->`
 * spanning three lines, a four-backtick block containing a bare three-backtick
 * line, an indented continuation. The parser has all of it.
 *
 * What it also does, and what a hand-written reader gets wrong quietly: block
 * parsing strips the leading INDENT, normalises CRLF, and drops trailing
 * whitespace and trailing blank lines — so `@AGENTS.md`, `  @AGENTS.md`,
 * `@AGENTS.md  ` and a CRLF-terminated copy all arrive as the same string
 * (measured against this repo's markdown-it, 2026-09-21).
 *
 * ⚠️ THE ONE THING IT DOES NOT NORMALISE IS A UTF-8 BOM: markdown-it hands back
 * `"\uFEFF@AGENTS.md"` for a BOM-prefixed first line, so this strips it. That is
 * a measurement, not a precaution.
 */
export function proseLines(src: string): readonly string[] {
  const out: string[] = [];
  for (const tok of mdProse().parse(src, {})) {
    if (tok.type !== "inline") continue;
    let line = "";
    for (const child of tok.children ?? []) {
      if (child.type === "softbreak" || child.type === "hardbreak") {
        out.push(line);
        line = "";
        continue;
      }
      // A code span and an inline `<!-- -->` are not the author's prose; the
      // corpus that motivated this is full of `@dataclass`-shaped text inside
      // them, and none of it names a file.
      if (child.type === "code_inline" || child.type === "html_inline")
        continue;
      line += child.content;
    }
    out.push(line);
  }
  return out
    .map((line) => line.replace(/^\uFEFF/, ""))
    .filter((line) => line !== "");
}

/** One fenced code block: its BODY (delimiters excluded) and where the body starts. */
export interface FencedBlock {
  /** The block's contents, without the opening/closing fence lines. */
  readonly body: string;
  /** 1-BASED line number of the body's first line, for a caller's messages. */
  readonly start: number;
}

/**
 * Every fenced code block in `src`, in document order — the same parser
 * {@link fencedLineFlags} uses, for callers that want the CONTENTS rather than a
 * per-line flag.
 *
 * 🔴 THE CLOSING FENCE MUST MATCH THE OPENING ONE, and every hand-rolled version
 * of this in the repo got that wrong the same way: any line beginning with three
 * backticks TOGGLED. CommonMark says a closing fence uses the same CHARACTER as
 * the opener and is at least as LONG, so a four-backtick block wrapping an
 * ordinary ``` example closes early — the block is cut in half, and the prose
 * after it becomes "another block" whose text is then read as commands. That
 * makes a document-rule check both MISS commands and JUDGE prose. `~~~` fences
 * were not recognized at all.
 *
 * Backed by markdown-it (CommonMark), so delimiter character, delimiter length,
 * `~~~`, indented fences inside list items and an unterminated final fence are
 * all decided by the grammar rather than re-derived here. Measured 2026-08-12 on
 * each of those shapes.
 *
 * One deliberate difference from a hand-rolled toggle, and it is the grammar's:
 * a fence indented FOUR or more spaces at top level is an indented code block,
 * not a fence, and is not returned. Line numbers count from the ORIGINAL source,
 * so a caller's message points at the real line.
 */
export function fencedCodeBlocks(src: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  for (const tok of md().parse(src, {})) {
    if (tok.type !== "fence" || tok.map === null) continue;
    // `content` is the body only; `map[0]` is the OPENING delimiter's 0-based
    // line, so the body's first line is 1-based `map[0] + 2`.
    out.push({ body: tok.content.replace(/\n$/, ""), start: tok.map[0] + 2 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural references (links + code spans)
// ---------------------------------------------------------------------------

/**
 * How a reference appeared in the markdown.
 *
 * `link` is a DESTINATION — the thing the reader follows: an inline link's
 * target, or an image's `src`. `code` is a bare backtick span standing on its
 * own in prose.
 */
export type MarkdownRefKind = "link" | "code";

/** One reference recovered from markdown STRUCTURE. */
export interface MarkdownRef {
  readonly kind: MarkdownRefKind;
  /**
   * For `link`, the destination exactly as written. For `code`, the span's
   * content. Never the display text of a link — see {@link markdownRefs}.
   */
  readonly value: string;
  /** 1-based source line the reference sits on. */
  readonly line: number;
}

/**
 * Every reference a markdown body makes, taken from the PARSE rather than from
 * the characters.
 *
 * 🔴 WHY THIS EXISTS: A LINK'S TEXT IS NOT A REFERENCE. The detector this
 * replaces ran two regexes over each line — one for `[..](..)`, one for
 * `` `..` `` — and the second one could not see that it was standing inside the
 * first. Measured 2026-08-17 on `microsoft/power-platform-skills`:
 *
 *     See [`references/dataverse-reference.md` § Setting Lookups](../add-dataverse/references/dataverse-reference.md#setting-lookups)
 *
 * The DESTINATION resolves — the file is 23KB and present. The backtick span in
 * the link's TEXT is a human-readable label for it. vigiles reported the label
 * as a missing bundled resource, i.e. it accused a correct link of being broken
 * by reading the half of it that is display. The same shape cost
 * `rohitg00/pro-workflow` a second false accusation.
 *
 * So a code span nested inside a link's (or an image's) text is NOT emitted.
 * The destination is right there, it is what the agent follows, and it is
 * returned instead. The bug is not fixed here so much as made unsayable: a
 * caller of this function is never handed link text at all.
 *
 * Fenced and indented code blocks contribute nothing ({@link fencedLineFlags}
 * decides which lines those are, so no caller re-derives it).
 *
 * ⚠️ ONE LINE AT A TIME, and the reason is the line number. Callers report a
 * reference by source line, and markdown-it's inline tokens carry no line
 * information — only the enclosing block does — so a paragraph-wide parse would
 * point every reference in a paragraph at the paragraph's first line. Parsing
 * each line's inline content keeps the number exact. The cost is a construct
 * split across two source lines (a link whose `](` sits on the next line),
 * which is not recovered — the regexes this replaces did not recover it either.
 */
export function markdownRefs(src: string): MarkdownRef[] {
  const lines = src.split("\n");
  const fenced = fencedLineFlags(src);
  const out: MarkdownRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Cheap reject: no link syntax and no backtick means no reference, and most
    // lines of a real corpus are that.
    if (fenced[i] || (!line.includes("`") && !line.includes("]("))) continue;
    for (const tok of mdRefs().parseInline(line, {})) {
      refsInInline(tok.children ?? [], i + 1, out);
    }
  }
  return out;
}

/** Which attribute carries the DESTINATION, per inline token type. */
const DESTINATION_ATTR: Record<string, string | undefined> = {
  link_open: "href",
  image: "src",
};

/**
 * Walk ONE line's inline token stream, appending its references.
 *
 * `linkDepth` is the whole point: markdown-it emits `link_open` … `link_close`
 * around the link's TEXT, so a `code_inline` seen while the depth is non-zero
 * is display, and its destination has already been recorded.
 */
function refsInInline(
  children: readonly {
    type: string;
    content: string;
    attrGet: (n: string) => string | null;
  }[],
  line: number,
  out: MarkdownRef[],
): void {
  let linkDepth = 0;
  for (const child of children) {
    if (child.type === "link_close") {
      linkDepth--;
      continue;
    }
    if (child.type === "link_open") linkDepth++;
    // An image's alt text is a nested inline stream markdown-it keeps in
    // `children`; it is display, exactly like link text, so only the `src` is
    // taken and the alt is not descended into.
    const destAttr = DESTINATION_ATTR[child.type];
    const dest = destAttr === undefined ? null : child.attrGet(destAttr);
    if (dest) out.push({ kind: "link", value: dest, line });
    else if (child.type === "code_inline" && linkDepth === 0)
      out.push({ kind: "code", value: child.content, line });
  }
}
