/**
 * The install half of a repo workspace, against a real directory tree: which
 * `node_modules` belong to the world, which links leave it, what a byte copy
 * keeps, and what the instruction check is given to read.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../core/tmp-root.js";
import {
  copyInstalls,
  findInstalls,
  linksOutside,
  readWorld,
} from "./installs.io.js";
import { buildTemplate } from "./repo-copy.io.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = makeTmpDir("installs");
  cleanup.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

describe("findInstalls", () => {
  it("finds the root and nested installs, skips one inside another and one outside the tree", () => {
    const { dir, sha } = repo({ "pkg/package.json": "{}\n" });
    write(dir, "node_modules/a/node_modules/b/index.js", "b\n");
    write(dir, "pkg/node_modules/c/index.js", "c\n");
    write(dir, "untracked/node_modules/d/index.js", "d\n");
    // Guards: an install of a directory the world does not have is not the world's.
    expect(findInstalls(dir, sha)).toEqual([
      "node_modules",
      "pkg/node_modules",
    ]);
  });
});

describe("linksOutside", () => {
  it("reports absolute links and relative links past the root, and keeps links inside", () => {
    const { dir } = repo({ "packages/x/index.js": "x\n" });
    mkdirSync(join(dir, "node_modules/@scope"), { recursive: true });
    symlinkSync("../../packages/x", join(dir, "node_modules/@scope/x"));
    symlinkSync("/etc", join(dir, "node_modules/abs"));
    symlinkSync("../../../outside", join(dir, "node_modules/@scope/escape"));
    // Guards: a workspace link into the world's own packages is fine; both escapes are not.
    expect(
      [...linksOutside(dir, ["node_modules"])].sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual([
      "node_modules/@scope/escape -> ../../../outside",
      "node_modules/abs -> /etc",
    ]);
  });
});

describe("copyInstalls", () => {
  it("copies bytes and keeps links as links", () => {
    const { dir } = repo({ "a.txt": "a\n" });
    write(dir, "node_modules/dep/index.js", "original\n");
    symlinkSync("dep", join(dir, "node_modules/alias"));
    const dest = makeTmpDir("installs-dest");
    cleanup.push(dest);
    copyInstalls(dir, ["node_modules"], dest);
    writeFileSync(join(dest, "node_modules/dep/index.js"), "changed\n");
    // Guards: never a hardlink — a write in the copy must not reach the original.
    expect(readFileSync(join(dir, "node_modules/dep/index.js"), "utf-8")).toBe(
      "original\n",
    );
    expect(
      readFileSync(join(dest, "node_modules/alias/index.js"), "utf-8"),
    ).toBe("changed\n");
  });
});

describe("readWorld", () => {
  it("lists every tracked file, with no text for one too large to be an instruction file", () => {
    const { dir } = repo({
      "CLAUDE.md": "rules\n",
      "big.bin": "x".repeat(300 * 1024),
    });
    const template = buildTemplate({ dir, ref: "HEAD" });
    cleanup.push(template.root);
    const world = readWorld(template);
    expect(world["CLAUDE.md"]).toBe("rules\n");
    // Guards: a large file is still listed, so a path check sees it, but not read.
    expect(world["big.bin"]).toBe("");
  });
});
