/**
 * A folder's own instruction file on a Claude Code repository, through the
 * BUILT CLI (vitest, e2e on `dist/cli.js`, no model). Claude Code loads
 * `<folder>/CLAUDE.md` the first time a file in that folder is read, keeps it
 * until compaction, and since 2.1.309 cuts it past a per-file limit (40,000
 * characters on a 200K-window model, 150,000 on a 1M one). `context-creep`
 * reports each such file over the floor as a finding no baseline accepts.
 * The Codex twin is `src/adapters/codex/on-demand-lint.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BASELINE_FILE } from "../../core/baseline-store.js";
import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { claudeCodeDialect } from "./dialect.js";

const CLI = resolve(import.meta.dirname, "..", "..", "..", "dist", "cli.js");

/** The harness's floor, read from the adapter rather than restated. */
const LIMIT = claudeCodeDialect.onDemandFileLimit?.limit ?? 0;

let dir: string;

function run(args: readonly string[]): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  const r = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf-8",
    env,
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** The finding lines of a run: the ones marked as failures. */
function failures(out: string): readonly string[] {
  return out.split("\n").filter((l) => l.trimStart().startsWith("✗"));
}

/** Whether some failure line is about `path`. */
function flags(out: string, path: string): boolean {
  return failures(out).some((l) => l.includes(` ${path} `));
}

/** An instruction file of exactly `chars` characters. */
function sized(chars: number): string {
  const head = "# Folder rules\n\n";
  return head + "x".repeat(chars - head.length);
}

