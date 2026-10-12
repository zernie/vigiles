/**
 * The `lint` output contract, from four adopter reports (#181, #182, #183, #185).
 *
 * They arrived as separate issues and share one root: what `lint` REPORTS could
 * not be trusted as a complete, tierable, machine-readable account of the run.
 * Nested bundles were scored by nobody and announced by nobody; two findings fed
 * the exit code with no rule id to address them; the log and the JSON gave
 * different totals with nothing explaining the gap; and getting both artefacts
 * meant scanning the repo twice.
 *
 * 🔴 EVERY CASE HAS BOTH HALVES — it fires on the defect AND stays silent next
 * door. A reporting gate whose success looks like silence cannot be noticed
 * broken.
 *
 * Driven through the REAL built CLI: every one of these is about what the
 * command PRINTS, WRITES or RETURNS, which no unit test of the detectors sees.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir, humanCliEnv } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

let dir: string;

function run(args: string[], cwd = dir): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: humanCliEnv(process.env),
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

/** A skill whose description is deliberately over the 500-char budget. */
function skill(root: string, name: string, long: boolean): void {
  const d = join(root, "skills", name);
  mkdirSync(d, { recursive: true });
  const desc = long
    ? "Use this when you need to do the thing and also the other thing in a very specific situation. ".repeat(
        7,
      )
    : "Short and fine.";
  writeFileSync(
    join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody.\n`,
  );
}

/** A nested plugin bundle with its own manifest and skills. */
function bundle(root: string, name: string, long: boolean): void {
  const b = join(root, "plugins", name);
  mkdirSync(join(b, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(b, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.0.0" }),
  );
  skill(b, `${name}-skill`, long);
}

beforeEach(() => {
  dir = makeTmpDir();
  writeFileSync(
    join(dir, ".vigilesrc.json"),
    JSON.stringify({ rules: { "skill-description-budget": "warn" } }),
  );
});
afterEach(() => {
  cleanupTmpDir(dir);
});

// --- #185: nested bundles ------------------------------------------------

test("nested bundles are ANNOUNCED when they are not scored (#185)", () => {
  // The defect was silence, not scope: the counters looked complete while whole
  // surfaces were never read, so a repo reads green-with-N while more skills
  // carry the same defect.
  skill(dir, "root-a", true);
  bundle(dir, "alpha", true);

  const r = run(["lint", "."]);
  assert.match(r.out, /nested bundle\(s\) discovered but NOT scored/);
  assert.match(r.out, /plugins\/alpha/);
});

test("--bundles=all scores them, and the count reaches ground truth", () => {
  skill(dir, "root-a", true);
  skill(dir, "root-b", true);
  bundle(dir, "alpha", true);
  bundle(dir, "beta", true);

  const rootOnly = (run(["lint", "."]).out.match(/budget 500/g) ?? []).length;
  const all = (
    run(["lint", ".", "--bundles=all"]).out.match(/budget 500/g) ?? []
  ).length;

  assert.equal(rootOnly, 2, "root run sees only the root bundle's skills");
  assert.equal(all, 4, "every over-budget skill in the repo is scored");
});

test("a repo with NO nested bundle says nothing about bundles", () => {
  // The other half: the announcement must not become permanent noise on the
  // ordinary single-bundle repo, which is most of them.
  skill(dir, "root-a", true);
  const r = run(["lint", "."]);
  assert.equal(r.out.includes("nested bundle"), false);
});

// --- #181: tierable orphan / duplicate findings ---------------------------

test("orphan-docs honours its severity instead of always exiting 1 (#181)", () => {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "orphan.md"),
    "# Orphan\n\nNothing links here.\n",
  );
  skill(dir, "demo", false);

  const cfg = (rules: Record<string, unknown>): void => {
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({ orphans: { include: ["docs/**/*.md"] }, rules }),
    );
  };

  cfg({ "orphan-docs": "error" });
  assert.equal(run(["lint", "."]).code, 1, "error still blocks");

  cfg({ "orphan-docs": "warn" });
  const warned = run(["lint", "."]);
  assert.equal(warned.code, 0, "warn reports without failing the build");
  assert.match(warned.out, /orphan/i, "…and it is still REPORTED, not hidden");

  cfg({ "orphan-docs": false });
  assert.equal(run(["lint", "."]).code, 0, "off skips the check");
});

// --- #183: one total, and the JSON agrees --------------------------------

test("the run ends with a total, and --json carries the same numbers (#183)", () => {
  skill(dir, "root-a", true);
  skill(dir, "root-b", true);

  const human = run(["lint", "."]);
  const m = /(\d+) finding\(s\): (\d+) error, (\d+) warning/.exec(human.out);
  assert.ok(m, "the human-readable run states a total");

  const parsed = JSON.parse(run(["lint", ".", "--json"]).out) as {
    totals: { findings: number; errors: number; warnings: number };
  };
  assert.equal(
    Number(m[1]),
    parsed.totals.findings,
    "the log and the JSON cannot disagree — they read one computed total",
  );
  assert.equal(Number(m[2]), parsed.totals.errors);
  assert.equal(Number(m[3]), parsed.totals.warnings);
});

test("the total counts findings, not output lines", () => {
  // The gap that made two right numbers look wrong: some checks print one line
  // per finding, others one line carrying a count. 19 + 34 + 35 findings showed
  // as 21 `⚠` lines on the reporter's repo.
  skill(dir, "a", true);
  skill(dir, "b", true);
  skill(dir, "c", true);
  const out = run(["lint", "."]).out;
  const warnLines = (out.match(/⚠/g) ?? []).length;
  const total = Number(/(\d+) finding\(s\)/.exec(out)?.[1] ?? "0");
  assert.ok(total > 0);
  assert.notEqual(
    total,
    warnLines,
    "if these ever match by construction the test proves nothing — the point is that the total is computed, not counted",
  );
});

// --- #182: one pass, both artefacts --------------------------------------

test("--json-out writes JSON while stdout stays human-readable (#182)", () => {
  skill(dir, "root-a", true);
  const dest = join(dir, "out", "lint.json");

  const r = run(["lint", ".", `--json-out=${dest}`]);

  assert.match(r.out, /finding\(s\)/, "stdout is still the human-readable run");
  assert.equal(existsSync(dest), true, "and the JSON landed on disk");
  const parsed = JSON.parse(readFileSync(dest, "utf-8")) as {
    totals: { findings: number };
  };
  assert.ok(parsed.totals.findings > 0, "the file is the real report");
});

test("--json still replaces stdout, unchanged", () => {
  // The new flag must not alter the old one's contract.
  skill(dir, "root-a", true);
  const out = run(["lint", ".", "--json"]).out;
  assert.doesNotMatch(out, /finding\(s\):/);
  JSON.parse(out); // throws if stdout is not pure JSON
});

// --- #173 (residual): a committed artifact whose refs went dead -----------

test("lint catches a committed artifact whose spec refs died (#173 residual)", () => {
  // The half deleting the write-on-error did not close. An artifact committed
  // while its refs were live stays hash-valid forever; delete the target and
  // `compile` errors while `lint` said "✓ hash valid — All compiled files
  // intact" and exited 0. A hash is an integrity claim, not a reference claim.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "f", version: "0.0.0", scripts: {} }),
  );
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n");
  const specEntry = resolve(__dirname, "..", "dist", "core", "spec.js");
  writeFileSync(
    join(dir, "CLAUDE.md.spec.ts"),
    `import { instructionFile, file } from ${JSON.stringify(specEntry)};\n` +
      `export default instructionFile({\n` +
      `  sections: { Overview: \`x\`, Routing: [file("docs/guide.md")] },\n` +
      `  rules: {},\n` +
      `});\n`,
  );

  assert.equal(run(["compile", "CLAUDE.md.spec.ts"]).code, 0, "compiles clean");
  assert.equal(
    run(["lint", "."]).code,
    0,
    "and lints clean while the ref lives",
  );

  // The reference dies AFTER the artifact was committed.
  rmSync(join(dir, "docs", "guide.md"));

  const after = run(["lint", "."]);
  assert.equal(after.code, 2, "a dead ref fails the gate");
  assert.match(after.out, /docs\/guide\.md/, "…and names the reference");
});

test("spec-refs is tierable, and silent when every ref is alive", () => {
  // Both halves: it must not fire on a healthy repo, and `warn` must report
  // without failing — the property #181 was filed about, applied to a new rule
  // so it does not repeat the untierable mistake.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "f", version: "0.0.0", scripts: {} }),
  );
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n");
  const specEntry = resolve(__dirname, "..", "dist", "core", "spec.js");
  writeFileSync(
    join(dir, "CLAUDE.md.spec.ts"),
    `import { instructionFile, file } from ${JSON.stringify(specEntry)};\n` +
      `export default instructionFile({\n` +
      `  sections: { Overview: \`x\`, Routing: [file("docs/guide.md")] },\n` +
      `  rules: {},\n` +
      `});\n`,
  );
  run(["compile", "CLAUDE.md.spec.ts"]);

  const healthy = run(["lint", "."]);
  assert.equal(healthy.code, 0);
  assert.equal(healthy.out.includes("Spec reference check"), false);

  rmSync(join(dir, "docs", "guide.md"));
  writeFileSync(
    join(dir, ".vigilesrc.json"),
    JSON.stringify({ rules: { "spec-refs": "warn" } }),
  );
  const warned = run(["lint", "."]);
  assert.equal(warned.code, 0, "warn does not fail the build");
  assert.match(warned.out, /guide\.md/, "…but still reports");
});
