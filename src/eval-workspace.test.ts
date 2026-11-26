/**
 * `runEvalWith` on a repo workspace, with a fake agent runner (no model) and
 * the real host adapter (real git, real copies).
 *
 * What it proves: a trial's world is the sealed copy plus the arm's own
 * writes; `ctx.experimental_workspace` carries a base the scorer can diff the
 * agent's edits against; installs are copied, not linked; every refusal fires
 * before the runner is called once; and nothing is left on disk.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, defaultAdapter } from "./adapter-registry.js";
import type { Metrics } from "./core/eval-aggregate.js";
import { makeTmpDir } from "./core/tmp-root.js";
import { WorkspaceRefusalError, type RepoWorkspace } from "./core/workspace.js";
import {
  runEvalWith,
  type AgentRunArgs,
  type EvalSpec,
  type RunContext,
} from "./eval.js";
import { repoCopyHost } from "./host/workspace-host.io.js";

/** The harness paid_runEval drives, and one it does not. */
const DRIVEN = defaultAdapter.name;
const OTHER = ADAPTERS.map((a) => a.name).find((n) => n !== DRIVEN) ?? "";

const RESULT = JSON.stringify({ type: "result", num_turns: 1 });
const INHERIT = {
  kind: "inherit",
  reason: "unit test: a fake runner",
} as const;

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
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repo(files: Record<string, string>): string {
  const dir = makeTmpDir("ws-src");
  cleanup.push(dir);
  git(dir, "init", "-q");
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

const ws = (dir: string, over: Partial<RepoWorkspace> = {}): RepoWorkspace => ({
  kind: "repo",
  dir,
  ref: "HEAD",
  deps: { kind: "none" },
  ...over,
});

/** A runner that edits like an agent would: `src/a.ts` gets a fix. */
function editingRunner(seen: AgentRunArgs[] = []) {
  return (a: AgentRunArgs): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    writeFileSync(join(a.cwd, "src/a.ts"), "fixed\n");
    return Promise.resolve({ code: 0, stdout: RESULT });
  };
}

/** A spec as a plain-JS eval file can write it, whatever the type says. */
const asSpec = (s: unknown): EvalSpec =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the malformed keys under test are exactly what the type rules out
  s as EvalSpec;

function spec(
  workspace: unknown,
  measure: (ctx: RunContext) => Metrics,
  over: Readonly<Record<string, unknown>> = {},
): EvalSpec {
  return asSpec({
    env: INHERIT,
    experimental_workspace: workspace,
    task: "fix it",
    trials: 1,
    spacingSec: 0,
    measure,
    ...over,
  });
}

const noMetrics = (): Metrics => ({});

/** Run `f` with a private TMPDIR; returns what is left in it afterwards. */
async function leftIn(f: () => Promise<unknown>): Promise<string[]> {
  const own = makeTmpDir("own-tmp");
  cleanup.push(own);
  await withTmpDir(own, f);
  return readdirSync(own);
}

/**
 * Run `f` with TMPDIR set to `dir`, then put back what was there. An unset
 * TMPDIR is deleted again: assigning `undefined` to `process.env` stores the
 * string "undefined", so every later temp dir lands under `undefined/`.
 */
async function withTmpDir(
  dir: string,
  f: () => Promise<unknown>,
): Promise<void> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    await f();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = saved;
  }
}

/** A measure that records what the trial's base shows as touched. */
function touchedRecorder(rows: string[][]) {
  return (ctx: RunContext): Metrics => {
    const view = ctx.experimental_workspace;
    if (view === undefined) throw new Error("no workspace view");
    const touched = repoCopyHost.touchedPaths(view, ctx.cwd).rows;
    rows.push([
      view.arm,
      ...view.armPaths,
      ...touched.map((r) => `${r.status} ${r.path}`),
    ]);
    return { envCopied: existsSync(join(ctx.cwd, ".env")) };
  };
}

describe("runEvalWith on a repo workspace: the trial's world", () => {
  it("runs the trial in a sealed copy, the arm's files on top, and hands measure a base to diff against", async () => {
    const src = repo({ "src/a.ts": "broken\n", "README.md": "r\n" });
    write(src, ".env", "SECRET=1\n");
    const seen: AgentRunArgs[] = [];
    const rows: string[][] = [];
    const arms = { mine: { files: { "notes/arm.md": "arm\n" } } };
    const run = () =>
      runEvalWith(
        spec(ws(src), touchedRecorder(rows), { arms }),
        editingRunner(seen),
        repoCopyHost,
      );
    const reports: Awaited<ReturnType<typeof run>>[] = [];
    const left = await leftIn(async () => reports.push(await run()));
    // Guards: the arm's file is in the base, so only the agent's edit is touched.
    expect(rows).toEqual([["mine", "notes/arm.md", "M src/a.ts"]]);
    // Guards: `git archive` — no untracked file of the checkout reaches the trial.
    expect(reports[0]?.arms.mine?.metrics.envCopied).toBe(0);
    expect(seen).toHaveLength(1);
    // Guards: the template and every trial's base dir are removed.
    expect(left).toEqual([]);
  });

  it("applies the patch before the trial, so the agent starts from the patched world", async () => {
    const src = repo({ "src/a.ts": "fixed\n" });
    const patch =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-fixed\n+broken\n";
    const seen: string[] = [];
    const runner = (a: AgentRunArgs) => {
      seen.push(readFileSync(join(a.cwd, "src/a.ts"), "utf-8"));
      return Promise.resolve({ code: 0, stdout: RESULT });
    };
    await runEvalWith(
      spec(ws(src, { patch }), noMetrics),
      runner,
      repoCopyHost,
    );
    // Guards: the case world (HEAD + revert) is what the agent sees, never HEAD itself.
    expect(seen).toEqual(["broken\n"]);
  });

  it("puts the workspace's instruction files in the world the context check expects", async () => {
    const src = repo({ "src/a.ts": "x\n", "CLAUDE.md": "Always say hi.\n" });
    const report = await runEvalWith(
      spec(ws(src), noMetrics),
      editingRunner(),
      repoCopyHost,
    );
    // Guards: the fake runner sends no request, so an expected file is not "nothing expected".
    expect(report.arms.default?.context?.[0]?.kind).not.toBe(
      "nothing-expected",
    );
  });
});

