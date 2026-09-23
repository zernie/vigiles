/**
 * `withIgnored` — a detector's own string floor plus the repo exclude, as the
 * single `ignore` `globSync` accepts.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globSync, type IgnoreLike } from "glob";

import { withIgnored } from "./glob-ignore.js";
import { makeTmpDir, cleanupTmpDir } from "./test-utils.js";

function tree(): string {
  const dir = makeTmpDir("glob-ignore");
  for (const rel of ["a/x.md", "floor/x.md", "repo/x.md"]) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "");
  }
  return dir;
}

/** An IgnoreLike that drops `repo/`, the way `ExcludeSet.globIgnore` would. */
const repoIgnore: IgnoreLike = {
  ignored: (p) => p.relative().startsWith("repo"),
  childrenIgnored: (p) => p.relative() === "repo",
};

describe("withIgnored", () => {
  it("stays a plain list when both halves are lists", () => {
    assert.deepEqual(withIgnored(["floor/**"], ["x/**"]), ["floor/**", "x/**"]);
    assert.deepEqual(withIgnored(["floor/**"], undefined), ["floor/**"]);
  });

  it("with an IgnoreLike, drops what EITHER half drops — and nothing else", () => {
    const dir = tree();
    try {
      const glob = (ignore: string[] | IgnoreLike): string[] =>
        globSync("**/*.md", { cwd: dir, ignore }).sort();
      assert.deepEqual(glob(withIgnored(["floor/**"], repoIgnore)), ["a/x.md"]);
      // Each half alone, so the line above cannot pass by one half doing all.
      assert.deepEqual(glob(withIgnored(["floor/**"], [])), [
        "a/x.md",
        "repo/x.md",
      ]);
      assert.deepEqual(glob(withIgnored([], repoIgnore)), [
        "a/x.md",
        "floor/x.md",
      ]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("an IgnoreLike without the optional methods drops nothing extra", () => {
    const dir = tree();
    try {
      assert.deepEqual(
        globSync("**/*.md", {
          cwd: dir,
          ignore: withIgnored(["floor/**"], {}),
        }).sort(),
        ["a/x.md", "repo/x.md"],
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
