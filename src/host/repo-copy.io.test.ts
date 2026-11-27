/**
 * The per-trial base record of a repo workspace, against real git.
 *
 * What it proves: the touched set of a trial is computed against the trial's
 * OWN pre-agent tree, through a git dir the parent holds, so (a) an edit to a
 * file the template tracks under an ignored path is still an edit, (b) a
 * nested repo the agent left without a commit does not throw, it is reported,
 * (c) a rename out of a directory shows the deleted path as its own row, and
 * (d) nothing the agent does to the trial's own `.git` moves the base.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../core/tmp-root.js";
import {
  buildTemplate,
  cloneTemplate,
  recordTrialBase,
  touchedPaths,
} from "./repo-copy.io.js";
import { ShadowUnhealthyError, type RepoTemplate } from "../core/workspace.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function write(root: string, path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

/** A source repo with one commit holding `files`; `force` are added past `.gitignore`. */
function sourceRepo(
  files: Record<string, string>,
  force: readonly string[] = [],
): string {
  const dir = makeTmpDir("repo-src");
  cleanup.push(dir);
  git(dir, "init", "-q");
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  git(dir, "add", "-A");
  if (force.length > 0) git(dir, "add", "-f", ...force);
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

interface Trial {
  readonly template: RepoTemplate;
  readonly cwd: string;
  readonly view: {
    readonly gitDir: string;
    readonly baseTree: string;
    readonly armPaths: readonly string[];
  };
}

function startTrial(
  src: string,
  before?: (cwd: string) => void,
  armPaths: readonly string[] = [],
): Trial {
  const template = buildTemplate({ dir: src, ref: "HEAD" });
  cleanup.push(template.root);
  const cwd = makeTmpDir("trial");
  cleanup.push(cwd);
  cloneTemplate(template, cwd);
  before?.(cwd);
  const gitDir = makeTmpDir("trial-base");
  cleanup.push(gitDir);
  const base = recordTrialBase(template, { gitDir, cwd, armPaths });
  return { template, cwd, view: { gitDir, ...base } };
}

const paths = (trial: Trial): string[] =>
  touchedPaths(trial.view, trial.cwd)
    .rows.map((r) => `${r.status} ${r.path}`)
    .sort((a, b) => a.localeCompare(b));

describe("recordTrialBase + touchedPaths", () => {
  it("an untouched trial has an empty touched set, and what was written before the record is in the base", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    const trial = startTrial(src, (cwd) => {
      write(cwd, "settings.json", "{}\n");
      write(cwd, "notes/arm.md", "arm file\n");
    });
    // Guards: arm files and settings.json are not agent edits.
    expect(paths(trial)).toEqual([]);
    const listed = git(
      trial.cwd,
      `--git-dir=${trial.view.gitDir}`,
      "ls-tree",
      "-r",
      "--name-only",
      trial.view.baseTree,
    );
    expect(listed.split("\n")).toEqual(
      expect.arrayContaining(["settings.json", "notes/arm.md", "src/a.ts"]),
    );
  });

  it("an edit to a tracked file under an ignored path is in the touched set", () => {
    const src = sourceRepo(
      { ".gitignore": "dist/\n", "dist/gen.js": "gen\n", "src/a.js": "a\n" },
      ["dist/gen.js"],
    );
    const trial = startTrial(src);
    write(trial.cwd, "dist/gen.js", "gen fixed\n");
    write(trial.cwd, "src/a.js", "a fixed\n");
    // Guards: an unseeded shadow index would drop dist/gen.js silently.
    expect(paths(trial)).toEqual(["M dist/gen.js", "M src/a.js"]);
  });
});

