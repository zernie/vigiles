/**
 * The `untested-*` rules' OPTIONS, as they travel from `.vigilesrc.json` through
 * the CLI into the finding — driven through the real built CLI, because that
 * journey is the part a library-level test cannot see.
 *
 * `core/test-file-ext.test.ts` already proves the decision itself (config beats
 * detection, nonsense is ignored). What was missing is the wiring, and that is
 * where it broke: `TestCoverageConfig` carried no `testExtension` key and
 * `checkUntestedSurfaces` forwarded only `include`/`exclude`, so the option
 * documented as coming from `.vigilesrc.json` was read by nothing and every
 * TypeScript-shaped repo got `.ts` suggestions whatever its author configured.
 *
 * Deterministic, model-free, offline → the free unit tier.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { canRunTypeScript, detectNodeCaps } from "./ts-runner-caps.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

// __dirname is src/ when vitest resolves the .ts source → ".." is the repo root.
const CLI = resolve(__dirname, "..", "dist", "cli.js");

let dir: string;

function write(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** `vigiles lint`'s stdout — the command exits non-zero on findings. */
function lint(): string {
  try {
    return execFileSync("node", [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60000,
    });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

/** The suggested test path out of the untested-surfaces finding. */
function suggestion(out: string): string {
  const line = out.split("\n").find((l) => l.includes("SKILL.md — add e.g. "));
  assert.ok(line, `no untested-skill suggestion in:\n${out}`);
  return line.slice(line.indexOf("add e.g. ") + "add e.g. ".length).trim();
}

beforeEach(() => {
  dir = makeTmpDir("cli-untested-opts");
  // A TypeScript-SHAPED repo: detection will say `.ts` unless told otherwise.
  write("tsconfig.json", "{}\n");
  write("package.json", JSON.stringify({ name: "demo-repo" }));
  write(
    ".claude/skills/demo/SKILL.md",
    "---\nname: demo\ndescription: demo skill\n---\n\nBody.\n",
  );
});

afterEach(() => {
  cleanupTmpDir(dir);
});

/**
 * The extension DETECTION arrives at on THIS host, and one it never would.
 *
 * 🔴 BOTH HALVES ARE HOST-DEPENDENT, AND PINNING EITHER ONE HAS BROKEN CI. A
 * `tsconfig.json` buys `.ts` only where a TypeScript file can actually RUN, so a
 * Node 22 dev box detects `.ts` and CI's Node 20 detects `.mjs` — and both are
 * correct. That cuts both ways: a config test that pins `.mjs` proves the option
 * travelled on the dev box and proves NOTHING on Node 20, where detection would
 * have produced `.mjs` unaided. So the configured value is picked to DIFFER from
 * the detected one on every host, and a pass can only mean the config was read.
 */
function extensions(): { detected: RegExp; configure: string; want: RegExp } {
  return canRunTypeScript(detectNodeCaps(dir))
    ? { detected: /\.ts$/, configure: "mjs", want: /\.mjs$/ }
    : { detected: /\.mjs$/, configure: "cjs", want: /\.cjs$/ };
}

test("detection decides the suggested test extension with no config", () => {
  // The control. A tsconfig.json is enough to write TypeScript, unasked —
  // wherever TypeScript can be executed at all.
  assert.match(suggestion(lint()), extensions().detected);
});

test("…and `testExtension` in .vigilesrc.json overrides it", () => {
  const { configure, want } = extensions();
  write(
    ".vigilesrc.json",
    JSON.stringify({
      rules: { "untested-skill": ["warn", { testExtension: configure }] },
    }),
  );
  assert.match(
    suggestion(lint()),
    want,
    "the configured extension must reach the finding",
  );
});

test("…from any of the three untested-* rules, since they share their options", () => {
  // `checkUntestedSurfaces` merges the options of all three rules, so an author
  // who configured it on the hook rule must not find it works only on the skill
  // one — the merge is the documented behaviour, and it must apply to every key.
  const { configure, want } = extensions();
  write(
    ".vigilesrc.json",
    JSON.stringify({
      rules: { "untested-hook": ["warn", { testExtension: configure }] },
    }),
  );
  assert.match(suggestion(lint()), want);
});

test("a nonsense extension is ignored, not written into an unrunnable path", () => {
  // Suggesting `demo.harness.rb` would point the author at a path no runner can
  // execute, so the finding could never be satisfied.
  //
  // 🔴 ASSERT THE PROPERTY, NOT THE EXTENSION. This used to pin `.ts`, which is
  // only right on a host that can RUN TypeScript: it passed on a Node 22 dev box
  // and failed on CI's Node 20, where `.mjs` is the correct answer and the gate
  // was working. This spawns a real `node`, so the capability cannot be simulated
  // away — the honest assertion is that the suggested path is one THIS host can
  // execute, and that the nonsense value never reaches it.
  write(
    ".vigilesrc.json",
    JSON.stringify({
      rules: { "untested-skill": ["warn", { testExtension: "rb" }] },
    }),
  );
  const got = suggestion(lint());
  assert.doesNotMatch(got, /\.rb$/, "the nonsense extension reached the path");
  const runnable = canRunTypeScript(detectNodeCaps(dir)) ? /\.ts$/ : /\.mjs$/;
  assert.match(
    got,
    runnable,
    `suggested a path this host cannot run (tsx/strip-types: ${String(
      canRunTypeScript(detectNodeCaps(dir)),
    )})`,
  );
});
