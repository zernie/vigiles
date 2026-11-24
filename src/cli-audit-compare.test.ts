/**
 * `audit --format=…` and `audit --format=md --compare[=<ref>]`, through the
 * built binary on real git repositories.
 *
 * The CONTRACT held here is the one the GitHub Action relies on, so the Action
 * decides nothing (#474): the CLI picks the base itself — on a pull request the
 * base the event names, locally the default branch, or an explicit ref — copies
 * it, audits it under ITS OWN config with the checkout's environment (installed
 * dependencies, build output) held constant, and renders the change. When there
 * is no base, the section says why instead of guessing.
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { z } from "zod";
import { AUDIT_SUMMARY_MARKER } from "./audit-pr-summary.js";
import { defaultAdapter } from "./adapter-registry.js";
import { skillsHome } from "./core/layout.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { LAST_AUDIT_FILE, VIGILES_DIR } from "./local-files.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
const { layout } = defaultAdapter;
const SKILLS = skillsHome(layout) ?? "skills";

/** A person's terminal: ci-info reads `CI=false` as "not CI", whatever else is set. */
const LOCAL: NodeJS.ProcessEnv = {
  ...process.env,
  CI: "false",
  GITHUB_ACTIONS: "",
};

function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = LOCAL,
): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync("node", [CLI, ...args], {
    cwd,
    env,
    encoding: "utf-8",
    timeout: 120000,
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

let repo = "";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function write(rel: string, text: string): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

const skill = (name: string, description?: string): string =>
  description === undefined
    ? `---\nname: ${name}\n---\n\nDo the thing.\n`
    : `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`;

/**
 * The PR base: a harness whose `.vigilesrc.json` excludes a vendored skill that
 * has no description (it would cost points if counted), and a hook whose
 * script is generated and git-ignored, so it exists only in the checkout (the
 * shape of vigiles' own `dist/cli.js`). Returns the base commit.
 */
function commitBase(): string {
  write(layout.instructionFile, "# Project\n\nBe careful.\n");
  write(`${SKILLS}/greet/SKILL.md`, skill("greet", "Greet on hello."));
  write(`${SKILLS}/odd/SKILL.md`, skill("odd"));
  write(".vigilesrc.json", JSON.stringify({ exclude: [`${SKILLS}/odd`] }));
  // A hook line vigiles writes, whose script is checked for existence
  // (`hook-script-exists`). The script itself is generated and git-ignored.
  write(
    layout.settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'sh "${CLAUDE_PROJECT_DIR}/.vigiles/hook-check.sh" || exit 0',
              },
            ],
          },
        ],
      },
    }),
  );
  write(".gitignore", ".vigiles/hook-check.sh\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return git("rev-parse", "HEAD");
}

/** The PR: touches nothing the audit reads. Then the checkout is set up. */
function commitHead(): void {
  write("README.md", "# readme\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "head");
  write(".vigiles/hook-check.sh", "exit 0\n");
}

/** GitHub Actions on a pull request whose base is `sha`. */
function prEnv(sha: string): NodeJS.ProcessEnv {
  const event = join(repo, "..", "event.json");
  writeFileSync(
    event,
    JSON.stringify({ pull_request: { number: 7, base: { sha } } }),
  );
  return {
    ...process.env,
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: event,
  };
}

const headline = (md: string): string =>
  md.split("\n").find((l) => l.startsWith("### ")) ?? "";

let root = "";
beforeEach(() => {
  root = makeTmpDir("audit-compare");
  repo = join(root, "repo");
  mkdirSync(repo);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("audit --format", () => {
  beforeEach(() => {
    commitBase();
  });

  it("--format=json prints what --json prints", () => {
    const a = run(["audit", "--format=json"], repo);
    const b = run(["audit", "--json"], repo);
    expect(a.exitCode, a.stderr).toBe(0);
    const strip = (s: string): unknown => ({
      ...z.record(z.string(), z.unknown()).parse(JSON.parse(s)),
      generatedAt: undefined,
    });
    expect(strip(a.stdout)).toEqual(strip(b.stdout));
  });

  it("--format=md prints the PR-comment section, as --md does", () => {
    const a = run(["audit", "--format=md"], repo);
    expect(a.exitCode, a.stderr).toBe(0);
    expect(a.stdout.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
    expect(a.stdout).toEqual(run(["audit", "--md"], repo).stdout);
  });

  it.each([
    [["--json", "--md"]],
    [["--format=json", "--md"]],
    [["--format=md", "--format=json"]],
    [["--format=xml"]],
  ])("%j is refused (exit 2), never one of them picked", (flags) => {
    const r = run(["audit", ...flags], repo);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--format");
  });
});

describe("audit --format=md --compare", () => {
  it("on a pull request, compares with the base the event names: an untouched harness is unchanged", () => {
    const sha = commitBase();
    commitHead();
    const r = run(["audit", "--format=md", "--compare"], repo, prEnv(sha));
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
    // The base is audited under its OWN exclude and sees the checkout's
    // ignored files: either mistake shows here as a change nobody made.
    expect(headline(r.stdout)).toContain("unchanged");
    expect(r.stdout).not.toMatch(/[▲▼]/);
  });

  it("a real change shows as one", () => {
    const sha = commitBase();
    write(`${SKILLS}/bare/SKILL.md`, skill("bare"));
    write(`${SKILLS}/bare2/SKILL.md`, skill("bare2"));
    commitHead();
    const r = run(["audit", "--format=md", "--compare"], repo, prEnv(sha));
    expect(r.exitCode, r.stderr).toBe(0);
    expect(headline(r.stdout)).not.toContain("unchanged");
    expect(r.stdout).toMatch(/[▲▼]/);
  });

  it("--compare=<ref> compares with that ref, locally", () => {
    const sha = commitBase();
    commitHead();
    const r = run(["audit", "--format=md", `--compare=${sha}`], repo);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(headline(r.stdout)).toContain("unchanged");
  });

  it("with no base to compare with, the section says why", () => {
    commitBase();
    const env = { ...prEnv("0"), GITHUB_EVENT_NAME: "push" };
    const r = run(["audit", "--format=md", "--compare"], repo, env);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
    expect(r.stdout).toContain("No comparison with the PR base");
    expect(r.stdout).toContain("push");
  });

  it("an unknown ref is a base that could not be read, not an error", () => {
    commitBase();
    const r = run(["audit", "--format=md", "--compare=no-such-ref"], repo);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("No comparison with the PR base");
    expect(r.stdout).toContain("no-such-ref");
  });
});

describe("audit --compare: what it leaves, and what it refuses", () => {
  it("leaves no trace: no stamp, no report, no temp copy", () => {
    const sha = commitBase();
    commitHead();
    const before = readdirSync(tmpdir()).filter((n) =>
      n.startsWith("vigiles-base-"),
    ).length;
    run(["audit", "--format=md", "--compare"], repo, prEnv(sha));
    expect(existsSync(join(repo, VIGILES_DIR, LAST_AUDIT_FILE))).toBe(false);
    expect(existsSync(join(repo, "vigiles-report.json"))).toBe(false);
    const after = readdirSync(tmpdir()).filter((n) =>
      n.startsWith("vigiles-base-"),
    ).length;
    expect(after).toBe(before);
  });

  it.each([[["--compare"]], [["--compare=main"]], [["--json", "--compare"]]])(
    "%j without --format=md is refused (exit 2), not ignored",
    (flags) => {
      commitBase();
      const r = run(["audit", ...flags], repo);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--format=md");
    },
  );
});
