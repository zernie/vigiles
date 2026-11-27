/**
 * The pre-flight end to end, on a real repository built here: a one-line bug
 * in `src/add.mjs`, the fix that corrects it and adds `test/add.test.mjs`,
 * and a `head` after it that adds the symptom file. The real fix must
 * qualify with its controls as measured; a fix whose test passes anyway, or
 * fails anyway, or whose source changed again since, is refused; and the
 * user's checkout, `.git` included, is byte-identical after every case.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withVigilesRunner } from "./core/eval-load-phase.js";
import type { RegressionCaseSpec } from "./core/regression-case.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { caseWorldHost } from "./host/case-world.io.js";
import { IDENTITY } from "./host/git-env.io.js";
import { regressionCaseHost } from "./host/regression-case.io.js";
import { repoCopyHost } from "./host/workspace-host.io.js";
import {
  qualifyCase,
  type Qualification,
  type QualifyHost,
} from "./eval-case-qualify.js";
import { scoringLock } from "./eval-regression-case.js";

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

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

const commit = (repo: string, message: string): string => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
};

const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";
const TEST = (sum: number): string =>
  `import { add } from "../src/add.mjs";\nif (add(2, 2) !== ${sum}) process.exit(1);\n`;

const HOST: QualifyHost = {
  ...repoCopyHost,
  ...regressionCaseHost,
  ...caseWorldHost,
};

interface Repo {
  readonly repo: string;
  readonly fix: string;
  readonly head: string;
}

/** The base commit: the bug and a runner that imports one test file. */
function baseRepo(): string {
  const repo = tmp("case-qualify-repo");
  git(repo, "init", "-q");
  write(repo, "src/add.mjs", BUGGY);
  write(
    repo,
    "runner.mjs",
    'import { pathToFileURL } from "node:url";\n' +
      "await import(pathToFileURL(process.argv[2]).href);\n",
  );
  commit(repo, "base");
  return repo;
}

/** The fixture; `fixed` is the fix's source, `sum` what its test expects. */
function fixture(fixed = FIXED, sum = 4): Repo {
  const repo = baseRepo();
  write(repo, "src/add.mjs", fixed);
  write(repo, "test/add.test.mjs", TEST(sum));
  const fix = commit(repo, "fix");
  write(repo, "ISSUE.md", "add(2, 2) is not 4\n");
  return { repo, fix, head: commit(repo, "head") };
}

const spec = (r: Repo): RegressionCaseSpec => ({
  repo: r.repo,
  commit: r.fix,
  head: r.head,
  tests: { run: ["test/**/*.test.mjs"], data: [] },
  testCommand: [process.execPath, "runner.mjs"],
  build: { kind: "command", argv: [process.execPath, "-e", "0"] },
  deps: { kind: "none" },
  symptom: { kind: "file", path: "ISSUE.md" },
});

/** Every path under `dir` with its bytes, in one hash. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (rel: string): void => {
    const full = join(dir, rel);
    const st = lstatSync(full);
    h.update(`${rel}\0${st.mode}\0`);
    if (st.isFile()) h.update(readFileSync(full));
    else if (st.isDirectory())
      readdirSync(full)
        .sort((a, b) => a.localeCompare(b))
        .forEach((n) => {
          walk(join(rel, n));
        });
  };
  walk(".");
  return h.digest("hex");
}

/** The host, recording every template it built. */
function recording(over: Partial<QualifyHost> = {}) {
  const roots: string[] = [];
  const host: QualifyHost = {
    ...HOST,
    buildTemplate: (opts) => {
      const t = HOST.buildTemplate(opts);
      roots.push(t.root);
      return t;
    },
    ...over,
  };
  return { host, roots };
}

const qualify = (
  host: QualifyHost,
  r: Repo,
  s: RegressionCaseSpec = spec(r),
): Promise<Qualification> =>
  withVigilesRunner("eval-cli", () =>
    qualifyCase(host, { top: r.repo, lock: scoringLock() }, s),
  );

