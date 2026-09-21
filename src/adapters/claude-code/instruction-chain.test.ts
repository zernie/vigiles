/**
 * Claude Code's instruction chain, against the vendor rules quoted in its own
 * header — one file, one surface.
 *
 * `alwaysLoaded`, the thing this replaced, had ZERO tests: the walk that
 * expanded it could not have one, because the adapter DROVE the walk and there
 * was no input to hand it. That is the shape of the defect as much as the walk
 * itself, so the replacement arrives with its cases stated.
 */
import { describe, it, expect } from "vitest";

import { claudeCodeLayout } from "./layout.js";
import { localSiblingOf } from "./instruction-chain.js";

const chain = (files: Record<string, string>) =>
  claudeCodeLayout.instructionChain(files);
const paths = (files: Record<string, string>) =>
  chain(files).loaded.map((e) => e.path);

describe("what loads, and in what order", () => {
  it("the root file, the dot-dir file, the rules, then the per-machine file LAST", () => {
    // The one ordering fact the vendor states: "CLAUDE.local.md is appended
    // after CLAUDE.md, so your personal notes are the last thing Claude reads
    // at that level."
    expect(
      paths({
        "CLAUDE.md": "root",
        ".claude/CLAUDE.md": "dot",
        ".claude/rules/b.md": "b",
        ".claude/rules/a.md": "a",
        "CLAUDE.local.md": "mine",
      }),
    ).toEqual([
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      ".claude/rules/a.md",
      ".claude/rules/b.md",
      "CLAUDE.local.md",
    ]);
  });

  it("reads the rules dir RECURSIVELY", () => {
    // Vendor: all `.md` files under a rules directory are discovered
    // recursively. The flat classifier this pairs with used to stop at depth 1,
    // so a nested rule was read and classified by nothing.
    expect(paths({ ".claude/rules/team/deep/x.md": "x" })).toEqual([
      ".claude/rules/team/deep/x.md",
    ]);
  });

  it("marks a per-machine file `local`, and everything else `repo`", () => {
    expect(
      chain({ "CLAUDE.md": "a", "CLAUDE.local.md": "b" }).loaded.map((e) => [
        e.role,
        e.scope,
      ]),
    ).toEqual([
      ["root", "repo"],
      ["root-local", "local"],
    ]);
  });

  it("derives the per-machine name from the instruction file", () => {
    expect(localSiblingOf(claudeCodeLayout.instructionFile)).toBe(
      "CLAUDE.local.md",
    );
  });
});

describe("what does NOT load, and why", () => {
  it("a `paths:`-scoped rule is on-demand, not always-loaded", () => {
    const files = {
      ".claude/rules/scoped.md": '---\npaths: ["src/**"]\n---\nbody',
    };
    expect(paths(files)).toEqual([]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "on-demand",
      when: "path-scoped",
    });
  });

  it("a rule with OTHER frontmatter still loads — only `paths:` scopes it", () => {
    expect(paths({ ".claude/rules/x.md": "---\ntitle: x\n---\nbody" })).toEqual(
      [".claude/rules/x.md"],
    );
  });

  it("a subdirectory's CLAUDE.md is reported on-demand when handed over", () => {
    // The bound never enumerates one; a caller with a wider map gets the honest
    // answer rather than silence or a false "always".
    const files = { "CLAUDE.md": "root", "pkg/CLAUDE.md": "nested" };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded).toEqual([
      {
        path: "pkg/CLAUDE.md",
        role: "root",
        scope: "repo",
        reason: { kind: "on-demand", when: "subdirectory" },
      },
    ]);
  });

  it("`claudeMdExcludes` from the repo's own settings removes a file", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/rules/vendor.md": "theirs",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/vendor.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "excluded-by-settings",
      key: "claudeMdExcludes",
    });
  });

  it("the LOCAL settings file can exclude too — advisory, and it can only narrow", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.local.json": JSON.stringify({
        claudeMdExcludes: ["**/CLAUDE.md"],
      }),
    };
    expect(paths(files)).toEqual([]);
  });

  it("an ABSOLUTE-path exclude pattern is not applied, and the file is COUNTED", () => {
    // The vendor matches these against absolute paths; the chain holds
    // repo-relative keys. Guessing a root would be inventing a fact, so the
    // pattern is left unapplied — which OVER-reports. That is the safe
    // direction: an under-report reads as "you are fine".
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["/home/me/repo/CLAUDE.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
  });

  it("an unparseable settings file excludes nothing rather than throwing", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.json": "{ not json",
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
  });

  it("a settings file whose excludes key is the wrong TYPE is ignored", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.json": JSON.stringify({ claudeMdExcludes: "**/x.md" }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
  });
});

