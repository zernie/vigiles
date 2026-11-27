/**
 * The machine reads of a regression case's world, on a real repository built
 * here: a base, a fix (a text edit, a binary edit, a delete, an add, a test,
 * a Markdown edit, an edit head changes again), and a head after it. The P0
 * is the user's checkout: every call is made inside a hash of the whole
 * directory, `.git` included, under a repo config built to change a diff
 * (`diff.noprefix`, `diff.relative`, an external diff and a textconv driver
 * that leave a marker if they run, `apply.whitespace=error`).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../core/tmp-root.js";
import { caseWorldHost as host } from "./case-world.io.js";
import { IDENTITY } from "./git-env.io.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const tmp = (label: string): string => {
  const dir = makeTmpDir(label);
  cleanup.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...IDENTITY },
  });
}

function write(root: string, path: string, data: string | Buffer): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), data);
}

const commit = (repo: string, message: string): string => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
};

const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";
const BIN_BASE = Buffer.from([0, 1, 2, 255, 0]);
const BIN_FIX = Buffer.from([0, 1, 3, 255, 0]);

interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly fix: string;
  readonly head: string;
  /** A file an external diff or a textconv driver creates if it ever runs. */
  readonly marker: string;
}

function baseCommit(repo: string): string {
  git(repo, "init", "-q");
  write(repo, "src/add.mjs", BUGGY);
  write(repo, "src/conflict.mjs", "a\n");
  write(repo, "src/data.bin", BIN_BASE);
  write(repo, "src/old.mjs", "old\n");
  write(repo, "README.md", "v1\n");
  return commit(repo, "base");
}

function fixture(): Fixture {
  const repo = tmp("case-world-repo");
  const base = baseCommit(repo);
  write(repo, "src/add.mjs", FIXED);
  write(repo, "src/conflict.mjs", "b\n");
  write(repo, "src/data.bin", BIN_FIX);
  rmSync(join(repo, "src/old.mjs"));
  write(repo, "src/new.mjs", "new\n");
  write(repo, "test/add.test.mjs", "test\n");
  write(repo, "README.md", "v2\n");
  const fix = commit(repo, "fix");
  write(repo, "src/conflict.mjs", "c\n");
  write(repo, "README.md", "v3\n");
  write(repo, "ISSUE.md", "add is wrong\n");
  const head = commit(repo, "head");
  return { repo, base, fix, head, marker: hostile(repo) };
}

/** Repo config that would change a diff's text or run a program, if honoured. */
function hostile(repo: string): string {
  const marker = join(tmp("case-world-marker"), "ran");
  const script = join(tmp("case-world-script"), "evil.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`);
  chmodSync(script, 0o755);
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "config", "diff.relative", "true");
  git(repo, "config", "diff.external", script);
  git(repo, "config", "diff.evil.textconv", script);
  git(repo, "config", "apply.whitespace", "error");
  git(repo, "config", "color.diff", "always");
  write(repo, ".git/info/attributes", "* diff=evil\n");
  return marker;
}

/** Every path under `dir` with its bytes (a link: its target), in one hash. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (rel: string): void => {
    const full = join(dir, rel);
    const st = lstatSync(full);
    h.update(`${rel}\0${st.mode}\0`);
    if (st.isSymbolicLink()) h.update(readlinkSync(full));
    else if (st.isFile()) h.update(readFileSync(full));
    else
      readdirSync(full)
        .sort((a, b) => a.localeCompare(b))
        .forEach((n) => {
          walk(join(rel, n));
        });
  };
  walk(".");
  return h.digest("hex");
}

/** A fresh clone of `repo` at `head`, where a patch is applied for real. */
function applied(f: Fixture, patch: string): string {
  const out = tmp("case-world-apply");
  execFileSync("git", ["clone", "-q", "--no-checkout", f.repo, out]);
  git(out, "checkout", "-q", f.head);
  execFileSync("git", ["apply", "--binary", "-"], { cwd: out, input: patch });
  return out;
}

