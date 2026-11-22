/**
 * The reference graph as STATES on typed values: each case is a tree, a source
 * and the resolutions it yields, with the place (`from`, 1-based `line`) every
 * edge carries (#442). No disk: the tree is a list, which is the point — a
 * wrong-case name is caught the same on a case-insensitive filesystem.
 */
import { describe, expect, it } from "vitest";

import type { NamedImport } from "./instruction-chain.js";
import {
  brokenImports,
  isBrokenReference,
  isNotedReference,
  referenceFinding,
  referenceGraph,
  type ReferenceSource,
  type Resolution,
} from "./reference-graph.js";
import { repoTreeOf } from "./repo-tree.js";

const instruction = (path: string, ...lines: string[]): ReferenceSource => ({
  path,
  role: "instruction",
  text: lines.join("\n"),
});

/** The one field of a resolution that names a path, or `""`. */
function detailOf(res: Resolution): string {
  switch (res.status) {
    case "case-mismatch":
      return res.actual;
    case "missing":
      return res.didYouMean ?? "";
    case "elsewhere":
      return res.at.join(",");
    case "in-submodule":
      return res.submodule;
    case "resolved":
      return res.at;
    case "machine-local":
    case "outside-repo":
      return "";
  }
}

/** `[from:line kind written → status(detail)]` per edge. */
function graph(
  paths: readonly string[],
  sources: readonly ReferenceSource[],
  imports: readonly NamedImport[] = [],
  submodules: readonly string[] = [],
): readonly string[] {
  return referenceGraph({
    sources,
    imports,
    files: Object.fromEntries(sources.map((s) => [s.path, s.text])),
    tree: repoTreeOf(paths, submodules),
  }).map(
    (r) =>
      `${r.from}:${String(r.line)} ${r.kind} ${r.written} → ${r.resolution.status}(${detailOf(r.resolution)})`,
  );
}

describe("referenceGraph — links and mentions of an instruction file", () => {
  it("a pointer at a missing file is `missing` at its file and line", () => {
    expect(
      graph(
        ["web/AGENTS.md"],
        [instruction("web/AGENTS.md", "# Web", "", "Read `web/CLAUDE.md`.")],
      ),
    ).toEqual(["web/AGENTS.md:3 mention web/CLAUDE.md → missing()"]);
  });

  it("a wrong-case name is `case-mismatch` naming the real file, from the list alone", () => {
    expect(
      graph(
        ["AGENTS.md", ".agent/CLAUDE.md"],
        [instruction(".agent/CLAUDE.md", "See [agents](../agents.md).")],
      ),
    ).toEqual([
      ".agent/CLAUDE.md:1 link ../agents.md → case-mismatch(AGENTS.md)",
    ]);
  });

  it("a moved directory gets a did-you-mean from its siblings", () => {
    expect(
      graph(
        ["docs/README.md", "docs/source/a.md", "test/a.ts"],
        [
          instruction(
            "docs/README.md",
            "x",
            "In `docs/sources/`, not `dist/`.",
          ),
        ],
      ),
    ).toEqual([
      "docs/README.md:2 mention docs/sources/ → missing(docs/source/)",
      // Two edits away, but half of a four-letter name: no suggestion.
      "docs/README.md:2 mention dist/ → missing()",
    ]);
  });
});

describe("referenceGraph — where a link and a mention are looked for", () => {
  it("a mention resolves from the file's directory or the root; a link only from the file's", () => {
    expect(
      graph(
        ["pkg/AGENTS.md", "src/a.ts", "pkg/b.ts", "README.md"],
        [
          instruction(
            "pkg/AGENTS.md",
            "Edit `src/a.ts` and `b.ts:12`.",
            "See [readme](README.md).",
          ),
        ],
      ),
    ).toEqual([
      "pkg/AGENTS.md:1 mention src/a.ts → resolved(src/a.ts)",
      "pkg/AGENTS.md:1 mention b.ts:12 → resolved(pkg/b.ts)",
      "pkg/AGENTS.md:2 link README.md → elsewhere(README.md)",
    ]);
  });

  it("a mention whose name exists only under another directory is `elsewhere`", () => {
    expect(
      graph(
        ["CLAUDE.md", "packages/x/scripts/check.sh"],
        [instruction("CLAUDE.md", "Run `scripts/check.sh`.")],
      ),
    ).toEqual([
      "CLAUDE.md:1 mention scripts/check.sh → elsewhere(packages/x/scripts/check.sh)",
    ]);
  });
});

