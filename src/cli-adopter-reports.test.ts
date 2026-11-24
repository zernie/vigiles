/**
 * Four small CLI defects reported by an adopter (#176, #175) — each one a place
 * the CLI was quietly wrong rather than loudly broken, which is why they all
 * survived to be found by hand in someone else's repo.
 *
 * Driven through the REAL built CLI: every one of these is about what the
 * command PRINTS, RETURNS, or WRITES, none of which a unit test of the
 * underlying function can see.
 *
 * Deterministic, model-free, offline → the free unit tier.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

let dir: string;

function run(args: string[], cwd: string = dir): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd,
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

/** A minimal one-skill bundle. */
function bundle(root: string, name: string): void {
  const d = join(root, name, "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does the ${name} thing when asked.\n---\n\nSteps.\n`,
  );
  mkdirSync(join(root, name, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, name, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.0.0" }),
  );
}

beforeEach(() => {
  dir = makeTmpDir();
});
afterEach(() => {
  cleanupTmpDir(dir);
});

// --- #176.5 -------------------------------------------------------------

test("an unknown COMMAND exits 2, like an unknown flag (#176.5)", () => {
  // docs/cli.md fixes the contract: 1 = "I ran, and it's bad", 2 = "I could not
  // do what you asked". A typo'd verb was exiting 1, so a script reading the
  // exit code took a mistyped command name for a finding.
  const bogus = run(["bogus-verb"]);
  assert.equal(bogus.code, 2);
  assert.match(bogus.out, /Unknown command/);

  // The two paths must agree — that agreement is the whole point.
  assert.equal(run(["lint", "--bogus-flag"]).code, 2);
});

test("a real finding still exits 1, not 2", () => {
  // The other half: widening the 2 must not swallow the "I measured, and it is
  // bad" signal, which is the distinction the exit codes exist to carry.
  assert.equal(run(["--version"]).code, 0);
});

// --- #176.8 -------------------------------------------------------------

test("--out outside the repo does not touch .gitignore (#176.8)", () => {
  const repo = join(dir, "repo");
  const outside = join(dir, "elsewhere");
  mkdirSync(outside, { recursive: true });
  bundle(repo, "alpha");
  const gitignore = join(repo, ".gitignore");
  writeFileSync(gitignore, "node_modules\n");

  run(
    [
      "audit",
      join(repo, "alpha"),
      "--no-interactive",
      "--no-open",
      "--no-serve",
      `--out=${outside}`,
    ],
    repo,
  );

  const after = readFileSync(gitignore, "utf-8");
  assert.equal(
    after.includes(".."),
    false,
    "an entry pointing outside the tree ignores nothing and only accumulates",
  );
  assert.equal(
    after,
    "node_modules\n",
    "a read-only report left the file alone",
  );
});

test("--out INSIDE the repo still gets gitignored", () => {
  // The documented, useful half — the fix must not disable it.
  const repo = join(dir, "repo2");
  bundle(repo, "beta");
  const gitignore = join(repo, ".gitignore");
  writeFileSync(gitignore, "node_modules\n");

  run(
    [
      "audit",
      join(repo, "beta"),
      "--no-interactive",
      "--no-open",
      "--no-serve",
      "--out=reports",
    ],
    repo,
  );

  const after = readFileSync(gitignore, "utf-8");
  assert.match(
    after,
    /vigiles-report/,
    "reports inside the tree are still ignored",
  );
});

// --- #176.3 -------------------------------------------------------------

test("--out in leaderboard mode SAYS it is ignored (#176.3)", () => {
  // It produces no per-bundle report by design; the defect was saying nothing,
  // which ships an empty CI artifact behind a green check.
  bundle(dir, "one");
  bundle(dir, "two");

  const r = run([
    "audit",
    join(dir, "one"),
    join(dir, "two"),
    "--no-interactive",
    "--no-open",
    "--no-serve",
    "--out=reports",
  ]);

  assert.match(r.out, /--out is ignored/);
  assert.equal(
    existsSync(join(dir, "reports")),
    false,
    "the warning describes reality: still no report written",
  );
});

test("a single-target audit does NOT print the leaderboard warning", () => {
  bundle(dir, "solo");
  const r = run([
    "audit",
    join(dir, "solo"),
    "--no-interactive",
    "--no-open",
    "--no-serve",
    "--out=reports",
  ]);
  assert.equal(
    r.out.includes("--out is ignored"),
    false,
    "here --out works, so warning about it would be the opposite false alarm",
  );
});

// --- #176.2 -------------------------------------------------------------

test("--single audits a many-bundle dir as ONE harness (#176.2)", () => {
  // Without it, a repo holding many bundles auto-switches to the leaderboard and
  // the full ring report for the ROOT is simply unreachable — the reported
  // workaround was a CI job looping audit over 29 directories.
  // A marketplace is what makes ONE directory expand into many bundles — the
  // shape the report came from (29 bundles under one root).
  bundle(dir, "one");
  bundle(dir, "two");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture-market",
      plugins: [
        { name: "one", source: "./one" },
        { name: "two", source: "./two" },
      ],
    }),
  );

  const board = run([
    "audit",
    dir,
    "--no-interactive",
    "--no-open",
    "--no-serve",
  ]);
  const single = run([
    "audit",
    dir,
    "--single",
    "--no-interactive",
    "--no-open",
    "--no-serve",
  ]);

  assert.notEqual(
    board.out,
    single.out,
    "--single must change the mode, not be accepted and ignored",
  );
  assert.match(single.out, /Detected harness/, "the single-harness report ran");
});

test("--single with several directories is REFUSED, not half-honoured", () => {
  // It names ONE harness, so more than one directory is a contradiction.
  // Auditing the first and dropping the rest would be the same silent-no-op
  // class as the ignored --out above.
  bundle(dir, "a");
  bundle(dir, "b");

  const r = run([
    "audit",
    join(dir, "a"),
    join(dir, "b"),
    "--single",
    "--no-interactive",
    "--no-open",
    "--no-serve",
  ]);
  assert.equal(r.code, 2, "could not do what you asked ⇒ 2");
  assert.match(r.out, /--single audits ONE directory/);
});

test("--single is a REGISTERED flag, not silently swallowed", () => {
  // audit refuses unknown flags before anything runs; a flag that is real but
  // unregistered would exit 2 with "unknown flag", which is how a new flag ships
  // broken.
  bundle(dir, "solo2");
  const r = run([
    "audit",
    join(dir, "solo2"),
    "--single",
    "--no-interactive",
    "--no-open",
    "--no-serve",
  ]);
  assert.equal(r.out.includes("Unknown flag"), false);
  assert.equal(r.code, 0);
});
