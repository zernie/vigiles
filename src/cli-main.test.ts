/**
 * `run(argv)`, the in-process entry of the CLI (#607), keeps the two endings a
 * spawned CLI has apart, and leaves the process it runs in as it found it.
 *
 * "stopped" is the old `process.exit`: nothing after it ran. "finished" is a verb
 * that returned, maybe with `process.exitCode` set. The bin exits on "stopped",
 * so if the two were one, a verb that used to stop would keep its event loop
 * alive and hang. Each in-process case is checked against a real spawn of the
 * built bin, so the in-process result cannot drift from what a user gets.
 */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { runCliInProcess } from "./host/cli-in-process.io.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BIN = resolve(REPO_ROOT, "dist", "cli.js");

const spawnedExit = (argv: readonly string[], cwd: string): number | null =>
  spawnSync("node", [BIN, ...argv], { cwd, encoding: "utf-8" }).status;

describe("run(argv) ends the way the spawned bin does", () => {
  test("a verb that stops (unknown command) is `stopped` with exit 2", async () => {
    const r = await runCliInProcess(["no-such-verb"]);
    // Guards: a stop is reported as a stop, so the bin still exits on it.
    expect([r.end, r.exitCode]).toEqual(["stopped", 2]);
    expect(spawnedExit(["no-such-verb"], REPO_ROOT)).toBe(2);
  });

  test("a verb that returns with `process.exitCode` set is `finished` with that code", async () => {
    const dir = makeTmpDir();
    try {
      const r = await runCliInProcess(["eject", "missing.md"], { cwd: dir });
      // Guards: a code left in `process.exitCode` is read, not lost as 0.
      expect([r.end, r.exitCode]).toEqual(["finished", 1]);
      expect(spawnedExit(["eject", "missing.md"], dir)).toBe(1);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("a verb that returns cleanly is `finished` with exit 0", async () => {
    const r = await runCliInProcess(["--version"]);
    expect([r.end, r.exitCode]).toEqual(["finished", 0]);
  });

  test("a thrown error reads as the bin's `✗ <message>` and exit 2", async () => {
    const r = await runCliInProcess(["audit", ".", "--harness=bogus"], {
      cwd: REPO_ROOT,
    });
    expect([r.end, r.exitCode]).toEqual(["threw", 2]);
    expect(r.stderr.startsWith("✗ ")).toBe(true);
    expect(spawnedExit(["audit", ".", "--harness=bogus"], REPO_ROOT)).toBe(2);
  });
});

describe("run(argv) leaves the process as it found it", () => {
  test("the exit code is restored", async () => {
    const dir = makeTmpDir();
    const cwd = process.cwd();
    const exitCode = process.exitCode;
    try {
      process.chdir(dir);
      process.exitCode = 0;
      // `eject` sets `process.exitCode = 1`; it may not leak out of the run.
      await runCliInProcess(["eject", "missing.md"]);
      // Guards: a test process is not marked failed by a CLI run inside it.
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = exitCode;
      process.chdir(cwd);
      cleanupTmpDir(dir);
    }
  });
});
