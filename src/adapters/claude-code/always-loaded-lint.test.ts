/**
 * The context-creep ratchet over the always-loaded context, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model): the migration a Claude Code repo
 * goes through. A version-1 baseline gets a note and exit 0; recording writes
 * version 2 with the parts; growth in a part is then a finding. The Codex twin
 * is `src/adapters/codex/always-loaded-lint.test.ts`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INSTRUCTION_BASELINE_FILE as BASELINE,
  LEGACY_INSTRUCTION_BASELINE_FILE,
  REMOVE_LEGACY_BASELINE_COMMAND,
  RENAME_BASELINE_COMMAND,
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
  dir = makeTmpDir("always-loaded-lint-cc");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { "claude-code": {} } }));
  put("CLAUDE.md", "x".repeat(300));
  put(".claude/settings.json", '{"outputStyle":"Terse"}');
  put(".claude/output-styles/Terse.md", "Answer in one line.");
  put(SKILL, "---\nname: review\ndescription: Review a diff\n---\nbody");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("the ratchet over the Claude Code always-loaded context", () => {
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
    expect(r.out).toContain("always-loaded context grew 342 → 353 chars (+11)");
    expect(r.out).toContain(`${SKILL} (skill listing) +11`);
  });
});

/** The pre-rename spelling of the baseline: still read, never written. */
const LEGACY = LEGACY_INSTRUCTION_BASELINE_FILE;

/** Move the freshly recorded baseline to where a repo recorded before the rename has it. */
function recordAtLegacyPath(): void {
  expect(run(["lint", "--update-baseline"]).code).toBe(0);
  renameSync(join(dir, BASELINE), join(dir, LEGACY));
}

describe("the baseline file's old name on Claude Code", () => {
  it("new file only: read, and no note anywhere", () => {
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    const lint = run(["lint"]);
    expect(lint.code).toBe(0);
    expect(lint.out).toContain("held at");
    expect(lint.out).not.toContain(LEGACY);
    const summary = run(["lint", "--summary"]).out.trimEnd().split("\n");
    expect(summary).toHaveLength(1);
    expect(summary[0]).not.toContain(BASELINE);
  });

  it("old file only: still read (growth still fails), with a note carrying the git mv", () => {
    recordAtLegacyPath();
    const held = run(["lint"]);
    expect(held.code).toBe(0);
    expect(held.out).toContain("held at");
    expect(held.out).toContain(`\`${RENAME_BASELINE_COMMAND}\``);

    put("CLAUDE.md", "x".repeat(400));
    const grown = run(["lint"]);
    expect(grown.code).not.toBe(0);
    expect(grown.out).toContain("grew");
  });

  it("old file only: `lint --summary` adds exactly one line, with the git mv", () => {
    recordAtLegacyPath();
    const summary = run(["lint", "--summary"]);
    expect(summary.code).toBe(0);
    const lines = summary.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("note");
    expect(lines[1]).toContain(RENAME_BASELINE_COMMAND);
    expect(RENAME_BASELINE_COMMAND).toBe(`git mv ${LEGACY} ${BASELINE}`);
  });

  it("both files: the new one is read, the old one is called stale with its git rm", () => {
    recordAtLegacyPath();
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    // The stale copy records a smaller total: read, it would fail the run.
    put(
      LEGACY,
      readFileSync(join(dir, BASELINE), "utf-8").replace(
        /"total": \d+,\n(\s+)"files"/,
        '"total": 1,\n$1"files"',
      ),
    );
    const lint = run(["lint"]);
    expect(lint.code).toBe(0);
    expect(lint.out).toContain("held at");
    expect(lint.out).toContain(`\`${REMOVE_LEGACY_BASELINE_COMMAND}\``);
    const summary = run(["lint", "--summary"]).out.trimEnd().split("\n");
    expect(summary).toHaveLength(2);
    expect(summary[1]).toContain(REMOVE_LEGACY_BASELINE_COMMAND);
    expect(REMOVE_LEGACY_BASELINE_COMMAND).toBe(`git rm ${LEGACY}`);
  });
});

describe("the baseline file's old name on Claude Code, neither file or an update", () => {
  it("neither file: nothing is read and nothing is mentioned", () => {
    const lint = run(["lint"]);
    expect(lint.code).toBe(0);
    expect(lint.out).not.toContain(LEGACY);
    expect(existsSync(join(dir, BASELINE))).toBe(false);
    expect(existsSync(join(dir, LEGACY))).toBe(false);
    expect(run(["lint", "--summary"]).out.trimEnd().split("\n")).toHaveLength(
      1,
    );
  });

  it("--update-baseline writes only the new path and leaves the old one for the author to remove", () => {
    recordAtLegacyPath();
    const oldBytes = readFileSync(join(dir, LEGACY), "utf-8");
    put("CLAUDE.md", "x".repeat(400));
    const r = run(["lint", "--update-baseline"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, BASELINE))).toBe(true);
    expect(readFileSync(join(dir, LEGACY), "utf-8")).toBe(oldBytes);
    expect(r.out).toContain(`\`${REMOVE_LEGACY_BASELINE_COMMAND}\``);
  });
});
