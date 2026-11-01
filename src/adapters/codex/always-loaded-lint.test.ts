/**
 * The context-creep ratchet over the always-loaded context, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model): the migration a Codex repo
 * goes through, in BYTES and with no output styles: recording writes version 2
 * carrying the skill listing only, and a version-2 file then gates the sum.
 * The Claude Code twin is `src/adapters/claude-code/always-loaded-lint.test.ts`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
  dir = makeTmpDir("always-loaded-lint-codex");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { codex: {} } }));
  put("AGENTS.md", "x".repeat(300));
  put(SKILL, "---\nname: review\ndescription: Prüft\n---\nbody");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

// "- review: Prüft (file: .agents/skills/review/SKILL.md)": 54 chars, 55 bytes.
const ENTRY_BYTES = 55;

describe("the ratchet over the Codex always-loaded context", () => {
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
      `always-loaded context held at ${String(300 + ENTRY_BYTES)} bytes`,
    );
    expect(r.out).toContain("instructions 290 (-10) · skill listing 65 (+10)");
  });

  it("a version-2 baseline stays version 2 when the listing drops to zero, so a re-added skill still fails", () => {
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    rmSync(join(dir, SKILL));
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    const cut = written();
    expect(cut.version).toBe(2);
    expect(cut.bundles["."]?.parts).toBeUndefined();

    put(SKILL, "---\nname: review\ndescription: Prüft\n---\nbody");
    const r = run(["lint"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(
      `always-loaded context grew 300 → ${String(300 + ENTRY_BYTES)} bytes (+${String(ENTRY_BYTES)})`,
    );
  });
});

/** The pre-rename spelling of the baseline: still read, never written. */
const LEGACY = LEGACY_INSTRUCTION_BASELINE_FILE;

/** Move the freshly recorded baseline to where a repo recorded before the rename has it. */
function recordAtLegacyPath(): void {
  expect(run(["lint", "--update-baseline"]).code).toBe(0);
  renameSync(join(dir, BASELINE), join(dir, LEGACY));
}

describe("the baseline file's old name on Codex", () => {
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

    put("AGENTS.md", "x".repeat(400));
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

describe("the baseline file's old name on Codex, neither file or an update", () => {
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
    put("AGENTS.md", "x".repeat(400));
    const r = run(["lint", "--update-baseline"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, BASELINE))).toBe(true);
    expect(readFileSync(join(dir, LEGACY), "utf-8")).toBe(oldBytes);
    expect(r.out).toContain(`\`${REMOVE_LEGACY_BASELINE_COMMAND}\``);
  });
});
