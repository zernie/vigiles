/**
 * fencedLineFlags — the shared fence oracle that replaced five copy-pasted
 * `inFence = !inFence` toggles. The load-bearing case is the one the naive
 * toggle got WRONG: a nested / unbalanced fence, where an odd count of
 * fence-looking lines flipped the toggle and leaked a `##` inside a code block
 * out as a real heading.
 */
import { describe, it, expect } from "vitest";
import { fencedLineFlags, markdownRefs, proseLines } from "./markdown.js";

/** Indices (0-based) whose flag is true, for compact assertions. */
const fencedIndices = (src: string): number[] =>
  fencedLineFlags(src).flatMap((f, i) => (f ? [i] : []));

describe("fencedLineFlags", () => {
  it("flags the lines of a simple fenced block, delimiters included", () => {
    const src = ["before", "```", "code", "```", "after"].join("\n");
    expect(fencedIndices(src)).toEqual([1, 2, 3]);
  });

  it("returns one flag per source line, none outside a fence", () => {
    const src = ["# H", "", "para"].join("\n");
    expect(fencedLineFlags(src)).toEqual([false, false, false]);
  });

  it("handles a NESTED fence: an inner ``` inside a 4-backtick block stays fenced", () => {
    const src = [
      "## Setup", // 0
      "", // 1
      "````markdown", // 2  outer open
      "```bash", // 3  inner (would flip a naive toggle)
      "echo hi", // 4
      "```", // 5  inner close
      "## inside the block", // 6  must be treated as fenced, NOT a heading
      "````", // 7  outer close
      "", // 8
      "## Rules", // 9  the only OTHER real content line
    ].join("\n");
    const flags = fencedLineFlags(src);
    // The entire outer block (lines 2..7) is fenced — including the `##` at 6.
    expect(flags[6]).toBe(true);
    expect(fencedIndices(src)).toEqual([2, 3, 4, 5, 6, 7]);
    // Real headings outside the block are NOT fenced.
    expect(flags[0]).toBe(false);
    expect(flags[9]).toBe(false);
  });

  it("handles an UNBALANCED / stray fence — the case the naive toggle corrupted", () => {
    // A single stray ``` line inside the outer block (odd toggle count). The
    // naive toggle wrongly treated the trailing `##` as outside a fence; the
    // real parser keeps the whole outer block fenced.
    const src = [
      "## Setup", // 0
      "", // 1
      "````markdown", // 2 outer open
      "To open a code block, type:", // 3
      "```", // 4 stray single fence (odd)
      "## Heading INSIDE the outer block", // 5 must stay fenced
      "````", // 6 outer close
      "", // 7
      "## Rules", // 8
    ].join("\n");
    const flags = fencedLineFlags(src);
    expect(flags[5]).toBe(true); // the in-block `##` is fenced, not a heading
    expect(flags[0]).toBe(false);
    expect(flags[8]).toBe(false);
  });

  it("supports ~~~ fences too", () => {
    const src = ["a", "~~~", "x", "~~~", "b"].join("\n");
    expect(fencedIndices(src)).toEqual([1, 2, 3]);
  });

  it("does NOT flag indented code (matches the prior FENCE regex scope)", () => {
    // Four-space-indented code is NOT a fenced block; the detectors this helper
    // replaced only ever recognized ``` / ~~~ fences.
    const src = ["para", "", "    not a fence, indented code", "", "end"].join(
      "\n",
    );
    expect(fencedLineFlags(src).every((f) => !f)).toBe(true);
  });
});

