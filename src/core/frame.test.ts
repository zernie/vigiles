/**
 * `core/frame.ts` — the one owner of "relative to which directory" (#281).
 *
 * The type half is checked by tsc (a bundle-relative `string` does not satisfy
 * `RepoPath`); these pin the RUNTIME half: each conversion lands a path in the
 * frame root's coordinates, whatever frame it started in.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { frameAt, frameFor, type RepoPath } from "./frame.js";

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
