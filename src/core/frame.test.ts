/**
 * `core/frame.ts` — the one owner of "relative to which directory" (#281).
 *
 * The type half is checked by tsc (a bundle-relative `string` does not satisfy
 * `RepoPath`); these pin the RUNTIME half: each conversion lands a path in the
 * frame root's coordinates, whatever frame it started in.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findProjectRoot,
  frameAt,
  frameFor,
  linkFrom,
  rebaseArg,
  type RepoPath,
} from "./frame.js";

describe("frame — converting into the repo frame", () => {
  const frame = frameAt("/repo");

  it("repo() makes an absolute path relative to the root; the root itself is `.`", () => {
    assert.equal(frame.repo("/repo/skills/x/SKILL.md"), "skills/x/SKILL.md");
    assert.equal(frame.repo("/repo"), ".");
    assert.equal(frame.repo("/repo/"), ".");
  });

  it("repo() refuses a RELATIVE input instead of guessing its frame", () => {
    assert.throws(
      () => frame.repo("skills/x/SKILL.md"),
      /takes an absolute path/,
    );
  });

  it("a path outside the root climbs out honestly rather than pretending to be inside", () => {
    assert.equal(frame.repo("/elsewhere/x.md"), "../elsewhere/x.md");
  });

  it("a NESTED bundle re-expresses its own paths from the root (the #281 bug)", () => {
    const b = frame.bundle("/repo/plugins/p");
    assert.equal(b.abs, "/repo/plugins/p");
    assert.equal(b.at, "plugins/p");
    // What scan-core reports for the nested skill, and what used to be printed
    // verbatim as `::warning file=skills/x/SKILL.md`.
    assert.equal(b.scanned("skills/x/SKILL.md"), "plugins/p/skills/x/SKILL.md");
  });

  it("the root bundle leaves paths unchanged — the common case is byte-identical", () => {
    const b = frame.bundle("/repo");
    assert.equal(b.at, ".");
    assert.equal(b.scanned("skills/x/SKILL.md"), "skills/x/SKILL.md");
  });

  it("scanned() takes an ABSOLUTE path too (hook-block reports its script that way)", () => {
    const b = frame.bundle("/repo/plugins/p");
    assert.equal(
      b.scanned("/repo/plugins/p/hooks/guard.sh"),
      "plugins/p/hooks/guard.sh",
    );
  });

  it("bundle() refuses a relative directory", () => {
    assert.throws(() => frame.bundle("plugins/p"), /takes an absolute path/);
  });
});

describe("frameFor — which directory is the root", () => {
  it("the working directory, for a target inside it", () => {
    assert.equal(frameFor("/repo", "/repo").root, "/repo");
    assert.equal(frameFor("/repo", "/repo/plugins/p").root, "/repo");
  });

  it("the TARGET, for a foreign repository outside it", () => {
    assert.equal(frameFor("/repo", "/other").root, "/other");
    // A sibling whose NAME starts with the root's name is still outside it.
    assert.equal(frameFor("/repo", "/repo-other").root, "/repo-other");
  });
});

// The compile-time half, kept honest by `tsc --noEmit` over this file: a plain
// string is not a RepoPath. If the brand were ever loosened to `string`, the
// `@ts-expect-error` below would itself become an error.
// @ts-expect-error — a bundle-relative string has no frame and must not pass.
const forged: RepoPath = "skills/x/SKILL.md";
void forged;

describe("frame — Windows paths (Node hands out `C:\\repo` there)", () => {
  it("converts a backslashed absolute path into a `/`-separated RepoPath", () => {
    const frame = frameAt("C:\\repo");
    assert.equal(
      frame.repo("C:\\repo\\plugins\\p\\skills\\x\\SKILL.md"),
      "plugins/p/skills/x/SKILL.md",
    );
    assert.equal(frame.repo("C:\\repo"), ".");
  });

  it("builds a nested bundle and re-expresses its scan paths from the root", () => {
    const bundle = frameAt("C:\\repo").bundle("C:\\repo\\plugins\\p");
    assert.equal(bundle.at, "plugins/p");
    assert.equal(
      bundle.scanned("skills/x/SKILL.md"),
      "plugins/p/skills/x/SKILL.md",
    );
    assert.equal(
      bundle.scanned("C:\\repo\\plugins\\p\\hooks\\h.sh"),
      "plugins/p/hooks/h.sh",
    );
  });

  it("still refuses a relative path", () => {
    assert.throws(
      () => frameAt("C:\\repo").repo("plugins\\p"),
      /absolute path/,
    );
  });

  it("keeps a target below cwd in cwd's frame", () => {
    assert.equal(frameFor("C:\\repo", "C:\\repo\\plugins\\p").root, "C:/repo");
  });
});

describe("linkFrom: a repo path as a link written into a file", () => {
  it("is the path itself from a root-level file", () => {
    assert.equal(linkFrom("CLAUDE.md", "docs/rules/x.md"), "docs/rules/x.md");
  });

  it("climbs out of a nested file's directory (#371)", () => {
    assert.equal(linkFrom("plugin/CLAUDE.md", "docs/x.md"), "../docs/x.md");
    assert.equal(
      linkFrom("a/b/CLAUDE.md", "src/rule-cases.test.ts"),
      "../../src/rule-cases.test.ts",
    );
  });

  it("stays short for a sibling and normalizes Windows separators", () => {
    assert.equal(linkFrom("skills/x/SKILL.md", "skills/x/ref.md"), "ref.md");
    assert.equal(
      linkFrom("plugin\\CLAUDE.md", "plugin\\docs\\y.md"),
      "docs/y.md",
    );
  });

  it("names the file's own directory as `.`", () => {
    assert.equal(linkFrom("plugin/CLAUDE.md", "plugin"), ".");
  });
});

describe("findProjectRoot: where a command's root is", () => {
  /** A fake filesystem: the set of absolute paths that exist. */
  const fs =
    (...paths: readonly string[]) =>
    (abs: string) =>
      paths.includes(abs);

  it("is the git work-tree top when no config is on the way", () => {
    assert.equal(findProjectRoot("/r/src/core", fs("/r/.git")), "/r");
  });

  it("is the nearest directory with .vigilesrc.json inside the work tree", () => {
    const exists = fs(
      "/r/.git",
      "/r/.vigilesrc.json",
      "/r/pkg/.vigilesrc.json",
    );
    assert.equal(findProjectRoot("/r/pkg/src", exists), "/r/pkg");
    assert.equal(findProjectRoot("/r/docs", exists), "/r");
  });

  it("never reads a config above the work tree", () => {
    const exists = fs("/home/.vigilesrc.json", "/home/r/.git");
    assert.equal(findProjectRoot("/home/r/src", exists), "/home/r");
  });

  it("outside any checkout, is the nearest config's directory, else the start", () => {
    assert.equal(findProjectRoot("/tmp/x/y", fs()), "/tmp/x/y");
    assert.equal(
      findProjectRoot("/tmp/x/y", fs("/tmp/x/.vigilesrc.json")),
      "/tmp/x",
    );
  });
});

describe("rebaseArg: a typed path, re-anchored at the project root", () => {
  it("a relative path typed in a subdirectory gains that subdirectory", () => {
    assert.equal(rebaseArg("CLAUDE.md", "/r/pkg", "/r"), "pkg/CLAUDE.md");
    assert.equal(rebaseArg(".", "/r/pkg", "/r"), "pkg");
    assert.equal(rebaseArg("..", "/r/pkg", "/r"), ".");
  });

  it("typed AT the root, a path is left exactly as typed", () => {
    // `./x`, a glob, a typo: the message must quote what the user wrote.
    for (const typed of ["./x.md", ".vigiles/hooks/*", "nonexistent/typo.json"])
      assert.equal(rebaseArg(typed, "/r", "/r"), typed);
  });

  it("an absolute path, or one that leaves the root, is absolute — never `../..`", () => {
    assert.equal(rebaseArg("/etc/passwd", "/r/pkg", "/r"), "/etc/passwd");
    assert.equal(rebaseArg("/etc/passwd", "/r", "/r"), "/etc/passwd");
    assert.equal(rebaseArg("../../other/x", "/r/pkg", "/r"), "/other/x");
  });
});
