/**
 * Tests for the inline-rule parser.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import {
  AUTHOR_MARKS,
  type MarkKind,
  VIGILES_MARKS,
  hasInlineRules,
  parseInlineRules,
} from "./inline.js";
import { parseMcpRefs } from "./mcp.js";
import { symbolRefs } from "./refs.js";

describe("parseInlineRules", () => {
  it("extracts a single enforce comment", () => {
    const { rules, errors } = parseInlineRules(
      `# Project

<!-- vigiles:enforce eslint/no-console "Use structured logger" -->

## Logging

All output through logger.ts.
`,
    );
    assert.equal(errors.length, 0);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-console");
    assert.equal(rules[0].why, "Use structured logger");
    assert.equal(rules[0].line, 3);
  });

  it("extracts multiple enforce comments and tracks line numbers", () => {
    const content = `# Doc
<!-- vigiles:enforce eslint/no-console "a" -->
text
<!-- vigiles:enforce ruff/F401 "b" -->
`;
    const { rules, errors } = parseInlineRules(content);
    assert.equal(errors.length, 0);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].linterRule, "eslint/no-console");
    assert.equal(rules[0].line, 2);
    assert.equal(rules[1].linterRule, "ruff/F401");
    assert.equal(rules[1].line, 4);
  });

  it("supports plugin-scoped rule names with slashes", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:enforce eslint/@typescript-eslint/no-floating-promises "Await or void" -->`,
    );
    assert.equal(errors.length, 0);
    assert.equal(rules.length, 1);
    assert.equal(
      rules[0].linterRule,
      "eslint/@typescript-eslint/no-floating-promises",
    );
  });

  it("reports malformed vigiles:enforce as a parse error", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:enforce eslint/no-console no quotes here -->`,
    );
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Malformed vigiles:enforce/);
  });

  it("reports unknown vigiles markers", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:strengthen eslint/no-console -->`,
    );
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Unknown vigiles marker "strengthen"/);
  });

  it("returns empty results for a file with no vigiles comments", () => {
    const { rules, errors } = parseInlineRules(
      `# Plain\n\nJust prose, no rules.\n`,
    );
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 0);
  });

  it("skips the compiled-file hash marker without reporting an error", () => {
    const { rules, errors } = parseInlineRules(
      `<!-- vigiles:sha256:abc123 compiled from CLAUDE.md.spec.ts -->
# Project
<!-- vigiles:enforce eslint/no-console "why" -->
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 1);
  });

  it("ignores vigiles:enforce markers inside fenced code blocks", () => {
    // Illustrative example in docs/markdown-mode.md would otherwise get
    // picked up as a live rule.
    const { rules, errors } = parseInlineRules(
      `# Docs

Example usage:

\`\`\`md
<!-- vigiles:enforce eslint/no-console "Use structured logger" -->
<!-- vigiles:enforce ruff/F401 "No unused imports" -->
\`\`\`

And a real one outside the fence:

<!-- vigiles:enforce eslint/no-eval "Never eval user input" -->
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });

  it("ignores markers inside tilde-fenced code blocks", () => {
    const { rules } = parseInlineRules(
      `~~~md
<!-- vigiles:enforce eslint/no-console "inside fence" -->
~~~
<!-- vigiles:enforce eslint/no-eval "outside fence" -->
`,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });

  it("ignores markers inside inline code spans in prose", () => {
    // Prose that describes the syntax with a backtick-wrapped example
    // must not trigger "malformed vigiles:enforce".
    const { rules, errors } = parseInlineRules(
      `You add \`<!-- vigiles:enforce eslint/no-console "why" -->\` comments to adopt gradually.

Real rule below:

<!-- vigiles:enforce eslint/no-eval "Never eval" -->
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });

  it("ignores ellipsis placeholders inside inline code spans", () => {
    const { rules, errors } = parseInlineRules(
      `You add \`<!-- vigiles:enforce ... -->\` comments to adopt gradually.
`,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(rules.length, 0);
  });

  it("handles nested backtick fences of different lengths", () => {
    // Opening with 4 backticks, closing with 3 inside should NOT close
    // the outer block — only a 4+ backtick close matches.
    const { rules } = parseInlineRules(
      `\`\`\`\`md
\`\`\`
<!-- vigiles:enforce eslint/no-console "inside outer" -->
\`\`\`
\`\`\`\`
<!-- vigiles:enforce eslint/no-eval "outside" -->
`,
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0].linterRule, "eslint/no-eval");
  });
});

describe("hasInlineRules", () => {
  it("returns true when a valid enforce comment exists", () => {
    assert.equal(
      hasInlineRules(`<!-- vigiles:enforce eslint/no-console "why" -->`),
      true,
    );
  });

  it("returns false for plain markdown", () => {
    assert.equal(hasInlineRules(`# Title\n\nparagraph\n`), false);
  });

  it("returns false for a malformed marker", () => {
    assert.equal(
      hasInlineRules(`<!-- vigiles:enforce eslint/no-console no-quotes -->`),
      false,
    );
  });

  it("returns false for markers trapped inside fenced code blocks", () => {
    assert.equal(
      hasInlineRules(
        `# Docs\n\n\`\`\`md\n<!-- vigiles:enforce eslint/no-console "x" -->\n\`\`\`\n`,
      ),
      false,
    );
  });

  it("returns true only for parseable rules outside fences", () => {
    assert.equal(
      hasInlineRules(
        `\`\`\`md\n<!-- vigiles:enforce eslint/no-console "inside" -->\n\`\`\`\n<!-- vigiles:enforce eslint/no-eval "outside" -->\n`,
      ),
      true,
    );
  });
});

describe("parseInlineRules: file/cmd references", () => {
  it("extracts vigiles:file and vigiles:cmd markers with line numbers", () => {
    const { files, commands } = parseInlineRules(
      `# P\n\nSee <!-- vigiles:file src/util.ts --> here.\nRun <!-- vigiles:cmd "npm run build" --> to compile.\n`,
    );
    assert.deepEqual(
      files.map((f) => f.path),
      ["src/util.ts"],
    );
    assert.equal(files[0].line, 3);
    assert.deepEqual(
      commands.map((c) => c.command),
      ["npm run build"],
    );
    assert.equal(commands[0].line, 4);
  });

  it("strips surrounding quotes from a quoted vigiles:file path", () => {
    const { files } = parseInlineRules(
      `# P\n<!-- vigiles:file "src/auth/login.ts" -->\n<!-- vigiles:file 'src/single.ts' -->\n`,
    );
    assert.deepEqual(
      files.map((f) => f.path),
      ["src/auth/login.ts", "src/single.ts"],
    );
  });

  it("ignores file/cmd markers inside fenced code blocks", () => {
    const { files, commands } = parseInlineRules(
      '```md\n<!-- vigiles:file src/inside.ts -->\n<!-- vigiles:cmd "npm run x" -->\n```\n<!-- vigiles:file src/outside.ts -->\n',
    );
    assert.deepEqual(
      files.map((f) => f.path),
      ["src/outside.ts"],
    );
    assert.equal(commands.length, 0);
  });

  it("hasInlineRules is true for a file with only a file marker", () => {
    assert.equal(
      hasInlineRules(`# P\n<!-- vigiles:file src/only.ts -->\n`),
      true,
    );
  });

  it("does not flag skill-runtime / opt-out markers as unknown", () => {
    const md = `# Skill
<!-- vigiles:result "npm test" -->
<!-- vigiles:gate "pytest" -->
<!-- vigiles:ignore-file -->`;
    const { errors } = parseInlineRules(md);
    assert.equal(errors.length, 0);
    // ...but a genuinely unknown marker is still surfaced.
    const bogus = parseInlineRules(`<!-- vigiles:bogus thing -->`);
    assert.ok(
      bogus.errors.some((e) => /Unknown vigiles marker/.test(e.message)),
    );
  });
});

describe("parseInlineRules: marks read elsewhere", () => {
  it("names the span syntax when a span mark is written as a comment", () => {
    const { errors } = parseInlineRules("<!-- vigiles:symbol src/a.ts#f -->");
    // Guards: a comment-form symbol mark verifies nothing, so it must not pass silently.
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /code span/);
    assert.ok(errors[0].message.includes(VIGILES_MARKS.symbol.syntax));
  });

  it("reports a mark no subsystem reads as unknown", () => {
    const { errors } = parseInlineRules("<!-- vigiles:disable -->");
    // Guards: a mark nothing reads is an error, not a silent skip.
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Unknown vigiles marker "disable"/);
  });

  it("leaves the marks compile writes to their readers", () => {
    const { errors } = parseInlineRules(
      [
        "<!-- vigiles:purity:pure -->",
        "<!-- vigiles:effect -->",
        "<!-- /vigiles:effect -->",
      ].join("\n"),
    );
    // Guards: a compiled purity floor or effect region copied into a
    // hand-written file is not reported as an unknown mark.
    assert.deepEqual(errors, []);
  });
});

// --- #641: every mark a person writes is documented, and its example parses --

const REPO = join(import.meta.dirname, "..", "..");
const MARKS_DOC = join(REPO, "docs", "verifying-instruction-files.md");

type ReferenceKind = {
  [K in MarkKind]: (typeof VIGILES_MARKS)[K] extends { role: "reference" }
    ? K
    : never;
}[MarkKind];

/** How many marks of its own kind the module that reads `kind` finds in `md`. */
const READ_BACK = {
  enforce: (md: string) => parseInlineRules(md).rules.length,
  file: (md: string) => parseInlineRules(md).files.length,
  cmd: (md: string) => parseInlineRules(md).commands.length,
  symbol: (md: string) => symbolRefs(md).length,
  mcp: (md: string) => parseMcpRefs(md).length,
} satisfies Record<ReferenceKind, (md: string) => number>;

