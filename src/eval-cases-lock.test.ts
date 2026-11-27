/**
 * The cases' part of an eval's lock, on a real repository built here: under
 * `off` nothing is read; a missing engine fingerprint throws under `check`
 * before any git read and, under `update`, says why no lock is written; and
 * the inputs change with any entry field, the engine and the lockfiles at
 * `head`, all without qualifying a case.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineFingerprint, EvalHost } from "./core/eval-host.js";
import type { RegressionCaseEntry } from "./core/regression-case-entries.js";
import { RegressionCaseRefusalError } from "./core/regression-case-refusal.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { casesLock } from "./eval-cases-lock.js";
import { IDENTITY } from "./host/git-env.io.js";
import { evalHost } from "./host/workspace-host.io.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...IDENTITY },
  });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const commit = (repo: string, message: string): string => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
};

/** A fix and a `head` after it; `lock` is the package-lock.json at head. */
function caseEntry(lock = "{}\n"): RegressionCaseEntry {
  const repo = makeTmpDir("cases-lock-repo");
  cleanup.push(repo);
  git(repo, "init", "-q");
  write(repo, ".gitignore", "node_modules/\n");
  write(repo, "package-lock.json", "{}\n");
  write(repo, "src/add.mjs", "export const add = (a, b) => a - b;\n");
  commit(repo, "base");
  write(repo, "src/add.mjs", "export const add = (a, b) => a + b;\n");
  write(repo, "test/add.test.mjs", "process.exit(0);\n");
  const fix = commit(repo, "fix");
  write(repo, "ISSUE.md", "add is wrong\n");
  write(repo, "package-lock.json", lock);
  write(repo, "node_modules/dep/index.js", "export {};\n");
  return {
    id: "add",
    repo,
    commit: fix,
    head: commit(repo, "head"),
    tests: { run: ["test/**/*.test.mjs"], data: [] },
    testCommand: ["node"],
    build: { kind: "none", reason: "plain node" },
    deps: { kind: "node-modules" },
    symptom: { kind: "file", path: "ISSUE.md" },
  };
}

const FOUND: EngineFingerprint = { kind: "found", hash: "e1" };
const MISSING: EngineFingerprint = { kind: "missing", path: "/x/e.json" };

/** The real host with a fixed fingerprint, recording which ports are read. */
function hostWith(engine: EngineFingerprint) {
  const reads: string[] = [];
  const base: EvalHost = { ...evalHost, engineFingerprint: () => engine };
  const host = new Proxy(base, {
    get: (target, key, receiver) => {
      reads.push(String(key));
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });
  return { host, reads };
}

const key = (host: EvalHost, entries: readonly RegressionCaseEntry[]): string =>
  JSON.stringify(casesLock(host, entries, "update").inputs);

describe("casesLock: what is read", () => {
  it("under off, reads nothing and adds nothing", () => {
    const { host, reads } = hostWith(FOUND);
    // Guards: a run with no lock never pays for git reads.
    expect(casesLock(host, [caseEntry()], "off")).toEqual({
      inputs: undefined,
      why: undefined,
    });
    expect(reads).toEqual([]);
  });

  it("a missing fingerprint throws under check before git is read", () => {
    const { host, reads } = hostWith(MISSING);
    const entry = caseEntry();
    // Guards: a lock that cannot go stale with the engine is never replayed.
    expect(() => casesLock(host, [entry], "check")).toThrow(Error);
    expect(reads).toEqual(["engineFingerprint"]);
  });

  it("a missing fingerprint under update runs, and says why no lock is written", () => {
    const got = casesLock(hostWith(MISSING).host, [caseEntry()], "update");
    // Guards: the run happens, but its lock is refused.
    expect(got.why).toBeDefined();
    expect(got.inputs).toMatchObject({ engine: undefined });
    expect(casesLock(hostWith(FOUND).host, [caseEntry()], "update").why).toBe(
      undefined,
    );
  });

  it("a case whose commit is not in its repository is refused by id", () => {
    const entry = { ...caseEntry(), commit: "0".repeat(40) };
    expect(() => casesLock(hostWith(FOUND).host, [entry], "update")).toThrow(
      RegressionCaseRefusalError,
    );
  });
});

describe("casesLock: what changes the key", () => {
  it("is the same for the same cases, and changes with an entry field or the engine", () => {
    const entry = caseEntry();
    const { host } = hostWith(FOUND);
    // Guards: a stable key replays; any edit to a case makes the lock stale.
    expect(key(host, [entry])).toBe(key(host, [entry]));
    expect(key(host, [{ ...entry, testCommand: ["node", "--test"] }])).not.toBe(
      key(host, [entry]),
    );
    expect(key(hostWith({ kind: "found", hash: "e2" }).host, [entry])).not.toBe(
      key(host, [entry]),
    );
  });

  it("holds the lockfile's blob at head, read from git", () => {
    const lock = '{"lockfileVersion":3}\n';
    const blob = execFileSync("git", ["hash-object", "--stdin"], {
      input: lock,
      encoding: "utf-8",
    }).trim();
    const got = casesLock(hostWith(FOUND).host, [caseEntry(lock)], "update");
    // Guards: the installs are keyed by what head pins, so a dependency change is a new world.
    expect(got.inputs).toMatchObject({
      cases: [{ lockfiles: [{ path: "package-lock.json", blob }] }],
    });
  });
});
