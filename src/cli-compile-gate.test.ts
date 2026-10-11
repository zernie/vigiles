/**
 * `compile` must not mint a hash-valid artifact over refs it just called dead
 * (#173) — driven through the REAL built CLI, because the defect is in what the
 * command LEAVES ON DISK, which no unit test of `compileClaude` can observe.
 *
 * The reported repro, verbatim in shape: a spec naming a file and an npm script
 * that do not exist. `compile` printed both errors and exited 1 — and still
 * wrote `CLAUDE.md`, stamped with a valid integrity hash. `lint` verifies that
 * hash, finds it intact, and exits 0. So the command the README calls the CI
 * gate for broken refs went green over breakage that had been printed minutes
 * earlier on the author's own screen.
 *
 * Deterministic, model-free, offline → the free unit tier.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
const SPEC_ENTRY = resolve(__dirname, "..", "dist", "core", "spec.js");

let dir: string;

/** Run the CLI in the fixture, returning exit code + combined output. */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
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

beforeEach(() => {
  dir = makeTmpDir();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate-fixture", version: "0.0.0", scripts: {} }),
  );
});

afterEach(() => {
  cleanupTmpDir(dir);
});

/** A spec whose refs are both dead — one file, one npm script. */
function deadRefSpec(): string {
  return (
    `import { instructionFile, file, cmd } from ${JSON.stringify(SPEC_ENTRY)};\n` +
    `export default instructionFile({\n` +
    `  sections: {\n` +
    `    Overview: \`Gate reproduction.\`,\n` +
    `    Routing: [file("docs/never-existed.md"), cmd("npm run never-existed")],\n` +
    `  },\n` +
    `  rules: {},\n` +
    `});\n`
  );
}

test("compile does NOT write an artifact when refs are dead (#173)", () => {
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), deadRefSpec());

  const compiled = run("compile", "CLAUDE.md.spec.ts");

  assert.notEqual(compiled.code, 0, "a dead ref must fail the compile");
  assert.match(compiled.out, /never-existed/, "the error names the dead ref");
  assert.equal(
    existsSync(join(dir, "CLAUDE.md")),
    false,
    "no artifact: writing one here mints a valid hash over known-dead refs",
  );
});

test("a failed compile leaves the LAST GOOD artifact alone, not a broken one", () => {
  // Why this half matters: "do not write" must not mean "destroy what is there".
  const good =
    `import { instructionFile } from ${JSON.stringify(SPEC_ENTRY)};\n` +
    `export default instructionFile({\n` +
    `  sections: { Overview: \`All refs real.\` },\n` +
    `  rules: {},\n` +
    `});\n`;
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), good);
  assert.equal(run("compile", "CLAUDE.md.spec.ts").code, 0);

  const before = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
  assert.match(before, /All refs real/);

  // Now break the spec and recompile.
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), deadRefSpec());
  assert.notEqual(run("compile", "CLAUDE.md.spec.ts").code, 0);

  assert.equal(
    readFileSync(join(dir, "CLAUDE.md"), "utf-8"),
    before,
    "the previous good artifact must survive a failed compile untouched",
  );

  // 🔴 THIS ASSERTION USED TO SAY `lint` MUST BE GREEN HERE, and that expectation
  // was the hole itself. The surviving artifact IS intact — its hash matches what
  // the spec compiled to — but the spec it came from now names a file that does
  // not exist, so calling the repo clean is exactly the false confidence #173 was
  // filed about. The hash is an integrity claim, not a reference claim.
  //
  // `spec-refs` closes that residue, so a dead reference is reported even though
  // the artifact is untouched. What the surviving-artifact half of this test
  // still pins is the FILE: refusing to write must not mean destroying what is
  // there, which is asserted above by comparing the bytes.
  const linted = run("lint", ".");
  assert.equal(linted.code, 2, "the dead reference is caught, not the file");
  assert.match(linted.out, /never-existed/);
});

test("lint no longer goes green over an artifact compile refused to write", () => {
  // The end-to-end shape of the report: the author compiles, sees the error,
  // gets distracted, commits. CI runs `lint`.
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), deadRefSpec());
  run("compile", "CLAUDE.md.spec.ts");

  const linted = run("lint", ".");
  assert.equal(
    linted.out.includes("hash valid"),
    false,
    "there is no artifact to call intact, so lint cannot report one",
  );
});

// --- the same hole in the SIBLING compilers (found red-teaming #186) --------