describe("recordTrialBase on arm files the world ignores", () => {
  it("puts an ignored arm file in the base, so an edit to it is in the touched set", () => {
    const src = sourceRepo({ ".gitignore": ".agent/\n", "a.txt": "a\n" });
    const trial = startTrial(
      src,
      (cwd) => {
        write(cwd, ".agent/notes.md", "arm\n");
      },
      [".agent/notes.md"],
    );
    expect(paths(trial)).toEqual([]);
    write(trial.cwd, ".agent/notes.md", "edited by the agent\n");
    // Guards: without it the file is outside the base and the edit is silently not seen (Codex, #585).
    expect(paths(trial)).toEqual(["M .agent/notes.md"]);
  });
});

describe("recordTrialBase on arm files under a linked directory", () => {
  it("stages an arm file written through a directory link at its real path", () => {
    const src = sourceRepo({ "config/keep.md": "k\n" });
    const trial = startTrial(
      src,
      (cwd) => {
        symlinkSync("config", join(cwd, "agentdir"));
        write(cwd, "agentdir/notes.md", "arm\n");
      },
      ["agentdir/notes.md"],
    );
    write(trial.cwd, "config/notes.md", "edited by the agent\n");
    // Guards: git refuses a pathspec beyond a link, which aborted the trial before the agent ran (Codex, #585).
    expect(paths(trial)).toEqual(["M config/notes.md"]);
  });

  it("returns the arm paths where it staged them, so they match what git later reports", () => {
    const src = sourceRepo({ "config/keep.md": "k\n" });
    const trial = startTrial(
      src,
      (cwd) => {
        symlinkSync("config", join(cwd, "agentdir"));
        write(cwd, "agentdir/notes.md", "arm\n");
      },
      ["agentdir/notes.md"],
    );
    // Guards: a logical arm path would miss the physical row and let the arm's file carry into scoring.
    expect(trial.view.armPaths).toEqual(["config/notes.md"]);
  });
});

describe("recordTrialBase on an arm file that is itself a link", () => {
  it("records both the link and the file it writes, so an agent edit to either stays the arm's", () => {
    const src = sourceRepo({ "config/notes.js": "base\n" });
    const trial = startTrial(
      src,
      (cwd) => {
        symlinkSync("config/notes.js", join(cwd, "arm.js"));
        write(cwd, "arm.js", "arm\n");
      },
      ["arm.js"],
    );
    // Guards: writing an arm file follows its link, so the target is arm-owned too (Codex, #596).
    expect([...trial.view.armPaths].sort((a, b) => a.localeCompare(b))).toEqual(
      ["arm.js", "config/notes.js"],
    );
  });

  it("keeps an arm path the arm deleted, since nothing is there to resolve", () => {
    const src = sourceRepo({ "gone.js": "base\n", "old/x.js": "base\n" });
    const trial = startTrial(
      src,
      (cwd) => {
        rmSync(join(cwd, "gone.js"));
        rmSync(join(cwd, "old"), { recursive: true });
      },
      ["gone.js", "old/x.js"],
    );
    // Guards: an arm that deletes a file, or its whole directory, still owns that path instead of crashing the trial.
    expect(trial.view.armPaths).toEqual(["gone.js", "old/x.js"]);
  });
});

describe("workspace git against the caller's git environment", () => {
  const keys = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"] as const;
  const saved = keys.map((k) => process.env[k]);
  afterEach(() => {
    keys.forEach((k, i) => {
      const v = saved[i];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    });
  });

  it("never writes the caller's index or repository when GIT_INDEX_FILE and GIT_DIR point at it", () => {
    const src = sourceRepo({ "a.txt": "a\n" });
    const index = join(src, ".git", "index");
    const before = readFileSync(index);
    process.env.GIT_INDEX_FILE = index;
    process.env.GIT_DIR = join(src, ".git");
    process.env.GIT_WORK_TREE = src;
    const trial = startTrial(src);
    write(trial.cwd, "a.txt", "agent edit\n");
    expect(paths(trial)).toEqual(["M a.txt"]);
    // Guards: the source checkout's index is byte-identical after a whole trial (Codex, #585).
    expect(readFileSync(index).equals(before)).toBe(true);
  });
});

