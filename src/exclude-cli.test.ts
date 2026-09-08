/**
 * `.vigilesrc.json#exclude` reaches EVERY pass that polices the repo (#192) —
 * driven through the REAL built CLI (`node dist/cli.js …`) over one fixture repo,
 * in BOTH directions: with `vendored` excluded every verb is clean and exits 0;
 * with `exclude: []` (the control) every row fires. A test that asserted only the
 * quiet side could not tell a working filter from a dead one.
 *
 * The spelling under test is the BARE directory name (`"vendored"`, no `/**`):
 * that is the form glob's string ignore silently matched nothing for (measured
 * 2026-09-03), and the half most likely to regress silently.
 *
 * Rows follow the classification in the issue's design comment:
 *   1  findSpecs              — compile must not load the frozen, un-loadable spec
 *   2  findInstructionFiles   — lint's require-instructions-spec on vendored/CLAUDE.md
 *   3+7 discoverNestedBundles + test-coverage — the vendored plugin is not scored
 *   4  findDocRefs            — the broken file() ref in vendored/docs
 *   5  orphans candidates     — vendored/docs/lonely.md
 *   6  orphans reference scan — unit-tested in core/orphans.test.ts (the observable
 *                               effect is a NEW orphan, so it cannot live in the
 *                               "clean" side of this fixture)
 *   8  collectDocumentedRules — NOT asserted here: its count only moves when a
 *                               linter is detected, and this fixture has none
 *                               (`Coverage: 0/0` on both sides). Covered by the
 *                               ESLint discovery guard + the source gate below.
 *   9  gatherInstructionFiles — audit --json must not carry vendored/CLAUDE.md's text
 *  10  coverage.ts fallback   — unreachable from the CLI (specs are always passed);
 *                               signature-required, exercised by coverage.test.ts
 *  11  discoverScripts        — `vigiles test` must not run the vendored harness
 * Then the explicit-path override: a NAMED excluded path is processed, with the
 * one-line note (rg/tsc semantics, ESLint loudness — never prettier's silence).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const ROOT = resolve(__dirname, "..");
const CLI = resolve(ROOT, "dist", "cli.js");
const SPEC_JS = resolve(ROOT, "dist", "core", "spec.js");
const SENTINEL = "ZEBRA_SENTINEL";

function run(args: string, cwd: string): { out: string; code: number } {
  try {
    const out = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { out, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

/** One fixture repo: a live spec + docs + harness at the root, everything that
 * would fire under `vendored/`. `exclude` is the only thing the two copies differ in. */
