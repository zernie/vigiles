/**
 * `importResolution` / `unresolvedImports` — whether an import's resolved path
 * is in the repository, asked of a directory LISTING so a name that matches
 * only when case is ignored is told apart from one that does not exist.
 */
import { describe, it, expect } from "vitest";

import {
  EMPTY_CHAIN,
  type InstructionViews,
  type NamedImport,
} from "./instruction-chain.js";
import {
  type DirListing,
  importResolution,
  isScoredImport,
  isShownImport,
  listingOfPaths,
  unresolvedImports,
} from "./instruction-imports.js";

const LIST = listingOfPaths(["CLAUDE.md", "docs/style.md", "Guides/intro.md"]);

const imp = (path: string, line = 1): NamedImport => ({
  path,
  token: `@${path}`,
  from: "CLAUDE.md",
  fromScope: "repo",
  line,
});

describe("importResolution", () => {
  it("a path present exactly as written resolves", () => {
    expect(importResolution("docs/style.md", LIST)).toBeNull();
  });

  it("a path nothing matches, in any case, is missing", () => {
    expect(importResolution("docs/gone.md", LIST)).toEqual({
      kind: "missing",
    });
    expect(importResolution("nowhere/style.md", LIST)).toEqual({
      kind: "missing",
    });
  });

  it("a file present under another case is a case mismatch carrying the real name", () => {
    expect(importResolution("docs/Style.md", LIST)).toEqual({
      kind: "case-mismatch",
      actual: "docs/style.md",
    });
  });

  it("a DIRECTORY in the wrong case is a case mismatch too", () => {
    expect(importResolution("guides/intro.md", LIST)).toEqual({
      kind: "case-mismatch",
      actual: "Guides/intro.md",
    });
  });
});

describe("importResolution — the entry an import names must be a FILE", () => {
  it("a DIRECTORY named like the import is not a file, and says so", () => {
    expect(
      importResolution("guide.md", listingOfPaths(["guide.md/nested.md"])),
    ).toEqual({ kind: "not-a-file", is: "dir" });
  });

  it("an entry that is neither a file nor a directory (a dangling symlink) is not a file", () => {
    const tree: Readonly<Record<string, ReturnType<DirListing>>> = {
      "": [{ name: "docs", kind: "dir" }],
      docs: [{ name: "link.md", kind: "other" }],
    };
    const list: DirListing = (dir) => tree[dir] ?? [];
    expect(importResolution("docs/link.md", list)).toEqual({
      kind: "not-a-file",
      is: "other",
    });
  });

  it("a FILE is not walked into as a directory", () => {
    expect(
      importResolution("guide.md/nested.md", listingOfPaths(["guide.md"])),
    ).toEqual({ kind: "missing" });
  });
});

/** Both views naming the same imports, unless the committed one is given. */
const views = (
  effective: readonly NamedImport[],
  committed: readonly NamedImport[] = effective,
): InstructionViews => ({
  effective: { ...EMPTY_CHAIN, imports: effective },
  committed: { ...EMPTY_CHAIN, imports: committed },
});

describe("unresolvedImports", () => {
  it("keeps only the imports that do not resolve, each with its line and reason", () => {
    expect(
      unresolvedImports(
        views([imp("docs/style.md", 2), imp("docs/gone.md", 3)]),
        LIST,
        () => false,
      ),
    ).toEqual([
      {
        ...imp("docs/gone.md", 3),
        resolution: { kind: "missing" },
        seenIn: "both",
      },
    ]);
  });

  it("drops an import written in a file the caller excludes", () => {
    const vendored = { ...imp("docs/gone.md"), from: "vendor/guide.md" };
    expect(
      unresolvedImports(views([imp("docs/gone.md"), vendored]), LIST, (from) =>
        from.startsWith("vendor/"),
      ).map((i) => i.from),
    ).toEqual(["CLAUDE.md"]);
  });

  it("tags each by the view that names it: one machine's file is shown only, a file only a teammate loads is scored only", () => {
    const local: NamedImport = {
      ...imp("docs/gone.md"),
      from: "CLAUDE.local.md",
      fromScope: "local",
    };
    const hidden: NamedImport = { ...imp("docs/lost.md"), from: "AGENTS.md" };
    const issues = unresolvedImports(
      views([imp("docs/gone.md"), local], [imp("docs/gone.md"), hidden]),
      LIST,
      () => false,
    );
    expect(issues.map((i) => [i.from, i.seenIn])).toEqual([
      ["CLAUDE.md", "both"],
      ["CLAUDE.local.md", "effective"],
      ["AGENTS.md", "committed"],
    ]);
    expect(issues.filter(isShownImport).map((i) => i.from)).toEqual([
      "CLAUDE.md",
      "CLAUDE.local.md",
    ]);
    expect(issues.filter(isScoredImport).map((i) => i.from)).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
    ]);
  });
});