describe("touchedPaths on trees only the agent made", () => {
  it("a nested repo without a commit is reported as unstaged, and the other edits still count", () => {
    const src = sourceRepo({ "README.md": "r\n" });
    const trial = startTrial(src);
    write(trial.cwd, "README.md", "r2\n");
    mkdirSync(join(trial.cwd, "scratch"));
    git(join(trial.cwd, "scratch"), "init", "-q");
    write(trial.cwd, "scratch/x.txt", "x\n");
    const set = touchedPaths(trial.view, trial.cwd);
    // Guards: a commit-less nested repo makes `add -A` exit 128; that is the agent's tree, not a fault.
    expect(set.unstaged).toEqual({ kind: "paths", paths: ["scratch/"] });
    expect(set.rows.map((r) => `${r.status} ${r.path}`)).toContain(
      "M README.md",
    );
  });

  it("a nested repo with a commit is a gitlink row", () => {
    const src = sourceRepo({ "README.md": "r\n" });
    const trial = startTrial(src);
    const nested = join(trial.cwd, "vendor/lib");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    write(nested, "x.txt", "x\n");
    git(nested, "add", "-A");
    git(nested, "commit", "-q", "-m", "n");
    const row = touchedPaths(trial.view, trial.cwd).rows.find(
      (r) => r.path === "vendor/lib",
    );
    // Guards: a gitlink carries no content, so scoring must see it as one.
    expect(row?.entry).toEqual({ kind: "gitlink" });
  });

  it("a symlink the agent made is a symlink row, never a file row", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    const trial = startTrial(src);
    rmSync(join(trial.cwd, "src/a.ts"));
    symlinkSync("/etc/hostname", join(trial.cwd, "src/a.ts"));
    const row = touchedPaths(trial.view, trial.cwd).rows.find(
      (r) => r.path === "src/a.ts",
    );
    // Guards: a link's target is state outside the tree, so it must not be carried as content.
    expect(row?.entry).toEqual({ kind: "symlink" });
  });
});

describe("ignoredNewFiles", () => {
  it("counts ignored entries the agent added, not the ones present at the base", () => {
    const src = sourceRepo({
      ".gitignore": "out/\n*.log\n",
      "src/a.ts": "a\n",
    });
    const trial = startTrial(src, (cwd) => {
      write(cwd, "out/old.js", "old\n");
    });
    // Guards: silent on correct — an ignored dir already there before the agent is not a new file.
    expect(touchedPaths(trial.view, trial.cwd).ignoredNewFiles).toBe(0);
    write(trial.cwd, "src/debug.log", "x\n");
    write(trial.cwd, "src/b.ts", "b\n");
    const set = touchedPaths(trial.view, trial.cwd);
    // Guards: a new ignored file is never scored, so it must be counted, and a new tracked file must not be.
    expect(set.ignoredNewFiles).toBe(1);
    expect(set.rows.map((r) => r.path)).toEqual(["src/b.ts"]);
  });

  it("counts every ignored entry when the base has no ignored record", () => {
    const src = sourceRepo({ ".gitignore": "*.log\n", "src/a.ts": "a\n" });
    const trial = startTrial(src);
    write(trial.cwd, "a.log", "x\n");
    rmSync(join(trial.view.gitDir, "vigiles-ignored-at-base"));
    // Guards: a missing record fails toward a larger count, never a silent zero.
    expect(touchedPaths(trial.view, trial.cwd).ignoredNewFiles).toBe(1);
  });

  it("a rename out of a directory shows the deleted path as its own row", () => {
    const src = sourceRepo({
      "test/fixtures/x.json": "{}\n",
      "src/a.ts": "a\n",
    });
    const trial = startTrial(src);
    git(trial.cwd, "mv", "test/fixtures/x.json", "src/x.json");
    // Guards: a rename row hides one side from a one-path-per-row reader.
    expect(paths(trial)).toEqual(["A src/x.json", "D test/fixtures/x.json"]);
  });
});

