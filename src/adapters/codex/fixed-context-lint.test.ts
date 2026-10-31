/**
 * The instruction-weight ratchet over the fixed context, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model): the migration a Codex repo
 * goes through, in BYTES and with no output styles: recording writes version 2
 * carrying the skill listing only, and a version-2 file then gates the sum.
 * The Claude Code twin is `src/adapters/claude-code/fixed-context-lint.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INSTRUCTION_BASELINE_FILE as BASELINE,
  parseInstructionBaseline,
  type InstructionBaseline,
} from "../../core/instruction-baseline.js";
import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";

const CLI = resolve(__dirname, "..", "..", "..", "dist", "cli.js");
const SKILL = ".agents/skills/review/SKILL.md";

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

/** The committed baseline, parsed by the reader `lint` itself uses. */
function written(): InstructionBaseline {
  const parsed = parseInstructionBaseline(
    readFileSync(join(dir, BASELINE), "utf-8"),
  );
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return parsed.baseline;
}

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

beforeEach(() => {
  dir = makeTmpDir("fixed-context-lint-codex");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { codex: {} } }));
  put("AGENTS.md", "x".repeat(300));
  put(SKILL, "---\nname: review\ndescription: Prüft\n---\nbody");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

// "- review: Prüft (file: .agents/skills/review/SKILL.md)": 54 chars, 55 bytes.
const ENTRY_BYTES = 55;

describe("the ratchet over the Codex fixed context", () => {
  it("records the listing in bytes, no output-style part, version 2", () => {
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    const baseline = written();
    expect(baseline.version).toBe(2);
    expect(baseline.bundles["."]?.unit).toBe("bytes");
    expect(Object.keys(baseline.bundles["."]?.parts ?? {})).toEqual([
      "skill-listing",
    ]);
    expect(baseline.bundles["."]?.parts?.["skill-listing"]?.total).toBe(
      ENTRY_BYTES,
    );
  });

  it("nets out text moved from AGENTS.md into the skill description", () => {
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    put("AGENTS.md", "x".repeat(290));
    put(SKILL, "---\nname: review\ndescription: Prüft 123456789\n---\nbody");
    const r = run(["lint"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `fixed context held at ${String(300 + ENTRY_BYTES)} bytes`,
    );
    expect(r.out).toContain("instructions 290 (-10) · skill listing 65 (+10)");
  });
});