test("a SKILL spec with a dead ref writes nothing either", () => {
  // #173 was fixed in `compileClaudeToFile` only. The identical three lines —
  // write, THEN check errors — sat unchanged in the skill, subagent, railway and
  // generator compilers, and all four stamped unconditionally. Worse than the
  // original: `spec-refs` skips non-`claude` specs, so there was no lint-side
  // backstop at all. Reproduced on the built CLI before the fix: a stamped
  // SKILL.md on disk and `lint` reporting `✓ hash valid`, exit 0.
  //
  // Guarding four call sites would have left the fifth writable, so the write
  // takes a `StampedMarkdown` that an erroring compile never mints.
  const specEntry = resolve(__dirname, "..", "dist", "core", "spec.js");
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "demo", "SKILL.md.spec.ts"),
    `import { experimental_skill, file } from ${JSON.stringify(specEntry)};\n` +
      `export default experimental_skill({\n` +
      `  name: "demo",\n` +
      `  description: "A demo skill whose body references a file that is gone.",\n` +
      `  tools: ["Read"],\n` +
      `  body: ["Read the guide: ", file("docs/never-existed.md")],\n` +
      `});\n`,
  );

  const r = run("compile", "skills/demo/SKILL.md.spec.ts");
  assert.notEqual(r.code, 0, "a dead ref fails the compile");
  assert.match(r.out, /never-existed/);
  assert.equal(
    existsSync(join(dir, "skills", "demo", "SKILL.md")),
    false,
    "no stamped artifact: `lint` would have called it hash-valid",
  );
});

test("a CLEAN skill spec still compiles and writes", () => {
  // The other half — refusing to write must not become refusing to work.
  const specEntry = resolve(__dirname, "..", "dist", "core", "spec.js");
  mkdirSync(join(dir, "skills", "ok"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "ok", "SKILL.md.spec.ts"),
    `import { experimental_skill } from ${JSON.stringify(specEntry)};\n` +
      `export default experimental_skill({\n` +
      `  name: "ok",\n` +
      `  description: "A skill with no references at all, so nothing can be stale.",\n` +
      `  tools: ["Read"],\n` +
      `  body: "Do the thing.",\n` +
      `});\n`,
  );

  assert.equal(run("compile", "skills/ok/SKILL.md.spec.ts").code, 0);
  const out = join(dir, "skills", "ok", "SKILL.md");
  assert.equal(existsSync(out), true);
  assert.match(
    readFileSync(out, "utf-8"),
    /vigiles:sha256/,
    "and it is stamped",
  );
});

// --- compile budgets: a warning by default, a gate under vigiles:strict (#350)

/** A spec whose one keyFiles entry is an essay rather than a pointer. */
function overBudgetSpec(): string {
  return (
    `import { instructionFile } from ${JSON.stringify(SPEC_ENTRY)};\n` +
    `export default instructionFile({\n` +
    `  keyFiles: { "package.json": ${JSON.stringify("x".repeat(400))} },\n` +
    `  rules: {},\n` +
    `});\n`
  );
}

test("by default an over-budget entry is a warning and the artifact is written", () => {
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), overBudgetSpec());
  const compiled = run("compile", "CLAUDE.md.spec.ts");
  assert.equal(compiled.code, 0, compiled.out);
  assert.match(compiled.out, /budget warning/);
  assert.equal(existsSync(join(dir, "CLAUDE.md")), true);
});

test("under vigiles:strict the same entry fails compile and nothing is written", () => {
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), overBudgetSpec());
  writeFileSync(
    join(dir, ".vigilesrc.json"),
    JSON.stringify({ extends: "vigiles:strict" }),
  );
  const compiled = run("compile", "CLAUDE.md.spec.ts");
  assert.notEqual(compiled.code, 0, compiled.out);
  assert.match(compiled.out, /entry-too-long/);
  assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
});

test("under vigiles:strict lint gates an artifact compiled before the switch, naming compile-budget", () => {
  writeFileSync(join(dir, "CLAUDE.md.spec.ts"), overBudgetSpec());
  assert.equal(run("compile", "CLAUDE.md.spec.ts").code, 0);
  assert.equal(run("lint", ".").code, 0, "default: lint stays as it was");

  writeFileSync(
    join(dir, ".vigilesrc.json"),
    JSON.stringify({ extends: "vigiles:strict" }),
  );
  const linted = run("lint", ".");
  assert.notEqual(linted.code, 0, linted.out);
  assert.match(linted.out, /compile-budget/);
  assert.doesNotMatch(
    linted.out,
    /Spec reference check/,
    "a size finding is not a dead reference",
  );
});
