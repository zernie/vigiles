/**
 * The disk's path list: git's answer inside a work tree (untracked kept,
 * ignored dropped, a submodule by its gitlink), a walk outside one.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diskRepoTree } from "./repo-tree.io.js";

function fixture(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-tree-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
};

describe("diskRepoTree", () => {
  it("in a work tree: tracked and untracked paths, not ignored ones, submodules apart", () => {
    const dir = fixture({
      "AGENTS.md": "a",
      "docs/new.md": "b",
      "dist/out.js": "c",
      ".gitignore": "dist/\n",
    });
    git(dir, "init", "-q");
    git(dir, "add", "AGENTS.md", ".gitignore");
    git(
      dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"a".repeat(40)},vendor/lib`,
    );
    const tree = diskRepoTree(dir);
    expect([...tree.paths].sort()).toEqual([
      ".gitignore",
      "AGENTS.md",
      "docs/new.md",
    ]);
    expect([...tree.submodules]).toEqual(["vendor/lib"]);
  });

  it("outside git: a walk that skips .git and node_modules and a linked directory", () => {
    const dir = fixture({ "CLAUDE.md": "x", "node_modules/p/a.js": "y" });
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect([...diskRepoTree(dir).paths].sort()).toEqual(["CLAUDE.md", "link"]);
  });

  it("a directory that cannot be read is an empty tree, not a throw", () => {
    expect([
      ...diskRepoTree(join(tmpdir(), "repo-tree-absent-xyz")).paths,
    ]).toEqual([]);
  });
});
