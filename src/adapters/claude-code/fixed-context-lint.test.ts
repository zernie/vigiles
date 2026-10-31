/**
 * The instruction-weight ratchet over the fixed context, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model): the migration a Claude Code repo
 * goes through. A version-1 baseline gets a note and exit 0; recording writes
 * version 2 with the parts; growth in a part is then a finding. The Codex twin
 * is `src/adapters/codex/fixed-context-lint.test.ts`.
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
const SKILL = ".claude/skills/review/SKILL.md";

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
  dir = makeTmpDir("fixed-context-lint-cc");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { "claude-code": {} } }));
  put("CLAUDE.md", "x".repeat(300));
  put(".claude/settings.json", '{"outputStyle":"Terse"}');
  put(".claude/output-styles/Terse.md", "Answer in one line.");
  put(SKILL, "---\nname: review\ndescription: Review a diff\n---\nbody");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("the ratchet over the Claude Code fixed context", () => {
  it("a version-1 baseline gets a NOTE for the new parts, never a finding", () => {
    put(
      BASELINE,
      JSON.stringify({
        version: 1,
        bundles: {
          ".": {
            unit: "chars",
            measure: 1,
            total: 300,
            files: { "CLAUDE.md": 300 },
          },
        },
      }),
    );
    const r = run(["lint"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ always-loaded instructions held at 300 chars");
    expect(r.out).toContain(
      "ℹ output style (19 chars) and skill listing (23 chars) load at session start",
    );
  });

  it("recording writes version 2 with the parts; a grown part is then a finding", () => {
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    const baseline = written();
    expect(baseline.version).toBe(2);
    expect(baseline.bundles["."]?.parts?.["output-style"]?.total).toBe(19);
    expect(baseline.bundles["."]?.parts?.["skill-listing"]?.total).toBe(23);

    put(
      SKILL,
      "---\nname: review\ndescription: Review a diff, then more\n---\nbody",
    );
    const r = run(["lint"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("fixed context grew 342 → 353 chars (+11)");
    expect(r.out).toContain(`${SKILL} (skill listing) +11`);
  });
});