describe("touchedPaths against what could move the base", () => {
  it("throws when the base record itself is gone, rather than scoring the agent", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    const trial = startTrial(src);
    write(trial.cwd, "src/a.ts", "b\n");
    rmSync(trial.view.gitDir, { recursive: true, force: true });
    // Guards: a broken shadow is vigiles' fault, never an agent outcome.
    expect(() => touchedPaths(trial.view, trial.cwd)).toThrow(
      ShadowUnhealthyError,
    );
  });

  it("throws when the shadow cannot lock its index, rather than calling the tree unstaged", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    const trial = startTrial(src);
    write(trial.cwd, "src/a.ts", "b\n");
    writeFileSync(join(trial.view.gitDir, "index.lock"), "");
    // Guards: a stale lock is the machine's fault; reading it as `unstaged` would blame the agent.
    expect(() => touchedPaths(trial.view, trial.cwd)).toThrow(
      ShadowUnhealthyError,
    );
  });

  it("the agent's git history operations in the trial do not move the base", () => {
    const src = sourceRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
    const trial = startTrial(src);
    write(trial.cwd, "src/a.ts", "a fixed\n");
    git(trial.cwd, "add", "-A");
    git(
      trial.cwd,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--amend",
      "-m",
      "rewritten",
    );
    git(trial.cwd, "reset", "-q", "--hard", "HEAD~0");
    git(trial.cwd, "reflog", "expire", "--expire=now", "--all");
    git(trial.cwd, "gc", "-q", "--prune=now");
    // Guards: the base lives in the parent's git dir, not in the trial's `.git`.
    expect(paths(trial)).toEqual(["M src/a.ts"]);
  });
});

describe("touchedPaths against the user's own git config", () => {
  it("the user's global git config cannot hide a new file", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    const trial = startTrial(src);
    const home = makeTmpDir("home");
    cleanup.push(home);
    writeFileSync(join(home, "ignore"), "*.local.ts\n");
    writeFileSync(
      join(home, ".gitconfig"),
      `[core]\n\texcludesFile = ${join(home, "ignore")}\n`,
    );
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      write(trial.cwd, "src/fix.local.ts", "x\n");
      // Guards: parent git calls run with GIT_CONFIG_GLOBAL=/dev/null.
      expect(paths(trial)).toEqual(["A src/fix.local.ts"]);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = saved;
    }
  });
});

describe("buildTemplate", () => {
  it("applies the patch before the baseline commit and keeps no history or remote", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+patched",
      "",
    ].join("\n");
    const template = buildTemplate({ dir: src, ref: "HEAD", patch });
    cleanup.push(template.root);
    expect(readFileSync(join(template.root, "src/a.ts"), "utf-8")).toBe(
      "patched\n",
    );
    // Guards: a sealed copy, one commit, no origin (base design §2).
    expect(git(template.root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(git(template.root, "remote").trim()).toBe("");
    expect(template.sha).toBe(git(src, "rev-parse", "HEAD").trim());
  });

  it("throws on a ref that is not a commit, and on a patch that does not apply, leaving no dir", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    expect(() => buildTemplate({ dir: src, ref: "nope" })).toThrow(
      /not a commit/,
    );
    const stale = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-zzz\n+y\n";
    // Guards: a failed build removes its temp dir (the caller has nothing to dispose).
    expect(() =>
      buildTemplate({ dir: src, ref: "HEAD", patch: stale }),
    ).toThrow();
  });

  it("leaves untracked files of the checkout out of the copy", () => {
    const src = sourceRepo({ "src/a.ts": "a\n" });
    write(src, ".env", "SECRET=1\n");
    const template = buildTemplate({ dir: src, ref: "HEAD" });
    cleanup.push(template.root);
    // Guards: no `linkIgnored` here — it links `.env`.
    expect(existsSync(join(template.root, ".env"))).toBe(false);
  });
});