describe("proseLines", () => {
  /**
   * The normalisation CommonMark does for free, measured against this repo's
   * markdown-it rather than assumed. Every entry is the SAME line: a caller
   * splitting the source itself would have to reimplement each of these, and
   * would get the fourth and fifth wrong quietly.
   */
  it.each([
    ["column zero", "@AGENTS.md"],
    ["a leading indent", "  @AGENTS.md"],
    ["trailing spaces", "@AGENTS.md  "],
    ["a CRLF line ending", "@AGENTS.md\r\n"],
    ["a UTF-8 BOM", "\uFEFF@AGENTS.md"],
    ["trailing blank lines", "@AGENTS.md\n\n\n"],
  ])("returns one clean line for %s", (_name, src) => {
    expect(proseLines(src)).toEqual(["@AGENTS.md"]);
  });

  it("drops fenced code, including a four-backtick block holding a bare fence", () => {
    // The case the module header records as the reason this file exists: the
    // naive `inFence = !inFence` toggle mis-toggles here and leaks the body out.
    expect(proseLines("````\n```\n@media.md\n```\n````\n")).toEqual([]);
    expect(proseLines("```py\n@dataclass\n```\n")).toEqual([]);
  });

  it("drops an HTML comment, one line or many", () => {
    expect(proseLines("<!-- note -->\n\nbody\n")).toEqual(["body"]);
    expect(proseLines("<!--\nhidden\n-->\nbody\n")).toEqual(["body"]);
  });

  it("drops an inline code span but keeps the prose around it", () => {
    expect(proseLines("use `@dataclass` here")).toEqual(["use  here"]);
  });

  it("splits a paragraph at its line breaks, soft and hard", () => {
    expect(proseLines("one\ntwo  \nthree")).toEqual(["one", "two", "three"]);
  });
});

describe("markdownRefs", () => {
  const refs = (src: string): string[] =>
    markdownRefs(src).map((r) => `${r.kind}:${r.value}@${String(r.line)}`);

  it("takes the link's DESTINATION, not the code span in its text", () => {
    // The live defect (microsoft/power-platform-skills, rohitg00/pro-workflow):
    // the label was reported as a missing resource while the destination — the
    // thing the reader actually follows — resolved.
    const src =
      "See [`references/api.md` § Lookups](../b/references/api.md#lookups) now.";
    expect(refs(src)).toEqual(["link:../b/references/api.md#lookups@1"]);
  });

  it("still emits a code span that stands on its own in prose", () => {
    expect(refs("Run `scripts/run.sh` first.")).toEqual([
      "code:scripts/run.sh@1",
    ]);
  });

  it("does not read link syntax that is itself inside a code span", () => {
    // `- [ ] [Phase N: Title](phase-N.md)` documents a FORMAT; there is no link.
    expect(refs("Match `- [ ] [Phase N: Title](phase-N.md)` exactly.")).toEqual(
      ["code:- [ ] [Phase N: Title](phase-N.md)@1"],
    );
  });

  it("reads an image src and drops a code span in its alt text", () => {
    expect(refs("![`assets/label.png`](assets/real.png)")).toEqual([
      "link:assets/real.png@1",
    ]);
  });

  it("reports the exact line, not the paragraph's first line", () => {
    const src = ["intro", "See [x](a/b.md) here", "tail"].join("\n");
    expect(refs(src)).toEqual(["link:a/b.md@2"]);
  });

  it("contributes nothing from inside a fenced block", () => {
    const src = ["```", "See [x](a/b.md) and `scripts/z.sh`", "```"].join("\n");
    expect(refs(src)).toEqual([]);
  });

  it("does not percent-encode the destination on the way in", () => {
    // The caller reads `%NN` as the signature of a URL or of an escaping
    // EXAMPLE and skips it; markdown-it's default normalizeLink would
    // manufacture that signature for any non-ASCII or space-bearing path.
    // (Both shapes verified against the default parser: `refs/café.md` becomes
    // `refs/caf%C3%A9.md` and `<assets/My Report.pdf>` becomes `%20`-encoded.)
    expect(refs("Read [notes](refs/café.md)")).toEqual(["link:refs/café.md@1"]);
    expect(refs("Read [a report](<assets/My Report.pdf>)")).toEqual([
      "link:assets/My Report.pdf@1",
    ]);
  });

  it("still yields a destination for a scheme markdown-it distrusts", () => {
    // validateLink's default REFUSES to build the token at all, which would
    // turn "a destination this tool declines to resolve" into "no destination",
    // silently changing behaviour versus the regex this replaces.
    expect(refs("Read [x](javascript:evil.md)")).toEqual([
      "link:javascript:evil.md@1",
    ]);
  });

  it("keeps a link with a title, which the regex it replaces could not match", () => {
    expect(refs('Read [a](refs/b.md "the title")')).toEqual([
      "link:refs/b.md@1",
    ]);
  });
});