describe("caseWorldHost on a real repository", () => {
  it("reads history, paths and trees, and writes nothing", () => {
    const f = fixture();
    const before = treeHash(f.repo);
    expect(host.gitDir(f.repo)).toBe(realpathSync(join(f.repo, ".git")));
    // Guards: a root commit has no parent, so it can never be a fix.
    expect(host.parents(f.repo, f.base)).toEqual([]);
    expect(host.parents(f.repo, f.fix)).toEqual([f.base]);
    expect(host.parents(f.repo, "0".repeat(40))).toBeUndefined();
    expect(host.isAncestor(f.repo, f.fix, f.head)).toBe(true);
    expect(host.isAncestor(f.repo, f.head, f.fix)).toBe(false);
    expect(host.fixPaths(f.repo, f.fix)).toEqual([
      { status: "M", path: "README.md" },
      { status: "M", path: "src/add.mjs" },
      { status: "M", path: "src/conflict.mjs" },
      { status: "M", path: "src/data.bin" },
      { status: "A", path: "src/new.mjs" },
      { status: "D", path: "src/old.mjs" },
      { status: "A", path: "test/add.test.mjs" },
    ]);
    const entries = host.treeEntries(f.repo, f.head);
    expect(entries.map((e) => e.path)).toContain("ISSUE.md");
    expect(entries.map((e) => e.path)).not.toContain("src/old.mjs");
    expect(treeHash(f.repo)).toBe(before);
    expect(existsSync(f.marker)).toBe(false);
  });
});

describe("caseWorldHost: the world patch", () => {
  it("reverses each file alone, binary included, and names the ones that conflict", () => {
    const f = fixture();
    const before = treeHash(f.repo);
    const r = host.revertPatches(f.repo, {
      commit: f.fix,
      head: f.head,
      paths: [
        "src/add.mjs",
        "src/conflict.mjs",
        "src/data.bin",
        "src/old.mjs",
        "src/new.mjs",
        "README.md",
      ],
    });
    expect(treeHash(f.repo)).toBe(before);
    // Guards: a file head changed again does not reverse; it is named, not dropped.
    expect(r.failed).toEqual(["src/conflict.mjs", "README.md"]);
    const world = applied(f, r.patch);
    expect(readFileSync(join(world, "src/add.mjs"), "utf-8")).toBe(BUGGY);
    // Guards: a binary file reverses byte for byte (G10).
    expect(readFileSync(join(world, "src/data.bin"))).toEqual(BIN_BASE);
    expect(readFileSync(join(world, "src/old.mjs"), "utf-8")).toBe("old\n");
    expect(existsSync(join(world, "src/new.mjs"))).toBe(false);
    expect(readFileSync(join(world, "src/conflict.mjs"), "utf-8")).toBe("c\n");
    expect(readFileSync(join(world, "test/add.test.mjs"), "utf-8")).toBe(
      "test\n",
    );
    expect(existsSync(f.marker)).toBe(false);
  });

  it("builds the deletion of paths from head, and nothing for none", () => {
    const f = fixture();
    const before = treeHash(f.repo);
    const patch = host.removalPatch(f.repo, f.head, [
      "ISSUE.md",
      "src/data.bin",
    ]);
    expect(host.removalPatch(f.repo, f.head, [])).toBe("");
    expect(treeHash(f.repo)).toBe(before);
    const world = applied(f, patch);
    expect(existsSync(join(world, "ISSUE.md"))).toBe(false);
    expect(existsSync(join(world, "src/data.bin"))).toBe(false);
    expect(existsSync(join(world, "src/add.mjs"))).toBe(true);
  });
});

/** An executable that leaves `marker` and fails, if git ever runs it. */
function plantScript(path: string, marker: string): string {
  write(path, "", `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Every read the adapter makes, each on the fixture. */
function everyRead(f: Fixture): void {
  host.parents(f.repo, f.fix);
  host.isAncestor(f.repo, f.fix, f.head);
  host.fixPaths(f.repo, f.fix);
  host.treeEntries(f.repo, f.head);
  host.workingBlob(f.repo, "README.md");
  host.removalPatch(f.repo, f.head, ["ISSUE.md"]);
  const at = { commit: f.fix, head: f.head, paths: ["src/add.mjs"] };
  expect(host.revertPatches(f.repo, at).failed).toEqual([]);
}

describe("caseWorldHost: code the user's repository names", () => {
  it.each([
    [
      "a hook in .git/hooks",
      (f: Fixture) => {
        plantScript(join(f.repo, ".git/hooks/post-index-change"), f.marker);
      },
    ],
    [
      "a hook under core.hooksPath",
      (f: Fixture) => {
        const dir = tmp("case-world-hooks");
        plantScript(join(dir, "post-index-change"), f.marker);
        git(f.repo, "config", "core.hooksPath", dir);
      },
    ],
    [
      "a core.fsmonitor command",
      (f: Fixture) => {
        const script = join(tmp("case-world-fsmonitor"), "monitor.sh");
        git(f.repo, "config", "core.fsmonitor", plantScript(script, f.marker));
      },
    ],
  ])("runs no %s on any read", (_what, plant) => {
    const f = fixture();
    plant(f);
    const before = treeHash(f.repo);
    everyRead(f);
    // Guards: the throwaway index is written, and an index write fires these.
    expect(existsSync(f.marker)).toBe(false);
    expect(treeHash(f.repo)).toBe(before);
  });
});

/** A `--filter=blob:none` clone of the fixture: the fix's old blobs are not in it. */
function partialClone(f: Fixture): string {
  git(f.repo, "config", "uploadpack.allowFilter", "true");
  const partial = tmp("case-world-partial");
  execFileSync("git", [
    "clone",
    "-q",
    "--filter=blob:none",
    `file://${f.repo}`,
    partial,
  ]);
  return partial;
}