describe("imports: the repo owner names the path, the adapter only finds it", () => {
  it("reports an `@path` token whether or not the file was read", () => {
    expect(chain({ "CLAUDE.md": "see @docs/style.md" }).imports).toEqual([
      { path: "docs/style.md", token: "@docs/style.md", from: "CLAUDE.md" },
    ]);
  });

  it("loads an import that IS in the map — ONE level, not the import of an import", () => {
    // Deliberate: a transitive import is a real feature and is NOT counted. Of
    // 198 real CLAUDE.md files measured, six carried an import at all and every
    // one was a single concrete path at depth 1. See `resolveImports`.
    expect(
      paths({
        "CLAUDE.md": "@docs/a.md",
        "docs/a.md": "@docs/b.md",
        "docs/b.md": "leaf",
      }),
    ).toEqual(["CLAUDE.md", "docs/a.md"]);
  });

  it("@AGENTS.md — the shape 4 of those 6 real imports actually have", () => {
    // The known workaround for Claude Code not auto-loading AGENTS.md
    // (anthropics/claude-code#34235). It is in nobody's always-loaded set, so
    // skipping imports would miss its whole size — an under-report, which reads
    // as "you are fine".
    expect(paths({ "CLAUDE.md": "@AGENTS.md", "AGENTS.md": "shared" })).toEqual(
      ["CLAUDE.md", "AGENTS.md"],
    );
  });

  /**
   * 🔴 THE RATCHET. Every entry below is THE SAME FILE and must be read
   * identically. A pattern anchored at column zero, or an equality against the
   * raw line, answers "not an import" on five of the six and turns nothing red —
   * so a single `@AGENTS.md` case at column zero would prove nothing about the
   * rewrite that breaks them.
   *
   * What makes them pass is that the reading goes through `core/markdown.ts`:
   * CommonMark block parsing strips the indent, normalises CRLF, and drops
   * trailing whitespace and trailing blank lines. The BOM is the one the parser
   * does NOT strip, which is why `proseLines` strips it and why it is listed
   * here rather than assumed.
   */
  it.each([
    ["column zero", "@AGENTS.md"],
    ["indented", "  @AGENTS.md"],
    ["trailing spaces", "@AGENTS.md  "],
    ["CRLF line ending", "@AGENTS.md\r\n"],
    ["UTF-8 BOM", "\uFEFF@AGENTS.md"],
    ["trailing blank lines", "@AGENTS.md\n\n\n"],
    ["after a heading", "# Project\n\n@AGENTS.md\n"],
  ])("recognises the same import written with %s", (_name, body) => {
    expect(chain({ "CLAUDE.md": body }).imports.map((i) => i.path)).toEqual([
      "AGENTS.md",
    ]);
  });

  /**
   * The inverse, and it is measured: a loose `@` over 198 real CLAUDE.md files
   * matches Python decorators, Blade templates, npm scopes and CSS at-rules —
   * every one of them inside a fenced code block. The parser removes those
   * before the pattern runs, which is the reason to parse rather than scan.
   */
  it.each([
    ["a fenced code block", "```py\n@dataclass\nclass X: pass\n```\n"],
    [
      "a four-backtick block holding a bare fence",
      "````\n```\n@media.md\n```\n````\n",
    ],
    ["an inline code span", "use `@config.md` as the example\n"],
    ["an HTML comment", "<!--\n@SECRET.md\n-->\n"],
    ["a bare mention", "ask @zernie about it\n"],
    ["an email address", "write to me@example.com\n"],
    ["frontmatter", '---\nsee: "@SECRET.md"\n---\nbody\n'],
  ])("does NOT read %s as an import", (_name, body) => {
    expect(chain({ "CLAUDE.md": body }).imports).toEqual([]);
  });

  it("refuses a token that leaves the repository", () => {
    expect(
      chain({ "CLAUDE.md": "@../escape.md @~/notes.md @/etc/x.md" }).imports,
    ).toEqual([]);
  });

  it("an import pulled in by the LOCAL file inherits its scope", () => {
    // It is a committed file, but it only loads because a gitignored one names
    // it — so a teammate does not load it, and it must not be in the committed
    // total either.
    const files = {
      "CLAUDE.md": "root",
      "CLAUDE.local.md": "@docs/mine.md",
      "docs/mine.md": "personal",
    };
    expect(chain(files).loaded.map((e) => [e.path, e.scope])).toEqual([
      ["CLAUDE.md", "repo"],
      ["CLAUDE.local.md", "local"],
      ["docs/mine.md", "local"],
    ]);
  });

  it("an excluded import is reported as excluded, not loaded", () => {
    const files = {
      "CLAUDE.md": "@docs/vendor.md",
      "docs/vendor.md": "theirs",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/vendor.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded.map((e) => [e.path, e.role])).toEqual([
      ["docs/vendor.md", "import"],
    ]);
  });
});