function isReferenceKind(kind: MarkKind): kind is ReferenceKind {
  return Object.hasOwn(READ_BACK, kind);
}

const parser = new MarkdownIt({ html: true });
type Token = ReturnType<MarkdownIt["parse"]>[number];

/** The `vigiles:<kind>` a heading names, when its whole text is that code span. */
function headingMark(inline: Token | undefined): string | null {
  const kids = inline?.children ?? [];
  const only = kids.length === 1 ? kids[0] : undefined;
  return only?.type === "code_inline" ? only.content : null;
}

interface MarkSection {
  readonly source: string;
  readonly markdownExamples: readonly string[];
}

/** Each `#### \`vigiles:<kind>\`` section of the marks doc, by mark text. */
function markSections(src: string): ReadonlyMap<string, MarkSection> {
  const tokens = parser.parse(src, {});
  const lines = src.split("\n");
  const heads = tokens.flatMap((t, i) =>
    t.type === "heading_open" && t.map !== null
      ? [{ i, level: Number(t.tag.slice(1)), line: t.map[0] }]
      : [],
  );
  const out = new Map<string, MarkSection>();
  heads.forEach((h, n) => {
    const name = headingMark(tokens[h.i + 1]);
    if (name === null) return;
    const next = heads.slice(n + 1).find((o) => o.level <= h.level);
    const endLine = next?.line ?? lines.length;
    const endTok = next?.i ?? tokens.length;
    const markdownExamples = tokens
      .slice(h.i, endTok)
      .filter((t) => t.type === "fence" && t.info.trim() === "markdown")
      .map((t) => t.content);
    out.set(name, {
      source: lines.slice(h.line, endLine).join("\n"),
      markdownExamples,
    });
  });
  return out;
}