describe("caseWorldHost: a partial clone", () => {
  it("fetches no missing blob into it, and fails loudly instead", () => {
    const f = fixture();
    const partial = partialClone(f);
    const before = treeHash(partial);
    const at = { commit: f.fix, head: f.head, paths: ["src/add.mjs"] };
    expect(() => host.revertPatches(partial, at)).toThrow(Error);
    // Guards: GIT_NO_LAZY_FETCH; without it the diff adds packs to .git/objects.
    expect(treeHash(partial)).toBe(before);
  });

  it("names a clone made with a filter, and only such a clone", () => {
    const f = fixture();
    const partial = partialClone(f);
    expect(host.isPartialClone(partial)).toBe(true);
    expect(host.isPartialClone(f.repo)).toBe(false);
    // Guards: either of git's two marks makes a clone partial, alone.
    git(f.repo, "config", "extensions.partialclone", "up");
    expect(host.isPartialClone(f.repo)).toBe(true);
    git(f.repo, "config", "--unset", "extensions.partialclone");
    git(f.repo, "config", "remote.up.promisor", "false");
    expect(host.isPartialClone(f.repo)).toBe(false);
    git(f.repo, "config", "remote.up.promisor", "true");
    expect(host.isPartialClone(f.repo)).toBe(true);
  });
});

describe("caseWorldHost: the working copy", () => {
  it("hashes a working file without writing its object", () => {
    const f = fixture();
    const atHead = host
      .treeEntries(f.repo, f.head)
      .find((e) => e.path === "ISSUE.md");
    expect(host.workingBlob(f.repo, "ISSUE.md")).toBe(atHead?.blob);
    write(f.repo, "ISSUE.md", "an edit nobody committed\n");
    symlinkSync("ISSUE.md", join(f.repo, "link.md"));
    const before = treeHash(f.repo);
    const edited = host.workingBlob(f.repo, "ISSUE.md");
    expect(edited).toMatch(/^[0-9a-f]{40,64}$/);
    expect(edited).not.toBe(atHead?.blob);
    expect(treeHash(f.repo)).toBe(before);
    // Guards: no object of the working copy lands in the user's store.
    expect(() =>
      execFileSync("git", ["cat-file", "-e", edited ?? ""], {
        cwd: f.repo,
        stdio: "ignore",
      }),
    ).toThrow();
    expect(host.workingBlob(f.repo, "link.md")).toBeUndefined();
    expect(host.workingBlob(f.repo, "src")).toBeUndefined();
    expect(host.workingBlob(f.repo, "missing.md")).toBeUndefined();
  });
});

describe("caseWorldHost: history edges", () => {
  it("reads a merge commit's two parents", () => {
    const f = fixture();
    git(f.repo, "checkout", "-q", "-b", "side", f.base);
    write(f.repo, "side.txt", "side\n");
    const side = commit(f.repo, "side");
    git(f.repo, "checkout", "-q", f.head);
    git(f.repo, "merge", "-q", "--no-ff", "-m", "merge", side);
    const merge = git(f.repo, "rev-parse", "HEAD").trim();
    expect(host.parents(f.repo, merge)).toEqual([f.head, side]);
  });

  it("reads a fix whose parent a shallow clone lacks as not in history", () => {
    const f = fixture();
    const shallow = tmp("case-world-shallow");
    execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      `file://${f.repo}`,
      shallow,
    ]);
    expect(host.parents(shallow, f.head)).toBeUndefined();
  });

  it("fails loudly on a git call that must succeed", () => {
    const f = fixture();
    expect(() => host.treeEntries(f.repo, "0".repeat(40))).toThrow(Error);
    expect(() =>
      host.revertPatches(f.repo, {
        commit: f.fix,
        head: "0".repeat(40),
        paths: ["src/add.mjs"],
      }),
    ).toThrow(Error);
  });
});
