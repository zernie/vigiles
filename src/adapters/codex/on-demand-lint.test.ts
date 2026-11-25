/**
 * A folder's own `AGENTS.md` on a Codex repository, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model). Codex has no on-demand load: it
 * builds its chain once, from the repository root to the folder it starts in,
 * and cuts the SUM at `project_doc_max_bytes`. That chain is not modelled yet,
 * so the per-file on-demand check must not fire here, and `audit` must say the
 * check is not modelled rather than read as "nothing over". The Claude Code
 * twin is `src/adapters/claude-code/on-demand-lint.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { codexDialect } from "./dialect.js";

const CLI = resolve(import.meta.dirname, "..", "..", "..", "dist", "cli.js");

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

beforeEach(() => {
  dir = makeTmpDir("on-demand-lint-codex");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { codex: {} } }));
  put("AGENTS.md", "# Project\n\nUse the npm scripts in package.json.\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("a folder's AGENTS.md under Codex", () => {
  it("the dialect declares no on-demand cut", () => {
    // Guards: the cases below test "not modelled", which holds only while this is unset.
    expect(codexDialect.onDemandFileLimit).toBeUndefined();
  });

  it("a large folder file is no on-demand finding", () => {
    put("pkg/AGENTS.md", `# Folder\n\n${"x".repeat(60_000)}`);
    const r = run(["lint"]);
    // Guards: a harness without the cut gets no finding invented from another's number.
    expect(
      r.out.split("\n").filter((l) => l.includes("pkg/AGENTS.md is")),
    ).toEqual([]);
  });

  it("lint says the check is n/a rather than passing it silently", () => {
    put("pkg/AGENTS.md", "# Folder\n");
    const r = run(["lint"]);
    // Guards: no-silent-skips — an unmodelled cut prints n/a, not nothing.
    expect(r.out).toMatch(/On-demand truncation[^\n]*\n\s*– n\/a/);
  });

  it("audit says the check is not modelled", () => {
    put("pkg/AGENTS.md", "# Folder\n");
    const r = run(["audit"]);
    // Guards: an unmodelled check reads as unmodelled, never as a clean result.
    expect(r.out).toMatch(/on-demand files: not modelled/);
  });
});