function makeFixture(exclude: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-exclude-e2e-"));
  const w = (rel: string, text: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  w(
    ".vigilesrc.json",
    JSON.stringify({
      rules: {
        "require-instructions-spec": "error",
        "doc-refs": "error",
        "untested-skill": "error",
        "orphan-docs": "error",
        "spec-refs": "error",
      },
      orphans: { include: ["docs/**/*.md", "vendored/docs/**/*.md"] },
      bundles: "all",
      exclude,
    }),
  );
  w(
    "package.json",
    JSON.stringify({ name: "fx", version: "0.0.0", scripts: {} }),
  );
  w(
    "CLAUDE.md.spec.ts",
    `import { instructionFile, guidance } from "${SPEC_JS}";\nexport default instructionFile({ rules: { keep: guidance("Keep it simple") } });\n`,
  );
  w("README.md", "# fx\n\nSee [kept](docs/kept.md).\n");
  w("docs/kept.md", "# kept\n");
  w("ok.harness.mjs", "process.exit(0);\n");
  // --- everything below is the vendored corpus ---
  w(
    "vendored/CLAUDE.md",
    `# Theirs\n\n## Rules\n\n${SENTINEL}: always use tabs, never spaces.\n`,
  );
  // Authored against an API this version does not export — the issue's exact shape.
  w(
    "vendored/BROKEN.md.spec.ts",
    `import { nonexistent } from "${SPEC_JS}";\nexport default nonexistent();\n`,
  );
  w(
    "vendored/docs/refs.md",
    '# refs\n\n```ts\nfile("does-not-exist.md")\n```\n',
  );
  w("vendored/docs/lonely.md", "# lonely\n");
  w(
    "vendored/plugin/.claude-plugin/plugin.json",
    JSON.stringify({
      name: "theirs",
      version: "1.0.0",
      description: "vendored",
    }),
  );
  w(
    "vendored/plugin/skills/demo/SKILL.md",
    "---\nname: demo\ndescription: A vendored demo skill for testing exclusion\n---\n\nDo the demo.\n",
  );
  w("vendored/theirs.harness.mjs", "process.exit(1);\n");
  return dir;
}

describe("exclude e2e — `vendored` (bare name) excluded", () => {
  let dir: string;
  beforeAll(() => {
    dir = makeFixture(["vendored"]);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("row 1: bare `compile` neither loads nor reports the excluded spec, and exits 0", () => {
    const r = run("compile", dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ CLAUDE\.md\.spec\.ts → CLAUDE\.md/);
    assert.doesNotMatch(r.out, /BROKEN/);
    assert.doesNotMatch(r.out, /with errors/);
  });

  it("rows 2, 3+7, 4, 5: `lint` is clean and exits 0", () => {
    run("compile", dir); // lint verifies the compiled artifact
    const r = run("lint", dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /vendored\/CLAUDE\.md/, "row 2");
    assert.doesNotMatch(r.out, /vendored\/plugin|skills\/demo/, "rows 3+7");
    assert.doesNotMatch(r.out, /does-not-exist/, "row 4");
    assert.doesNotMatch(r.out, /lonely\.md/, "row 5");
    assert.match(r.out, /0 finding\(s\): 0 error, 0 warning/);
  });

  it("row 9: `audit --json` does not read the excluded instruction file", () => {
    const r = run("audit --json --no-html", dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, new RegExp(SENTINEL));
  });

  it("row 11: `test` does not discover (or run) the excluded harness", () => {
    const r = run("test", dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ok\.harness\.mjs/);
    assert.doesNotMatch(r.out, /theirs\.harness\.mjs/);
  });

  it("explicit path wins, loudly: `compile <excluded spec>` processes it and says why", () => {
    const r = run("compile vendored/BROKEN.md.spec.ts", dir);
    assert.match(
      r.out,
      /note: vendored\/BROKEN\.md\.spec\.ts matches exclude "vendored" — compiling because you named it/,
    );
    assert.match(
      r.out,
      /✗ vendored\/BROKEN\.md\.spec\.ts — failed to load/,
      "processed, not skipped",
    );
    assert.notEqual(
      r.code,
      0,
      "a named path that fails is a failure, never a silent pass",
    );
  });

  it("explicit path wins for `lint <file>` and `test <file>` too", () => {
    const l = run("lint vendored/CLAUDE.md", dir);
    assert.match(
      l.out,
      /note: vendored\/CLAUDE\.md matches exclude "vendored" — linting because you named it/,
    );
    assert.match(l.out, /\[require-instructions-spec\]/, "processed");
    const t = run("test vendored/theirs.harness.mjs", dir);
    assert.match(
      t.out,
      /note: vendored\/theirs\.harness\.mjs matches exclude "vendored" — running because you named it/,
    );
    assert.match(
      t.out,
      /✗ vendored\/theirs\.harness\.mjs/,
      "ran, and failed as it should",
    );
    assert.equal(t.code, 1);
  });

  it("no note is printed for an explicit path that is NOT excluded", () => {
    const r = run("compile CLAUDE.md.spec.ts", dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /note: .* matches exclude/);
  });
});

describe("exclude e2e — control: `exclude: []` makes every row FIRE", () => {
  let dir: string;
  beforeAll(() => {
    dir = makeFixture([]);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("row 1: bare `compile` loads the frozen spec and reports the issue's symptom", () => {
    const r = run("compile", dir);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /✗ vendored\/BROKEN\.md\.spec\.ts — failed to load/);
    assert.match(r.out, /Compilation complete with errors/);
  });

  it("rows 2, 3+7, 4, 5: `lint` reports each", () => {
    run("compile", dir);
    const r = run("lint", dir);
    assert.notEqual(r.code, 0);
    assert.match(
      r.out,
      /\[require-instructions-spec\] No spec file found for ".*vendored\/CLAUDE\.md"/,
      "row 2",
    );
    assert.match(
      r.out,
      /Scoring 2 bundles: the root \+ vendored\/plugin/,
      "row 3",
    );
    assert.match(r.out, /skills\/demo\/SKILL\.md/, "row 7");
    assert.match(
      r.out,
      /vendored\/docs\/refs\.md:\d+ file\("does-not-exist\.md"\)/,
      "row 4",
    );
    assert.match(r.out, /vendored\/docs\/lonely\.md/, "row 5");
  });

  it("row 9: `audit --json` reads the vendored instruction file", () => {
    const r = run("audit --json --no-html", dir);
    assert.match(r.out, new RegExp(SENTINEL));
  });

  it("row 11: `test` discovers and runs the vendored harness", () => {
    const r = run("test", dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ vendored\/theirs\.harness\.mjs/);
  });
});

/**
 * Source-level gate (the shape of cli-harness-resolution.test.ts): the detectors
 * that live OUTSIDE the verb barrel take the exclude list through an OPTIONS
 * object, so tsc cannot make it required there without breaking every library
 * caller. The requirement is enforced at the composition root instead — every
 * call from the barrel must hand the ExcludeSet over. The barrel-internal walks
 * (`findSpecs`, `findInstructionFiles`, `discoverNestedBundles`,
 * `collectDocumentedRules`, `gatherInstructionFiles`) take it as a REQUIRED
 * parameter and need no gate.
 *
 * The barrel is `cli-main.ts`, not `cli.ts`: `cli.ts` was reduced to a dispatcher
 * shim in #216 so a compiled hook stops loading the verbs to decide allow/deny.
 * Reading the shim here would scan a 90-line file with no walks in it and pass
 * vacuously — the exact failure mode this gate exists to prevent.
 */
const CLI_SRC = readFileSync(join(__dirname, "cli-main.ts"), "utf-8");

function argsOfCalls(name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  for (
    let i = CLI_SRC.indexOf(needle);
    i !== -1;
    i = CLI_SRC.indexOf(needle, i + 1)
  ) {
    // Skip the definition and prose mentions: a call is preceded by `=`, `(`,
    // `,`, `?? `, `return ` or whitespace-then-nothing-else, never by `function `.
    if (/function\s*$/.test(CLI_SRC.slice(Math.max(0, i - 12), i))) continue;
    let depth = 0;
    let end = i + needle.length;
    for (; end < CLI_SRC.length; end++) {
      const c = CLI_SRC[end];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" && depth === 0) break;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    out.push(CLI_SRC.slice(i + needle.length, end));
  }
  return out;
}

describe("exclude — every options-object detector call in cli.ts carries the ExcludeSet", () => {
  const cases: [string, RegExp][] = [
    ["findDocRefs", /ignore:\s*excludes\.ignore/],
    ["findOrphanDocs", /repoExclude:\s*excludes\.ignore/],
    ["findUntestedSurfaces", /exclude(s\b|:)[\s\S]*\.ignore/],
    ["skillTestNudge", /excludeSet\([^)]*\)\.ignore/],
    ["discoverScripts", /excludes\.ignore/],
    ["computeScriptCoverage", /excludes\.ignore/],
  ];
  for (const [fn, re] of cases) {
    it(`${fn}(…) passes the repo exclude`, () => {
      const calls = argsOfCalls(fn).filter(
        (a) =>
          a.includes("basePath") ||
          a.includes("cwd") ||
          fn === "discoverScripts" ||
          fn === "computeScriptCoverage",
      );
      assert.ok(calls.length > 0, `no ${fn}( call found in cli.ts`);
      for (const args of calls)
        assert.match(args, re, `${fn}(${args.slice(0, 80)}…)`);
    });
  }
});