/**
 * A runner whose first attempt is rate-limited AFTER it edited the tree (an
 * agent that worked, then hit the limit), and whose later attempts record what
 * they found before editing.
 */
function rateLimitedOnceRunner(found: string[]) {
  let attempt = 0;
  return (a: AgentRunArgs) => {
    attempt += 1;
    found.push(readFileSync(join(a.cwd, "src/a.ts"), "utf-8"));
    writeFileSync(join(a.cwd, "src/a.ts"), `edit ${attempt}\n`);
    writeFileSync(join(a.cwd, `scratch-${attempt}.txt`), "left behind\n");
    return Promise.resolve(
      attempt === 1
        ? { code: 1, stdout: "", stderr: "API Error: 429 rate_limit_error" }
        : { code: 0, stdout: RESULT },
    );
  };
}

describe("runEvalWith on a repo workspace: a rate-limited retry", () => {
  it("reseeds the trial and records a fresh base, so the scored tree is one attempt's work", async () => {
    const src = repo({ "src/a.ts": "broken\n" });
    const found: string[] = [];
    const rows: string[][] = [];
    const arms = { retried: { files: { "notes/arm.md": "arm\n" } } };
    const run = () =>
      runEvalWith(
        spec(ws(src), touchedRecorder(rows), {
          arms,
          rateLimitRetries: 1,
          retryBackoffMs: 0,
        }),
        rateLimitedOnceRunner(found),
        repoCopyHost,
      );
    const left = await leftIn(run);
    // Guards: the retry starts from the seed, never from the discarded attempt's edit.
    expect(found).toEqual(["broken\n", "broken\n"]);
    // Guards: the base is re-recorded after the reseed, so only the scored attempt's edits are touched (the first attempt's scratch file is gone).
    expect(rows).toEqual([
      ["retried", "notes/arm.md", "A scratch-2.txt", "M src/a.ts"],
    ]);
    // Guards: the reseed leaves no temp dir behind.
    expect(left).toEqual([]);
  });

  it("seeds a first attempt that is not retried exactly once", async () => {
    const src = repo({ "src/a.ts": "broken\n" });
    const seen: AgentRunArgs[] = [];
    let clones = 0;
    const host = {
      ...repoCopyHost,
      cloneTemplate: (
        ...args: Parameters<typeof repoCopyHost.cloneTemplate>
      ) => {
        clones += 1;
        repoCopyHost.cloneTemplate(...args);
      },
    };
    await runEvalWith(spec(ws(src), noMetrics), editingRunner(seen), host);
    // Guards: the first attempt is not double-seeded.
    expect([seen.length, clones]).toEqual([1, 1]);
  });
});

/** A checkout with a root install, a nested one, and one outside the tree. */
function repoWithInstalls(): string {
  const src = repo({ "src/a.ts": "broken\n", "pkg/package.json": "{}\n" });
  write(src, "node_modules/dep/index.js", "original\n");
  write(src, "pkg/node_modules/inner/index.js", "inner\n");
  write(src, "gone/node_modules/x/index.js", "not in the tree\n");
  return src;
}

function installWriter(a: AgentRunArgs) {
  writeFileSync(join(a.cwd, "node_modules/dep/index.js"), "changed\n");
  return Promise.resolve({ code: 0, stdout: RESULT });
}

describe("runEvalWith on a repo workspace: installs", () => {
  it("copies each install, so a write in the trial never reaches the checkout", async () => {
    const src = repoWithInstalls();
    const seen: boolean[] = [];
    const measure = (ctx: RunContext): Metrics => {
      seen.push(
        existsSync(join(ctx.cwd, "pkg/node_modules/inner/index.js")),
        existsSync(join(ctx.cwd, "gone")),
      );
      return {};
    };
    const deps = { kind: "node-modules" } as const;
    await runEvalWith(
      spec(ws(src, { deps }), measure),
      installWriter,
      repoCopyHost,
    );
    // Guards: a byte copy, never a hardlink (vitest writes into node_modules in place).
    expect(readFileSync(join(src, "node_modules/dep/index.js"), "utf-8")).toBe(
      "original\n",
    );
    // Guards: a nested install is copied; one whose parent is not in the tree is not.
    expect(seen).toEqual([true, false]);
  });
});

