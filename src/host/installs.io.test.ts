/**
 * The install half of a repo workspace, against a real directory tree: which
 * `node_modules` belong to the world, which links leave it, what a byte copy
 * keeps, and what the instruction check is given to read.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
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

function repo(
  files: Record<string, string>,
  links: Record<string, string> = {},
): { dir: string; sha: string } {
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
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    symlinkSync(target, join(dir, path));
  }
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

/** `linksOutside` on the template of `dir` at HEAD, with `patch` applied. */
function outside(
  dir: string,
  installs: readonly string[],
  patch?: string,
): readonly string[] {
  const template = buildTemplate({
    dir,
    ref: "HEAD",
    ...(patch === undefined ? {} : { patch }),
  });
  cleanup.push(template.root);
  return linksOutside(template, dir, installs);
}

describe("linksOutside on install links", () => {
  it("reports absolute links and relative links past the root, and keeps links inside", () => {
    const { dir } = repo({ "packages/x/index.js": "x\n" });
    mkdirSync(join(dir, "node_modules/@scope"), { recursive: true });
    symlinkSync("../../packages/x", join(dir, "node_modules/@scope/x"));
    symlinkSync("/etc", join(dir, "node_modules/abs"));
    symlinkSync("../../../outside", join(dir, "node_modules/@scope/escape"));
    // Guards: a workspace link into the world's own packages is fine; both escapes are not.
    expect(outside(dir, ["node_modules"])).toEqual([
      "node_modules/@scope/escape -> ../../../outside",
      "node_modules/abs -> /etc",
    ]);
  });

  it("reports an absolute link into the checkout itself", () => {
    const { dir } = repo({ "pkg/index.js": "p\n" });
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(join(dir, "pkg"), join(dir, "node_modules/pkg"));
    // Guards: copied as it is, an absolute target is the user's checkout from every trial.
    expect(outside(dir, ["node_modules"])).toEqual([
      `node_modules/pkg -> ${join(dir, "pkg")}`,
    ]);
  });
});

describe("linksOutside on links the world tracks", () => {
  it("reports the tracked link an install link leads through", () => {
    const away = makeTmpDir("outside-package");
    cleanup.push(away);
    const { dir } = repo({ "pkg/index.js": "p\n" }, { "linked-package": away });
    mkdirSync(join(dir, "node_modules"));
    symlinkSync("../linked-package", join(dir, "node_modules/dep"));
    // Guards: the chain is closed by its one escaping link; the inside link alone is fine.
    expect(outside(dir, ["node_modules"])).toEqual([
      `linked-package -> ${away}`,
    ]);
  });

  it("reports a tracked link past the root with no install at all, and keeps one inside", () => {
    const { dir } = repo(
      { "docs/a.md": "a\n" },
      { up: "../../elsewhere", "docs/b.md": "a.md" },
    );
    // Guards: `git archive` keeps a tracked link, so it reaches out of every trial.
    expect(outside(dir, [])).toEqual(["up -> ../../elsewhere"]);
  });

  it("reports a link whose `..` comes after a link, and keeps the links pnpm and workspaces make", () => {
    const { dir } = repo(
      { "pkg/a.js": "a\n", ".pnpm/bar@2/node_modules/bar/index.js": "b\n" },
      {
        "dir/up": "..",
        escape: "dir/up/..",
        "deep/x/bar": "../../.pnpm/bar@2/node_modules/bar",
        "deep/x/pkg": "../../pkg",
      },
    );
    // Guards: `dir/up/..` is lexically `dir` but really the root's parent (Codex, #585).
    expect(outside(dir, [])).toEqual(["escape -> dir/up/.."]);
  });

  it("reports a link the patch adds, which the commit does not have", () => {
    const { dir } = repo({ "a.txt": "a\n" });
    const patch = [
      "diff --git a/newlink b/newlink",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/newlink",
      "@@ -0,0 +1 @@",
      "+/etc",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    // Guards: the check reads the patched template, not the commit.
    expect(outside(dir, [], patch)).toEqual(["newlink -> /etc"]);
  });
});

describe("copyInstalls", () => {
  it("merges into an install directory the commit already tracks, never nesting it", () => {
    const { dir } = repo({ "node_modules/.gitkeep": "" });
    write(dir, "node_modules/dep/index.js", "dep\n");
    const dest = makeTmpDir("installs-dest");
    cleanup.push(dest);
    write(dest, "node_modules/.gitkeep", "");
    copyInstalls(dir, ["node_modules"], dest);
    // Guards: `cp -a from to` with an existing `to` puts the copy at `to/node_modules`.
    expect(readFileSync(join(dest, "node_modules/dep/index.js"), "utf-8")).toBe(
      "dep\n",
    );
    expect(existsSync(join(dest, "node_modules/node_modules"))).toBe(false);
  });

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
