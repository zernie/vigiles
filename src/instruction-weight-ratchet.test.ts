/**
 * The instruction-weight ratchet through the REAL built CLI — what `lint` prints,
 * what exit code it returns, and what it writes (only under `--update-baseline`).
 *
 * The comparison itself is unit-tested in `core/instruction-baseline.test.ts`;
 * this file is about the contract a CI step relies on: a fresh repo passes and
 * writes nothing, growth fails, a cut must be locked in, and the sum — not the
 * root file — is what is held.
 */
import { test, beforeEach, afterEach, expect } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { MOVE_OUT_OF_ALWAYS_LOADED } from "./core/instruction-remedies.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { compileWeightLine } from "./instruction-weight-ratchet.js";
import { measureInstructionWeight } from "./scan.js";
import { claudeCodeAdapter } from "./adapters/claude-code/adapter.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
const BASELINE = ".vigiles/instruction-weight.json";
const BODY = "x".repeat(30_000);
/** The harness pin every test starts from; `withMax` adds rules on top of it. */
const PINNED = { harnesses: { "claude-code": {} } };

let dir: string;

function run(args: string[]): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

function put(rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function recordedTotal(): number {
  const b = JSON.parse(readFileSync(join(dir, BASELINE), "utf-8")) as {
    bundles: Record<string, { total: number }>;
  };
  return b.bundles["."]?.total ?? -1;
}

beforeEach(() => {
  dir = makeTmpDir();
  // Pin the harness: the tmp dir has no `.claude/`, and the ratchet must not
  // depend on what auto-detection picks.
  put(".vigilesrc.json", JSON.stringify(PINNED));
  put("CLAUDE.md", BODY);
});
afterEach(() => {
  cleanupTmpDir(dir);
});

test("no baseline: lint passes, says how to start, and writes NOTHING", () => {
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no instruction-weight baseline recorded \(30,000 chars/);
  assert.match(r.out, /vigiles lint --update-baseline/);
  assert.equal(existsSync(join(dir, BASELINE)), false, "a read never writes");
});

test("--update-baseline records it; the next lint holds", () => {
  const rec = run(["lint", "--update-baseline"]);
  assert.equal(rec.code, 0, rec.out);
  assert.equal(recordedTotal(), 30_000);
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /held at 30,000 chars/);
});

test("growth fails, naming the delta and the file", () => {
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", `${BODY}${"y".repeat(1_225)}`);
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /grew 30,000 → 31,225 chars \(\+1,225\)/);
  assert.match(r.out, /CLAUDE\.md \+1,225/);
  assert.equal(recordedTotal(), 30_000, "lint never moves the baseline itself");
});

test("growth hidden in an always-loaded rules file fails too", () => {
  run(["lint", "--update-baseline"]);
  put(".claude/rules/extra.md", "z".repeat(800));
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.claude\/rules\/extra\.md \+800 \(new\)/);
});

test("moving text from the root into .claude/rules does NOT count as a cut", () => {
  // The original evasion: per file the root lost two thirds, the request
  // carries exactly as much.
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", BODY.slice(0, 10_000));
  put(".claude/rules/engineering.md", BODY.slice(10_000));
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /held at 30,000 chars/);
});

test("a file excluded by committed claudeMdExcludes does not count", () => {
  run(["lint", "--update-baseline"]);
  put(".claude/rules/vendor.md", "v".repeat(5_000));
  put(
    ".claude/settings.json",
    JSON.stringify({ claudeMdExcludes: ["**/vendor.md"] }),
  );
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /held at 30,000 chars/);
});

test("a shrink must be locked in; --update-baseline lowers the recorded value", () => {
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", BODY.slice(0, 20_000));
  const stale = run(["lint"]);
  assert.equal(stale.code, 2, stale.out);
  assert.match(stale.out, /shrank 30,000 → 20,000 chars \(-10,000\)/);

  const lower = run(["lint", "--update-baseline"]);
  assert.equal(lower.code, 0, lower.out);
  assert.equal(recordedTotal(), 20_000);
  assert.equal(run(["lint"]).code, 0);
});

test('"warn" reports growth without touching the exit code', () => {
  put(
    ".vigilesrc.json",
    JSON.stringify({
      harnesses: { "claude-code": {} },
      rules: { "instruction-weight": "warn" },
    }),
  );
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", `${BODY}y`);
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚠ always-loaded instructions grew/);
});

test("off: growth past the baseline is not reported", () => {
  put(
    ".vigilesrc.json",
    JSON.stringify({
      harnesses: { "claude-code": {} },
      rules: { "instruction-weight": "off" },
    }),
  );
  put(BASELINE, JSON.stringify({ version: 1, bundles: {} }));
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Instruction-weight ratchet/);
});

test("an unreadable baseline is a finding, never read as empty", () => {
  put(BASELINE, "{ not json");
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cannot be read \(not valid JSON\)/);
});

test("--json carries the counters", () => {
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", `${BODY}y`);
  const r = run(["lint", "--json"]);
  const report = JSON.parse(r.out) as Record<string, number>;
  expect(report.instructionWeightErrors).toBe(1);
});

test("compile's line reads the weight against the recorded baseline", () => {
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", BODY.slice(0, 28_210));
  const line = compileWeightLine(
    dir,
    measureInstructionWeight(dir, claudeCodeAdapter),
  );
  expect(line).toBe("always-loaded: 28,210 chars (baseline 30,000, -1,790)");
});

test("once the repo has a baseline file, an UNRECORDED bundle is a finding", () => {
  // Opting in is committing the file; weight that appeared after that — here a
  // root nobody recorded — is weight nobody signed off on.
  put(
    BASELINE,
    JSON.stringify({
      version: 1,
      bundles: {
        "plugins/a": {
          unit: "chars",
          measure: 1,
          total: 1,
          files: { "CLAUDE.md": 1 },
        },
      },
    }),
  );
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no instruction-weight baseline recorded/);
});

