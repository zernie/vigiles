/** `commentOnlyDrift` on planted pairs of texts, one per rule of the verdict. */
import { describe, expect, it } from "vitest";
import {
  commentOnlyDrift,
  DIRECTIVE_MARKERS,
  isDirective,
  scriptKindOf,
} from "./comment-only-drift.js";

const kindOf = (path: string, before: string, after: string): string => {
  const d = commentOnlyDrift(path, before, after);
  return d.kind === "not-comment-only" ? `${d.kind}:${d.why}` : d.kind;
};

describe("commentOnlyDrift: comment-only changes", () => {
  it("accepts a changed line comment, block comment and JSDoc", () => {
    // Guards: a line comment is trivia.
    expect(
      kindOf("a.ts", "// old\nconst a = 1;\n", "// new\nconst a = 1;\n"),
    ).toBe("comment-only");
    // Guards: a block comment between tokens on one line is trivia.
    expect(kindOf("a.ts", "f(/* x */ 1);", "f(/* y */ 1);")).toBe(
      "comment-only",
    );
    // Guards: JSDoc is a comment, not a token, though the parser attaches nodes for it.
    expect(
      kindOf(
        "a.ts",
        "/** Old. @param a one */\nexport function f(a: number) { return a; }\n",
        "/** New text. @param a the first */\nexport function f(a: number) { return a; }\n",
      ),
    ).toBe("comment-only");
  });

  it("accepts whitespace inside a line and a comment added at the start of the file", () => {
    // Guards: spaces between tokens are not tokens.
    expect(kindOf("a.js", "const a=1;", "const  a = 1 ;")).toBe("comment-only");
    // Guards: a comment at position 0 is read once, not as both leading and trailing.
    expect(kindOf("a.js", "x();\n", "/* header */\nx();\n")).toBe(
      "comment-only",
    );
  });

  it("accepts a plain comment changed beside an unchanged directive", () => {
    const before =
      "// @ts-expect-error old reason\nconst a: string = 1;\n// note\n";
    const after =
      "// @ts-expect-error old reason\nconst a: string = 1;\n// other note\n";
    // Guards: only a directive that DIFFERS refuses; one present on both sides is the same code.
    expect(kindOf("a.ts", before, after)).toBe("comment-only");
  });

  it("reads a comment in JSX as a comment and in TSX too", () => {
    // Guards: a JSX expression comment is trivia.
    expect(
      kindOf(
        "a.jsx",
        "const x = <a>{/* one */}</a>;",
        "const x = <a>{/* two */}</a>;",
      ),
    ).toBe("comment-only");
    expect(
      kindOf(
        "a.tsx",
        "const x = <a>{/* one */}</a>;",
        "const x = <a>{/* two */}</a>;",
      ),
    ).toBe("comment-only");
  });
});

describe("commentOnlyDrift: code changes", () => {
  it("refuses a changed token, string or template", () => {
    // Guards: a literal differs.
    expect(kindOf("a.ts", "const a = 1;", "const a = 2;")).toBe(
      "not-comment-only:tokens",
    );
    // Guards: `//` inside a string is not a comment.
    expect(kindOf("a.ts", 'const u = "a//b";', 'const u = "a//c";')).toBe(
      "not-comment-only:tokens",
    );
    // Guards: a template's text is a token.
    expect(kindOf("a.ts", "const t = `a${b}c`;", "const t = `a${b}d`;")).toBe(
      "not-comment-only:tokens",
    );
  });

  it("refuses the regex trap a bare scanner reads as a comment", () => {
    // Guards: with parse context `/[//]b/` is a regex, so b → c is a code change.
    expect(kindOf("a.ts", "const r = /[//]b/;\n", "const r = /[//]c/;\n")).toBe(
      "not-comment-only:tokens",
    );
  });

  it("refuses a line break added before a token (it can end a statement)", () => {
    // Guards: `a\n(b)` and `a(b)` are the same tokens but not the same program under ASI.
    expect(kindOf("a.js", "let x = a\n(b)\n", "let x = a(b)\n")).toBe(
      "not-comment-only:tokens",
    );
  });

  it("refuses changed JSX text", () => {
    // Guards: JSX text is rendered, so it is a token.
    expect(
      kindOf("a.tsx", "const x = <a>hi</a>;", "const x = <a>bye</a>;"),
    ).toBe("not-comment-only:tokens");
  });
});

describe("commentOnlyDrift: directives", () => {
  it("refuses an added, removed or changed directive comment", () => {
    const code = "const a: string = 1;\n";
    // Guards: adding a directive changes what the checker reports.
    expect(kindOf("a.ts", code, `// @ts-expect-error\n${code}`)).toBe(
      "not-comment-only:directive",
    );
    // Guards: removing one counts the same way.
    expect(kindOf("a.ts", `// eslint-disable-next-line\n${code}`, code)).toBe(
      "not-comment-only:directive",
    );
    // Guards: a changed pure annotation changes what a bundler keeps.
    expect(kindOf("a.js", "/*#__PURE__*/ f();", "/* plain */ f();")).toBe(
      "not-comment-only:directive",
    );
  });

  it("refuses a changed shebang, which decides how the file runs", () => {
    // Guards: a shebang is trivia to the parser but not to the shell.
    expect(
      kindOf(
        "a.mjs",
        "#!/usr/bin/env node\nrun();\n",
        "#!/usr/bin/env bun\nrun();\n",
      ),
    ).toBe("not-comment-only:directive");
  });

  it("reads every listed marker as a directive and a plain comment as none", () => {
    // Guards: the list is what isDirective matches, marker by marker.
    expect(DIRECTIVE_MARKERS.filter((m) => !isDirective(`// ${m} x`))).toEqual(
      [],
    );
    expect(isDirective("// just a note")).toBe(false);
  });
});

describe("commentOnlyDrift: what it cannot read", () => {
  it("calls a text with a syntax error unparsable, on either side", () => {
    // Guards: a parse error is never taken as comment-only.
    expect(kindOf("a.ts", "const = ;", "const a = 1;")).toBe("unparsable");
    expect(kindOf("a.ts", "const a = 1;", "function (")).toBe("unparsable");
  });

  it("does not read a language outside JS/TS", () => {
    // Guards: a Python or extension-less file is never decided by a JS parser.
    expect(kindOf("a.py", "# a\nx = 1\n", "# b\nx = 1\n")).toBe(
      "language-not-supported",
    );
    expect(kindOf("Makefile", "a", "b")).toBe("language-not-supported");
  });

  it("maps every JS/TS extension to a script kind, case-insensitively", () => {
    const paths = [
      "a.ts",
      "a.mts",
      "a.cts",
      "a.tsx",
      "a.js",
      "a.mjs",
      "a.cjs",
      "a.jsx",
      "A.TS",
    ];
    // Guards: each extension of the design's list is read.
    expect(paths.filter((p) => scriptKindOf(p) === undefined)).toEqual([]);
    expect(scriptKindOf("a.d")).toBeUndefined();
  });
});
