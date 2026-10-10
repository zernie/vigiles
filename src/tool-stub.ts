/**
 * vigiles — tool stubs on PATH: the EFFECTS half (rung R2 of the eval coverage
 * model). The rules, the decision and the log format are pure, in
 * `core/stub-rules.ts`; this file writes them to disk and reads the log back.
 *
 * Layout of one stub root — a temp dir BESIDE the run's working dir, never in
 * it, so the agent does not find vigiles plumbing in its project (models did
 * `ls`/`cat` a stub dir that lived inside the work dir):
 *
 *   <root>/bin/<name>          a two-line sh shim, first on the run's PATH
 *   <root>/rules/<name>.json   the encoded rules (`encodeStub`)
 *   <root>/calls.jsonl         one line per invocation, every stub of the run
 *
 * The shim execs `node <vigiles cli.js> hook-runtime stub <root> <name> "$@"`,
 * a fast path in the dispatcher that loads only the pure decision — the same
 * shape as the intercept hook, which also calls back into the CLI by absolute
 * path because `npx vigiles` does not resolve from a throwaway dir.
 *
 * The canned answers are author/recorded fixtures, NEVER model-synthesized: a
 * synthesized `gh` output looks plausible and diverges from the real tool.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import {
  encodeStub,
  parseStubLog,
  stubPaths,
  type StubCall,
  type ToolStub,
} from "./core/stub-rules.js";
import { makeTmpDir } from "./core/tmp-root.js";

/** Where a run's stubs live. `binDir` goes first on the run's PATH. */
export interface StubDir {
  readonly root: string;
  readonly binDir: string;
}

/** How a shim reaches the stub runtime: this node, and this vigiles' `cli.js`. */
export interface StubLauncher {
  readonly node: string;
  readonly cli: string;
}

/** A POSIX single-quoted word: the only quoting `sh` never re-reads. */
const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** The shim for one stub. Pure. */
export function stubShim(
  launcher: StubLauncher,
  root: string,
  name: string,
): string {
  const words = [
    launcher.node,
    launcher.cli,
    "hook-runtime",
    "stub",
    root,
    name,
  ];
  return `#!/bin/sh\nexec ${words.map(shQuote).join(" ")} "$@"\n`;
}

/**
 * Write a fresh stub root for `stubs`: a shim and a rules file per stub. The
 * stubs must already be parsed (the spec boundary did it). Remove it with
 * {@link removeStubDir}.
 */
export function writeStubDir(
  stubs: readonly ToolStub[],
  launcher: StubLauncher,
): StubDir {
  const root = makeTmpDir("stubs");
  const { binDir, rulesDir } = stubPaths(root);
  mkdirSync(binDir, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });
  stubs.forEach((stub) => {
    const paths = stubPaths(root, stub.name);
    writeFileSync(paths.rules, encodeStub(stub), "utf8");
    writeFileSync(paths.bin, stubShim(launcher, root, stub.name), "utf8");
    chmodSync(paths.bin, 0o755);
  });
  return { root, binDir };
}

/** Every invocation the run's stubs recorded, in order. Empty when none was called. */
export function readStubCalls(dir: StubDir): readonly StubCall[] {
  const { log } = stubPaths(dir.root);
  return existsSync(log) ? parseStubLog(readFileSync(log, "utf8")) : [];
}

/** Remove a stub root. Safe on one already gone. */
export function removeStubDir(dir: StubDir): void {
  rmSync(dir.root, { recursive: true, force: true });
}