/** The text of every code span, code block and raw HTML in `src`. */
function codeTexts(src: string): string[] {
  return parser.parse(src, {}).flatMap((t) => {
    if (t.type === "inline") {
      return (t.children ?? [])
        .filter((c) => c.type === "code_inline" || c.type === "html_inline")
        .map((c) => c.content);
    }
    return ["fence", "code_block", "html_block"].includes(t.type)
      ? [t.content]
      : [];
  });
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(e.parentPath, e.name));
}

/** The public pages a reader can find a mark on: README, docs, shipped skills. */
const PAGES = [
  join(REPO, "README.md"),
  ...markdownFiles(join(REPO, "docs")),
  ...markdownFiles(join(REPO, "skills")),
].map((path) => ({ path, texts: codeTexts(readFileSync(path, "utf8")) }));

function namesMark(texts: readonly string[], kind: MarkKind): boolean {
  const mark = new RegExp(`vigiles:${kind}(?![\\w-])`);
  return texts.some((t) => mark.test(t));
}

describe("every mark a person writes is documented (#641)", () => {
  const sections = markSections(readFileSync(MARKS_DOC, "utf8"));

  for (const kind of AUTHOR_MARKS) {
    const spec = VIGILES_MARKS[kind];
    if (spec.writer !== "author") continue;

    it(`vigiles:${kind} has a section that prints its syntax`, () => {
      const section = sections.get(`vigiles:${kind}`);
      // Guards: a mark with no section of its own is one a user cannot find (#639).
      assert.ok(
        section,
        `docs/verifying-instruction-files.md has no \`vigiles:${kind}\` heading`,
      );
      assert.ok(
        section.source.includes(spec.syntax),
        `the vigiles:${kind} section does not print ${spec.syntax}`,
      );
    });

    it(`vigiles:${kind} is named on at least two public pages`, () => {
      const pages = PAGES.filter((p) => namesMark(p.texts, kind));
      // Guards: one mention is a page nobody lands on; two give a way in.
      assert.ok(
        pages.length >= 2,
        `vigiles:${kind} is named on ${String(pages.length)} page(s)`,
      );
    });

    if (!isReferenceKind(kind)) continue;
    it(`vigiles:${kind}: the documented example reads back as that mark`, () => {
      const examples = sections.get(`vigiles:${kind}`)?.markdownExamples ?? [];
      // Guards: a docs example the parser ignores teaches a mark that verifies nothing.
      assert.ok(
        examples.length > 0,
        `the vigiles:${kind} section has no markdown example`,
      );
      for (const example of examples) {
        assert.ok(
          READ_BACK[kind](example) > 0,
          `example not read as vigiles:${kind}:\n${example}`,
        );
        assert.deepEqual(parseInlineRules(example).errors, []);
      }
    });
  }
});