beforeEach(() => {
  dir = makeTmpDir("on-demand-lint-cc");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { "claude-code": {} } }));
  put("CLAUDE.md", "# Project\n\nUse the npm scripts in package.json.\n");
  put("pkg/a.ts", "export {};\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("a folder's CLAUDE.md against the per-file limit", () => {
  it("reads the floor from the adapter", () => {
    // Guards: the tests below are about the adapter's number, not a constant here.
    expect(LIMIT).toBeGreaterThan(0);
  });

  it("over the limit: lint fails and names the file, the limit and the cut", () => {
    put("pkg/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: a nested file the harness cuts is a failing finding, not silence.
    expect(r.code).not.toBe(0);
    expect(flags(r.out, "pkg/CLAUDE.md")).toBe(true);
    expect(r.out).toContain(LIMIT.toLocaleString("en-US"));
  });

  it("at the limit: lint passes and says nothing about it", () => {
    put("pkg/CLAUDE.md", sized(LIMIT));
    const r = run(["lint"]);
    // Guards: the boundary is inclusive, as the harness's own cut is.
    expect(r.code).toBe(0);
    expect(failures(r.out)).toEqual([]);
  });

  it("a deeper folder's file is checked on its own", () => {
    put("pkg/CLAUDE.md", sized(100));
    put("pkg/deep/er/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: the limit is per file, so only the file over it is named.
    expect(r.code).not.toBe(0);
    expect(flags(r.out, "pkg/deep/er/CLAUDE.md")).toBe(true);
    expect(flags(r.out, "pkg/CLAUDE.md")).toBe(false);
  });

  it("is never recorded: --update-baseline leaves no entry and lint still fails", () => {
    put("pkg/CLAUDE.md", sized(LIMIT + 1));
    run(["lint", "--update-baseline"]);
    const stored = existsSync(join(dir, BASELINE_FILE))
      ? readFileSync(join(dir, BASELINE_FILE), "utf-8")
      : "";
    // Guards: a cut file is lost rules, so no recorded size can accept it.
    expect(stored).not.toContain("pkg");
    expect(run(["lint"]).code).not.toBe(0);
  });
});

describe("a copy no session should load", () => {
  it("under data/ and over the limit: it is reported, with the exclusion as the cure", () => {
    put("data/vendor-x/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: Claude Code loads it once a file there is touched, so a name is no skip.
    expect(r.code).not.toBe(0);
    expect(flags(r.out, "data/vendor-x/CLAUDE.md")).toBe(true);
    expect(r.out).toContain(
      claudeCodeDialect.onDemandFileLimit?.excludeSetting.key ?? "?",
    );
  });

  it("excluded in .vigilesrc.json: lint passes", () => {
    put(
      ".vigilesrc.json",
      JSON.stringify({
        harnesses: { "claude-code": {} },
        exclude: ["data/**"],
      }),
    );
    put("data/vendor-x/CLAUDE.md", sized(LIMIT + 1));
    expect(run(["lint"]).code).toBe(0);
  });

  it("excluded by the committed claudeMdExcludes setting: lint passes", () => {
    put(
      ".claude/settings.json",
      // The setting is matched against ABSOLUTE paths, so only a `**/` pattern applies.
      JSON.stringify({ claudeMdExcludes: ["**/data/**"] }),
    );
    put("data/vendor-x/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: the harness never loads it, so neither does the check.
    expect(r.code).toBe(0);
    expect(failures(r.out)).toEqual([]);
  });
});

describe("the same class: every file the chain says loads on demand", () => {
  it("a path-scoped rule over the limit fails too", () => {
    put(
      ".claude/rules/api.md",
      `---\npaths:\n  - "src/api/**"\n---\n${sized(LIMIT + 1)}`,
    );
    const r = run(["lint"]);
    // Guards: a path-scoped rule is cut by the same per-file limit.
    expect(r.code).not.toBe(0);
    expect(flags(r.out, ".claude/rules/api.md")).toBe(true);
  });

  it("a folder's AGENTS.md beside its CLAUDE.md is never read, so it is not weighed", () => {
    put("pkg/CLAUDE.md", sized(100));
    put("pkg/AGENTS.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: the harness reads the folder's CLAUDE.md instead, so no false red.
    expect(r.code).toBe(0);
    expect(failures(r.out)).toEqual([]);
  });

  it("a folder's AGENTS.md alone over the limit fails", () => {
    put("pkg/AGENTS.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: without a CLAUDE.md beside it, the harness reads it on touch.
    expect(r.code).not.toBe(0);
    expect(flags(r.out, "pkg/AGENTS.md")).toBe(true);
  });
});

describe("audit shows the same check", () => {
  it("names the file over the cut", () => {
    put("pkg/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["audit"]);
    // Guards: one detector for lint and audit, so audit cannot stay silent.
    expect(r.out).toContain("pkg/CLAUDE.md");
    expect(r.out).toContain(LIMIT.toLocaleString("en-US"));
  });
});

describe("settings decide loading whatever vigiles excludes", () => {
  it("claudeMdExcludes still applies when .vigilesrc.json excludes .claude", () => {
    put(
      ".vigilesrc.json",
      JSON.stringify({
        harnesses: { "claude-code": {} },
        exclude: [".claude/**"],
      }),
    );
    put(
      ".claude/settings.json",
      JSON.stringify({ claudeMdExcludes: ["**/data/**"] }),
    );
    put("data/vendor-x/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: what the harness loads follows its settings, not vigiles's exclude.
    expect(r.code).toBe(0);
    expect(failures(r.out)).toEqual([]);
  });

  it("a path-scoped rule under an excluded .claude is not reported", () => {
    put(
      ".vigilesrc.json",
      JSON.stringify({
        harnesses: { "claude-code": {} },
        exclude: [".claude/**"],
      }),
    );
    put(
      ".claude/rules/api.md",
      `---\npaths:\n  - "src/api/**"\n---\n${sized(LIMIT + 1)}`,
    );
    const r = run(["lint"]);
    // Guards: vigiles's exclude still decides which files it reports on.
    expect(failures(r.out)).toEqual([]);
  });
});

describe("exclude never hides what decides loading", () => {
  it.each(["pkg/CLAUDE.md", "pkg/.claude/**"])(
    "a superseding file excluded by %s still supersedes",
    (pattern) => {
      put(
        ".vigilesrc.json",
        JSON.stringify({
          harnesses: { "claude-code": {} },
          exclude: [pattern],
        }),
      );
      put(
        pattern === "pkg/CLAUDE.md" ? "pkg/CLAUDE.md" : "pkg/.claude/CLAUDE.md",
        sized(100),
      );
      put("pkg/AGENTS.md", sized(LIMIT + 1));
      const r = run(["lint"]);
      // Guards: exclude hides a file from the report, never from what decides loading.
      expect(r.code).toBe(0);
      expect(flags(r.out, "pkg/AGENTS.md")).toBe(false);
    },
  );
});

describe("the folder walk", () => {
  it("a folder's .claude/CLAUDE.md supersedes its AGENTS.md", () => {
    put("pkg/.claude/CLAUDE.md", sized(100));
    put("pkg/AGENTS.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: the walk reads the one dot-directory file that decides a supersede.
    expect(r.code).toBe(0);
    expect(failures(r.out)).toEqual([]);
  });

  it("a worktree copy under .claude/ is never walked", () => {
    put(".claude/worktrees/w1/pkg/CLAUDE.md", sized(LIMIT + 1));
    const r = run(["lint"]);
    // Guards: a checkout inside a dot-directory is a copy, not a folder of the repo.
    expect(failures(r.out)).toEqual([]);
  });
});