test("an `exclude`d always-loaded file still counts — exclude is not claudeMdExcludes", () => {
  // `exclude` means "vigiles does not lint this"; the harness still loads it.
  // Letting it reach the measurement turned 35,000 into a recorded 30,000.
  put(".claude/rules/r.md", "r".repeat(5_000));
  run(["lint", "--update-baseline"]);
  put(
    ".vigilesrc.json",
    JSON.stringify({
      harnesses: { "claude-code": {} },
      exclude: [".claude/rules/**"],
    }),
  );
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /held at 35,000 chars/);
});

test("a CRLF checkout of the same commit holds", () => {
  const lf = Array.from({ length: 1_000 }, (_, i) => `line ${String(i)}`).join(
    "\n",
  );
  put("CLAUDE.md", lf);
  run(["lint", "--update-baseline"]);
  put("CLAUDE.md", lf.replaceAll("\n", "\r\n"));
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /held at/);
});

test("an import the measurement did not follow is said out loud", () => {
  // One hop is read; a second hop is real Claude Code behaviour, so its size
  // is missing from the number, and the line must say so.
  put("CLAUDE.md", `${BODY}\n@a.md\n`);
  put("a.md", "@b.md\n");
  put("b.md", "b".repeat(7_000));
  const r = run(["lint"]);
  assert.match(r.out, /1 import\(s\) not followed: b\.md/);
});

// ---------------------------------------------------------------------------
// The opt-in absolute ceiling: `["error", { "max": N }]`.
//
// The ratchet alone keeps a repo four times over budget green forever; `max`
// is the explicit, opt-in way to say "no further than this, whatever the
// baseline says". Without it nothing above changes.
// ---------------------------------------------------------------------------

function withMax(severity: "error" | "warn", max: unknown): void {
  put(
    ".vigilesrc.json",
    JSON.stringify({
      ...PINNED,
      rules: { "instruction-weight": [severity, { max }] },
    }),
  );
}

test("max: a total over the ceiling is a finding that names total, max, excess and the biggest file", () => {
  withMax("error", 20_000);
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /30,000 chars/);
  assert.match(r.out, /max 20,000/);
  assert.match(r.out, /10,000 over/);
  assert.match(r.out, /CLAUDE\.md 30,000/);
  // The CLI prints the remedy list; its wording is owned by instruction-remedies.test.ts.
  assert.ok(r.out.includes(MOVE_OUT_OF_ALWAYS_LOADED), r.out);
});

test("max: holds independently of the baseline — an over-ceiling repo cannot hide behind a recorded one", () => {
  put(
    BASELINE,
    JSON.stringify({
      version: 1,
      bundles: {
        ".": {
          unit: "chars",
          measure: 1,
          total: 30_000,
          files: { "CLAUDE.md": 30_000 },
        },
      },
    }),
  );
  withMax("error", 20_000);
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /held at 30,000 chars/, "the ratchet itself still holds");
  assert.match(r.out, /10,000 over/, "the ceiling still fails");
});

test("max: the largest files are named heaviest first, imports included", () => {
  // An import is weighed like any always-loaded file and named by its path.
  put("CLAUDE.md", `${BODY}\n@big.md\n`);
  put("big.md", "b".repeat(8_000));
  withMax("error", 20_000);
  const r = run(["lint"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /CLAUDE\.md 30,009, big\.md 8,000/);
});

test("max: at the ceiling, and under it, are silent", () => {
  withMax("error", 30_000);
  const at = run(["lint"]);
  assert.equal(at.code, 0, at.out);
  assert.doesNotMatch(at.out, /\d over/);
  withMax("error", 50_000);
  const under = run(["lint"]);
  assert.equal(under.code, 0, under.out);
  assert.doesNotMatch(under.out, /max 50,000/);
});

test('max with "warn" reports the excess without touching the exit code', () => {
  withMax("warn", 20_000);
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚠ .*10,000 over/);
});

test("no max: a rule given as [severity, {}] behaves like the bare severity", () => {
  put(
    ".vigilesrc.json",
    JSON.stringify({
      ...PINNED,
      rules: { "instruction-weight": ["error", {}] },
    }),
  );
  const r = run(["lint"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no instruction-weight baseline recorded/);
});

test("max: --update-baseline above the ceiling is refused — nothing is written", () => {
  withMax("error", 20_000);
  const r = run(["lint", "--update-baseline"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /refus/i);
  assert.match(r.out, /30,000/);
  assert.match(r.out, /20,000/);
  assert.equal(existsSync(join(dir, BASELINE)), false, "no baseline written");
});

test('max: a refusal still fails under "warn" — re-recording must not bypass the ceiling', () => {
  withMax("warn", 20_000);
  const r = run(["lint", "--update-baseline"]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(existsSync(join(dir, BASELINE)), false);
});

test("max: a refused update leaves an existing baseline byte-identical", () => {
  run(["lint", "--update-baseline"]);
  const before = readFileSync(join(dir, BASELINE), "utf-8");
  put("CLAUDE.md", `${BODY}${"y".repeat(5_000)}`);
  withMax("error", 32_000);
  const r = run(["lint", "--update-baseline"]);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(readFileSync(join(dir, BASELINE), "utf-8"), before);
});

test("max: --update-baseline at or under the ceiling records as usual", () => {
  withMax("error", 30_000);
  const r = run(["lint", "--update-baseline"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(recordedTotal(), 30_000);
});

test.each([0, -1, 1.5, "40000"])(
  "max: %j is not a ceiling — the config is rejected",
  (bad) => {
    withMax("error", bad);
    const r = run(["lint"]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /max/);
  },
);