/** The refusal a spec raises (its kind, or the message), and that the runner never ran. */
async function refusal(
  s: EvalSpec,
  wired: { readonly host: boolean } = { host: true },
): Promise<string> {
  const seen: AgentRunArgs[] = [];
  try {
    await (wired.host
      ? runEvalWith(s, editingRunner(seen), repoCopyHost)
      : runEvalWith(s, editingRunner(seen)));
  } catch (e) {
    expect(seen).toEqual([]);
    return e instanceof WorkspaceRefusalError ? e.refusal.kind : String(e);
  }
  throw new Error("the spec was not refused");
}

describe("workspace refusals: the spec", () => {
  it("refuses a fixture beside it, the cache, a non-repo dir and a bad ref", async () => {
    const src = repo({ "a.txt": "a\n" });
    const notRepo = makeTmpDir("not-repo");
    cleanup.push(notRepo);
    const at = (over: Readonly<Record<string, unknown>>, w = ws(src)) =>
      refusal(spec(w, noMetrics, over));
    // Guards: each refusal is typed and fires before the runner.
    expect(await at({ fixture: { "a.txt": "x" } })).toBe(
      "workspace-with-fixture",
    );
    expect(await at({ cache: "readwrite" })).toBe(
      "cache-not-supported-with-workspace",
    );
    expect(await at({}, ws(notRepo))).toBe("not-a-git-work-tree");
    expect(await at({}, ws(join(notRepo, "missing")))).toBe(
      "not-a-git-work-tree",
    );
    expect(await at({}, ws(src, { ref: "nope" }))).toBe("ref-not-a-commit");
  });

  it("refuses a workspace when no host is wired, naming the door that has one", async () => {
    const src = repo({ "a.txt": "a\n" });
    expect(await refusal(spec(ws(src), noMetrics), { host: false })).toContain(
      "paid_runEval",
    );
  });

  it("refuses a malformed key with the path of the bad field", async () => {
    const src = repo({ "a.txt": "a\n" });
    const bad = { ...ws(src), deps: { kind: "pnpm" } };
    expect(await refusal(spec(bad, noMetrics))).toContain(
      "experimental_workspace.deps",
    );
  });
});

describe("workspace refusals: the harness", () => {
  it("refuses a repo that declares only harnesses paid_runEval does not drive", async () => {
    const src = repo({
      ".vigilesrc.json": JSON.stringify({ harnesses: { [OTHER]: {} } }),
    });
    expect(await refusal(spec(ws(src), noMetrics))).toBe("harness-not-driven");
  });

  it("runs a repo that declares the driven harness beside another", async () => {
    const src = repo({
      ".vigilesrc.json": JSON.stringify({
        harnesses: { [OTHER]: {}, [DRIVEN]: {} },
      }),
      "src/a.ts": "x\n",
    });
    await expect(
      runEvalWith(spec(ws(src), noMetrics), editingRunner(), repoCopyHost),
    ).resolves.toBeDefined();
  });

  it("runs a repo whose .vigilesrc.json does not parse or declares no harnesses", async () => {
    for (const text of ["{ not json", JSON.stringify({ exclude: [] })]) {
      const src = repo({ ".vigilesrc.json": text, "src/a.ts": "x\n" });
      // Guards: an unreadable config declares nothing, so nothing is refused for it.
      await expect(
        runEvalWith(spec(ws(src), noMetrics), editingRunner(), repoCopyHost),
      ).resolves.toBeDefined();
    }
  });

  it("does not refuse a lone AGENTS.md with no declaration", async () => {
    const src = repo({ "AGENTS.md": "be brief\n", "src/a.ts": "x\n" });
    await expect(
      runEvalWith(spec(ws(src), noMetrics), editingRunner(), repoCopyHost),
    ).resolves.toBeDefined();
  });
});

describe("workspace refusals: the machine", () => {
  it("refuses an install link that leaves the world", async () => {
    const src = repo({ "a.txt": "a\n" });
    mkdirSync(join(src, "node_modules"));
    symlinkSync("/etc", join(src, "node_modules", "escape"));
    const deps = { kind: "node-modules" } as const;
    expect(await refusal(spec(ws(src, { deps }), noMetrics))).toBe(
      "link-outside-world",
    );
  });

  it("refuses when the temp file system cannot hold the trial copies", async () => {
    const src = repo({ "a.txt": "a\n" });
    expect(await refusal(spec(ws(src), noMetrics, { concurrency: 1e15 }))).toBe(
      "not-enough-disk",
    );
  });

  it("refuses when trial dirs would be made inside the repo", async () => {
    const src = repo({ "a.txt": "a\n" });
    const inside = join(src, "tmp");
    mkdirSync(inside);
    await withTmpDir(inside, async () => {
      expect(await refusal(spec(ws(src), noMetrics))).toBe(
        "trial-dir-inside-repo",
      );
    });
  });
});