describe("referenceGraph — what makes no edge, or no finding", () => {
  it("a path inside a submodule is a note; one leaving the directory is silent", () => {
    expect(
      graph(
        ["CLAUDE.md"],
        [
          instruction(
            "CLAUDE.md",
            "See `vendor/lib/a.md` and [up](../../x.md).",
          ),
        ],
        [],
        ["vendor/lib"],
      ),
    ).toEqual([
      "CLAUDE.md:1 mention vendor/lib/a.md → in-submodule(vendor/lib)",
      "CLAUDE.md:1 link ../../x.md → outside-repo()",
    ]);
  });

  it("counts lines of the REAL file past the frontmatter", () => {
    const src = instruction(
      ".agent/rules/a.md",
      "---",
      "paths: ['src/**']",
      "---",
      "",
      "Read `src/gone.ts`.",
    );
    expect(graph([], [src])).toEqual([
      ".agent/rules/a.md:5 mention src/gone.ts → missing()",
    ]);
  });

  it("makes no edge for a URL, anchor, absolute, home, variable, glob, placeholder, scope or prose span", () => {
    const src = instruction(
      "CLAUDE.md",
      "[a](https://x.io/a.md) [b](#top) [c](/etc/x.md) [d](mailto:a@b.c)",
      "`~/.agent/x.md` `$HOME/x.md` `src/**/*.ts` `<name>.md` `%20.md`",
      "`@scope/pkg` `npm run build` `Node` `v1.2.3` `--out/x`",
      "`vigiles/hook` `owner/repo` `.spec.ts` `.d.ts`",
    );
    expect(graph([], [src])).toEqual([]);
  });

  it("reads nothing inside fenced, indented or commented-out code", () => {
    const src = instruction(
      "CLAUDE.md",
      "```",
      "`gone/a.md`",
      "```",
      "",
      "    `gone/b.md`",
      "",
      "<!-- `gone/c.md` -->",
    );
    expect(graph([], [src])).toEqual([]);
  });
});

const imp = (over: Partial<NamedImport>): NamedImport => ({
  path: "docs/style.md",
  token: "@docs/style.md",
  from: ".agent/CLAUDE.md",
  ...over,
});

describe("referenceGraph — imports the chain reported", () => {
  it("resolves an import from the importing file's directory, at the adapter's line", () => {
    expect(
      graph(
        [".agent/docs/style.md"],
        [],
        [imp({ line: 12 }), imp({ from: "CLAUDE.md", line: 3 })],
      ),
    ).toEqual([
      ".agent/CLAUDE.md:12 import @docs/style.md → resolved(.agent/docs/style.md)",
      "CLAUDE.md:3 import @docs/style.md → missing()",
    ]);
  });

  it("places an import reported without a line on the first line holding its token", () => {
    const src = instruction(
      "settings.json",
      "{",
      '  "instructions": ["gone.md"]',
      "}",
    );
    expect(
      graph([], [], [{ path: "gone.md", token: "gone.md", from: src.path }])
        .length,
    ).toBe(1);
    const [edge] = referenceGraph({
      sources: [],
      imports: [{ path: "gone.md", token: "gone.md", from: src.path }],
      files: { [src.path]: src.text },
      tree: repoTreeOf([]),
    });
    expect(edge?.line).toBe(2);
  });

  it("a missing one-machine import is never reported", () => {
    expect(
      graph([], [], [imp({ token: "@AGENTS.local.md", scope: "local" })]),
    ).toEqual([".agent/CLAUDE.md:1 import @AGENTS.local.md → machine-local()"]);
  });
});

describe("the predicates over references", () => {
  it("brokenImports keeps the broken imports only; the predicates split findings from notes", () => {
    const refs = referenceGraph({
      sources: [instruction("CLAUDE.md", "`vendor/x/a.md` `gone/b.md`")],
      imports: [imp({ from: "CLAUDE.md", line: 2 })],
      files: {},
      tree: repoTreeOf([], ["vendor/x"]),
    });
    expect(brokenImports(refs).map((r) => r.written)).toEqual([
      "@docs/style.md",
    ]);
    expect(refs.filter(isBrokenReference).map((r) => r.written)).toEqual([
      "gone/b.md",
      "@docs/style.md",
    ]);
    expect(refs.filter(isNotedReference).map((r) => r.written)).toEqual([
      "vendor/x/a.md",
    ]);
  });
});

describe("referenceFinding", () => {
  const refs = referenceGraph({
    sources: [
      instruction(
        "pkg/CLAUDE.md",
        "`docs/a.md` [b](../B.md) `docs/sourc/` `x/y.md` `vendor/m/a.md` `ok.md`",
      ),
    ],
    imports: [],
    files: {},
    tree: repoTreeOf(
      ["b.md", "docs/source/z.md", "q/x/y.md", "pkg/ok.md"],
      ["vendor/m"],
    ),
  });

  it("a broken reference is a finding at its place, a noted one a note, a resolved one nothing", () => {
    const found = refs.map((r) => referenceFinding(r, "it costs."));
    expect(
      found.map((f) => f && [f.kind, f.path, f.line, f.subject, f.message]),
    ).toEqual([
      ["finding", "pkg/CLAUDE.md", 1, "`docs/a.md`", "missing — it costs."],
      [
        "finding",
        "pkg/CLAUDE.md",
        1,
        "../B.md",
        "wrong case: the file is `b.md`, so it resolves only on a case-insensitive disk — it costs.",
      ],
      [
        "finding",
        "pkg/CLAUDE.md",
        1,
        "`docs/sourc/`",
        "missing; did you mean `docs/source/`? — it costs.",
      ],
      [
        "note",
        "pkg/CLAUDE.md",
        1,
        "`x/y.md`",
        "not found from here; it exists at `q/x/y.md`.",
      ],
      [
        "note",
        "pkg/CLAUDE.md",
        1,
        "`vendor/m/a.md`",
        "inside the submodule `vendor/m`, whose files this scan does not hold.",
      ],
      undefined,
    ]);
    expect(found[1]?.reference).toEqual({
      kind: "link",
      target: "../B.md",
      resolution: { status: "case-mismatch", actual: "b.md" },
    });
  });
});