describe("a CLAUDE.md that is NOTHING BUT an import is a REDIRECT", () => {
  // 🔴 THE FINDING, NOT THE NUMBER. Four of the six real imports measured are
  // `@AGENTS.md`, because Claude Code does not auto-load AGENTS.md
  // (anthropics/claude-code#34235), and the idiom that follows is a CLAUDE.md
  // holding that one line. Reported as a size, such a repo has a fourteen-byte
  // instruction file — a confident wrong answer about a repository that really
  // loads tens of kilobytes.
  it.each([
    ["the bare line", "@AGENTS.md\n"],
    ["indented, CRLF, trailing blanks", "  @AGENTS.md  \r\n\n"],
    [
      "with a maintainer comment above it",
      "<!-- see AGENTS.md -->\n\n@AGENTS.md\n",
    ],
    ["with frontmatter above it", "---\ntitle: pointer\n---\n\n@AGENTS.md\n"],
  ])("is detected when written as %s", (_name, body) => {
    expect(
      chain({ "CLAUDE.md": body, "AGENTS.md": "the real thing" }).redirects,
    ).toEqual([{ path: "CLAUDE.md", to: ["AGENTS.md"] }]);
  });

  it("names EVERY file it points at, not just the first", () => {
    expect(
      chain({
        "CLAUDE.md": "@a.md\n@b.md\n",
        "a.md": "one",
        "b.md": "two",
      }).redirects,
    ).toEqual([{ path: "CLAUDE.md", to: ["a.md", "b.md"] }]);
  });

  // The other half. A rule that fires on a file with real content in it would be
  // worse than no rule: it would be switched off the first week.
  it.each([
    [
      "one line of prose beside the import",
      "@AGENTS.md\n\nAlso: never force-push.\n",
    ],
    ["a heading above it", "# Rules\n\n@AGENTS.md\n"],
    ["no import at all", "Just ordinary instructions.\n"],
    ["an empty file", ""],
    ["frontmatter only", "---\ntitle: x\n---\n"],
  ])("is NOT claimed for a file with %s", (_name, body) => {
    expect(chain({ "CLAUDE.md": body, "AGENTS.md": "real" }).redirects).toEqual(
      [],
    );
  });

  it("is still a redirect when the target is MISSING — that is the worst case, not an exception", () => {
    // 🔴 I ASSERTED THE OPPOSITE FIRST AND THE CODE WAS RIGHT. A pointer at a
    // file that is not there is exactly where a bare size lies hardest: the
    // repository looks like it has a fourteen-byte instruction file AND nothing
    // tells you the thing it points at is gone. Reporting both — "this is a
    // redirect to GONE.md" and "1 named import not read: GONE.md" — is the only
    // output a reader can act on.
    expect(chain({ "CLAUDE.md": "@GONE.md\n" }).redirects).toEqual([
      { path: "CLAUDE.md", to: ["GONE.md"] },
    ]);
  });
});