describe("qualifyCase on a real repository", () => {
  it("qualifies the real fix: red fails, gold passes, the test edit is caught", async () => {
    const r = fixture();
    const before = treeHash(r.repo);
    const { host, roots } = recording();
    const q = await qualify(host, r);
    expect(treeHash(r.repo)).toBe(before);
    if (q.kind !== "qualified") throw new Error(JSON.stringify(q));
    const p = q.prepared;
    expect(p.controls).toEqual({
      red: [false, false],
      gold: [true, true],
      goldEdit: [false],
    });
    expect(p.head).toBe(r.head);
    expect(p.task).toBe("add(2, 2) is not 4\n");
    expect(p.world.oracle).toEqual(["test/add.test.mjs"]);
    // Guards: the agent's world has the bug back and no symptom file in it.
    const world = p.world.template.root;
    expect(readFileSync(join(world, "src/add.mjs"), "utf-8")).toBe(BUGGY);
    expect(existsSync(join(world, "ISSUE.md"))).toBe(false);
    expect(roots).toEqual([world]);
    p.dispose();
    expect(existsSync(world)).toBe(false);
  });

  it("runs each control the declared number of times", async () => {
    const r = fixture();
    const q = await qualify(HOST, r, { ...spec(r), runs: 1 });
    expect(q.kind === "qualified" && q.prepared.controls).toEqual({
      red: [false],
      gold: [true],
      goldEdit: [false],
    });
    if (q.kind === "qualified") q.prepared.dispose();
  });
});

describe("qualifyCase: refusals", () => {
  it("refuses a fix whose test passes without it, and removes the world", async () => {
    // The fix only reformats: its test passes on the buggy-looking world too.
    const r = fixture(`${BUGGY}// formatted\n`, 0);
    const before = treeHash(r.repo);
    const { host, roots } = recording();
    expect(await qualify(host, r)).toEqual({
      kind: "refused",
      refusal: {
        kind: "outdated",
        why: "oracle-passes-without-fix",
        paths: ["test/add.test.mjs"],
      },
    });
    expect(treeHash(r.repo)).toBe(before);
    expect(roots.map(existsSync)).toEqual([false]);
  });

  it("refuses a fix whose test fails with it too", async () => {
    const r = fixture(FIXED, 5);
    expect(await qualify(HOST, r)).toEqual({
      kind: "refused",
      refusal: {
        kind: "fix-not-reproducible-under-scoring",
        gold: [false, false],
      },
    });
  });

  it("refuses a fix whose source head changed again, before building a world", async () => {
    const r0 = fixture();
    write(r0.repo, "src/add.mjs", "export const add = (a, b) => b + a;\n");
    const r = { ...r0, head: commit(r0.repo, "later") };
    const { host, roots } = recording();
    expect(await qualify(host, r)).toEqual({
      kind: "refused",
      refusal: {
        kind: "outdated",
        why: "revert-conflict",
        files: [{ path: "src/add.mjs" }],
      },
    });
    expect(roots).toEqual([]);
  });

  it("refuses a symptom file the working copy changed", async () => {
    const r = fixture();
    write(r.repo, "ISSUE.md", "an edit nobody committed\n");
    expect(await qualify(HOST, r)).toEqual({
      kind: "refused",
      refusal: { kind: "symptom-uncommitted-changes", path: "ISSUE.md" },
    });
  });
});

describe("qualifyCase: faults", () => {
  it("removes the world when a control throws", async () => {
    const r = fixture();
    const { host, roots } = recording({
      cloneTemplate: () => {
        throw new Error("disk full");
      },
    });
    await expect(qualify(host, r)).rejects.toThrow("disk full");
    expect(roots.map(existsSync)).toEqual([false]);
  });

  it("throws when a control vigiles built is not scored as built", async () => {
    const r = fixture();
    const { host, roots } = recording({
      // Every control reads as an untouched tree: gold's edit was lost.
      carryRows: () => 0,
      touchedPaths: () => ({
        rows: [],
        unstaged: { kind: "unknown", detail: "x" },
        ignoredNewFiles: 0,
      }),
    });
    await expect(qualify(host, r)).rejects.toThrow(Error);
    expect(roots.map(existsSync)).toEqual([false]);
  });
});
