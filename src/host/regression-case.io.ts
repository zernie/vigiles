/**
 * The machine side of scoring a regression case (vigiles#416): the carry of
 * a trial's kept edits into a scoring tree, the outside-link scan of that
 * tree, and the scoring process. The host adapter of core's
 * `RegressionCaseHost` port; the pure rules are `src/core/case-scoring.ts`.
 *
 * - Every git call runs without the user's global and system config
 *   (`./git-env.io.ts`).
 * - Kept edits are carried as blobs read from the trial's base git dir, never
 *   as a patch over the trial dir: only a regular file's bytes and its exec
 *   bit reach the scoring tree, and an existing entry at the path (a link, a
 *   directory) is removed first, so a write never goes through it.
 * - A scoring process runs with a fresh HOME, a scrubbed env and `CI=1`, in
 *   its own process group; the group is killed at the timeout and again after
 *   the process exits, so a server or watcher it left does not outlive it.
 *   Not confined: it can write anywhere the user can.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RegressionCaseHost, ScoringRun } from "../core/case-scoring.js";
import { scrubbedRunEnv } from "../core/run-env.js";
import { makeTmpDir } from "../core/tmp-root.js";
import type { TouchedRow } from "../core/workspace.js";
import { gitEnv } from "./git-env.io.js";
import { escapingLinks } from "./link-probe.io.js";

function gitBytes(cwd: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Write the kept rows into `dest`: deletions first (a file may replace a
 * directory the agent emptied), then each file's blob with its exec bit.
 */
export function carryRows(
  gitDir: string,
  rows: readonly TouchedRow[],
  dest: string,
): void {
  rows.forEach((row) => {
    rmSync(join(dest, row.path), { recursive: true, force: true });
  });
  rows.forEach((row) => {
    writeRow(gitDir, row, dest);
  });
}

function writeRow(gitDir: string, row: TouchedRow, dest: string): void {
  if (row.entry.kind !== "file") return;
  const full = join(dest, row.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    gitBytes(dest, [`--git-dir=${gitDir}`, "cat-file", "blob", row.entry.blob]),
  );
  chmodSync(full, row.entry.mode === "100755" ? 0o755 : 0o644);
}

/**
 * Run `argv` in `cwd` as a scoring process: its own process group, a fresh
 * HOME removed after it, only `PATH`, the locale, `TERM`, `HOME`/`TMPDIR`
 * and `CI=1` in its env.
 */
export function runScoring(
  argv: readonly string[],
  at: { readonly cwd: string; readonly timeoutMs: number },
): Promise<ScoringRun> {
  const home = makeTmpDir("scoring-home");
  return spawnScoring(argv, { ...at, home }).finally(() => {
    rmSync(home, { recursive: true, force: true });
  });
}

function spawnScoring(
  argv: readonly string[],
  at: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly home: string;
  },
): Promise<ScoringRun> {
  const { pid, exited } = start(argv, at);
  return Promise.race([exited, lateOf(pid, exited, at.timeoutMs)]).finally(
    () => {
      killGroup(pid);
    },
  );
}

/**
 * Start the process as the leader of its own group. How it ended: its exit
 * code, the signal that killed it, or that it never started.
 */
function start(
  argv: readonly string[],
  at: { readonly cwd: string; readonly home: string },
): { readonly pid: number | undefined; readonly exited: Promise<ScoringRun> } {
  const [command = "", ...args] = argv;
  const env = { ...scrubbedRunEnv(process.env, { home: at.home }), CI: "1" };
  const child = spawn(command, args, {
    cwd: at.cwd,
    env,
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise<ScoringRun>((resolve) => {
    child.on("error", (e) => {
      resolve({ kind: "not-started", detail: e.message });
    });
    child.on("exit", (code, signal) => {
      resolve(endOf(code, signal));
    });
  });
  return { pid: child.pid, exited };
}

/** How an exited process ended: Node sets exactly one of the two. */
function endOf(code: number | null, signal: string | null): ScoringRun {
  if (code !== null) return { kind: "exited", code };
  // Node sets the signal whenever the code is null.
  return { kind: "signalled", signal: String(signal) };
}

/** Resolves at the timeout, after killing the group; never once the process exited first. */
function lateOf(
  pid: number | undefined,
  exited: Promise<ScoringRun>,
  ms: number,
): Promise<ScoringRun> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killGroup(pid);
      resolve({ kind: "timed-out", ms });
    }, ms);
    void exited.finally(() => {
      clearTimeout(timer);
    });
  });
}

/** SIGKILL the whole process group of `pid`; a group already gone is fine. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: every process of the group has exited.
  }
}

/** The host adapter of core's `RegressionCaseHost` port. */
export const regressionCaseHost: RegressionCaseHost = {
  carryRows,
  linksOutsideTree: escapingLinks,
  runScoring,
};
