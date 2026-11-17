/**
 * What a harness file can reach, for `vigiles test --changed`: its relative
 * import closure, the files its effect calls run, read or copy, and the source
 * behind a build output it imports.
 *
 * 🔴 THE FAILURE THIS FILE GUARDS AGAINST IS A SILENT SKIP. A selector that
 * cannot see a dependency drops the harness and the run is green. Measured on a
 * consumer repository of 155 harnesses: harnesses reading the agent settings
 * file through `readFileSync(join(ROOT, "config", "settings.json"))` were
 * skipped on the commit that changed it, and a repository whose harnesses
 * import `dist/` selected 0 of 16 for a change to the `src/` behind it. The
 * negatives matter as much: a path inside a synthetic event object is a
 * FIXTURE, and selecting on it would run harnesses for no reason.
 *
 * Every case runs on an in-memory host, so what is proved is the analysis.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  harnessReach,
  outputLayout,
  reachMatch,
  type Reach,
  type SourceHost,
} from "./test-reach.js";

const CWD = "/repo";

function memHost(files: Readonly<Record<string, string>>): SourceHost {
  const abs = new Map(Object.entries(files).map(([k, v]) => [join(CWD, k), v]));
  return { read: (p) => abs.get(p) ?? null, isFile: (p) => abs.has(p) };
}

function reach(
  files: Readonly<Record<string, string>>,
  harness = "t/x.harness.mjs",
): Reach {
  const host = memHost(files);
  return harnessReach({
    cwd: CWD,
    file: harness,
    host,
    layout: outputLayout(CWD, host),
  });
}

/** Does a change to `changed` reach the harness, and by which kind? */
const hits = (r: Reach, changed: string): string | undefined =>
  reachMatch(r, changed)?.kind;

const ROOT_CONST =
  'import { join, resolve } from "node:path";\n' +
  'const ROOT = resolve(import.meta.dirname, "..");\n';

describe("effect calls — a resolvable path outside the folder is a dependency", () => {
  test("readFileSync(join(ROOT, …)) of a settings file", () => {
    const r = reach({
      "t/x.harness.mjs":
        ROOT_CONST +
        'import { readFileSync } from "node:fs";\n' +
        'readFileSync(join(ROOT, "config", "settings.json"), "utf8");\n',
    });
    assert.equal(hits(r, "config/settings.json"), "reads");
    assert.equal(hits(r, "config/other.json"), undefined);
  });

  test("a spawned script named in the argv array", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { spawnSync } from "node:child_process";\n' +
        'spawnSync("node", [new URL("../lib/run.mjs", import.meta.url).pathname]);\n',
    });
    assert.equal(hits(r, "lib/run.mjs"), "reads");
  });

  test("cpSync of a real script, and a directory copied whole", () => {
    const r = reach({
      "t/x.harness.mjs":
        ROOT_CONST +
        'import * as fs from "node:fs";\n' +
        'fs.cpSync(join(ROOT, "scripts/check.py"), "/tmp/a/check.py");\n' +
        'fs.cpSync(join(ROOT, "templates"), "/tmp/a/t", { recursive: true });\n',
    });
    assert.equal(hits(r, "scripts/check.py"), "reads");
    assert.equal(hits(r, "templates/base/page.md"), "reads");
  });

  test("execSync of a command string", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { execSync } from "node:child_process";\n' +
        'execSync("sh tools/gen.sh --quiet");\n',
    });
    assert.equal(hits(r, "tools/gen.sh"), "reads");
  });

  test("a call in an imported helper counts, resolved from the helper's folder", () => {
    const r = reach({
      "t/x.harness.mjs": 'import "../lib/h.mjs";\n',
      "lib/h.mjs":
        'import { readFileSync } from "node:fs";\n' +
        'readFileSync(new URL("../data/rows.json", import.meta.url));\n',
    });
    assert.equal(hits(r, "data/rows.json"), "reads");
  });

  test("a known prefix and an unknown name selects on the prefix's folder", () => {
    const r = reach({
      "t/x.harness.mjs":
        ROOT_CONST +
        'import { readFileSync } from "node:fs";\n' +
        "export const load = (name) => readFileSync(join(ROOT, 'data', name));\n",
    });
    assert.equal(hits(r, "data/a.json"), "reads");
    assert.equal(hits(r, "docs/a.md"), undefined);
  });
});

describe("effect calls — a whole-tree reader", () => {
  test("a path under the run's root with an unknown tail selects on every change", () => {
    const r = reach({
      "t/x.harness.mjs":
        ROOT_CONST +
        'import { existsSync } from "node:fs";\n' +
        "export const has = (note) => existsSync(join(ROOT, note));\n",
    });
    assert.equal(hits(r, "notes/2026/a.md"), "reads");
    assert.equal(hits(r, "README.md"), "reads");
  });
});

describe("effect calls — what does NOT count", () => {
  test("a path inside an event object is a fixture, not a dependency", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { runHook } from "vigiles";\n' +
        'runHook("node t/hook.mjs", { tool_name: "Write", tool_input: { file_path: "docs/paper.tex" } });\n' +
        'const ev = { file_path: "skills/a/SKILL.md" };\n',
    });
    assert.equal(hits(r, "docs/paper.tex"), undefined);
    assert.equal(hits(r, "skills/a/SKILL.md"), undefined);
    assert.equal(hits(r, "t/hook.mjs"), "reads");
  });

  test("RegExp exec is not child_process exec", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { exec as run } from "node:child_process";\n' +
        "const m = /a/.exec(text);\n" +
        'import * as cp from "node:child_process";\n' +
        'cp.exec("sh tools/a.sh");\n',
    });
    assert.deepEqual(r.unresolved, []);
    assert.equal(hits(r, "tools/a.sh"), "reads");
  });

  test("an unknown argument under a sandbox cwd is not a repo path", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { spawnSync } from "node:child_process";\n' +
        'export const git = (tmp, args) => spawnSync("git", args, { cwd: tmp });\n',
    });
    assert.deepEqual(r.unresolved, []);
  });

  test("a call that is not an effect names no dependency", () => {
    const r = reach({
      "t/x.harness.mjs": 'const note = editNote("docs/drafts/09.md");\n',
    });
    assert.equal(hits(r, "docs/drafts/09.md"), undefined);
  });

  test("a relative argument under an explicit cwd option names that folder", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { spawnSync } from "node:child_process";\n' +
        'spawnSync("git", ["add", "."], { cwd: "/tmp/sandbox" });\n',
    });
    assert.equal(hits(r, "docs/a.md"), undefined);
  });
});

describe("effect calls — a path nobody can resolve", () => {
  test("a self-referencing variable is unknown, not a hang", () => {
    const body =
      'import { readFileSync } from "node:fs";\nlet p = "a";\n' +
      Array.from({ length: 30 }, () => 'p = p + "/b";\n').join("") +
      "readFileSync(p);\n";
    const r = reach({ "t/x.harness.mjs": body });
    assert.equal(r.unresolved.length, 1);
  });

  test("an env override falls back to the path after ??", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { join } from "node:path";\n' +
        'import { readFileSync } from "node:fs";\n' +
        "const ROOT = process.env.PROJECT_DIR ?? process.cwd();\n" +
        'readFileSync(join(ROOT, "CLAUDE.md"), "utf8");\n',
    });
    assert.equal(hits(r, "CLAUDE.md"), "reads");
  });

  test("is listed as unresolved, with the call and line", () => {
    const r = reach({
      "t/x.harness.mjs":
        'import { readFileSync } from "node:fs";\n' +
        "export const load = (p) => readFileSync(p);\n",
    });
    assert.deepEqual(r.unresolved, [
      { call: "readFileSync", file: "t/x.harness.mjs", line: 2 },
    ]);
  });
});

describe("build output → source (tsconfig outDir/rootDir)", () => {
  const tsconfig = JSON.stringify({
    compilerOptions: { outDir: "dist", rootDir: "src" },
  });

  test("an import of dist/ continues from the src/ file behind it", () => {
    const r = reach({
      "tsconfig.json": tsconfig,
      "t/x.harness.mjs": 'import { f } from "../dist/lib.js";\n',
      "src/lib.ts": 'export { g } from "./dep.js";\n',
      "src/dep.ts": "export const g = 1;\n",
    });
    assert.equal(hits(r, "src/lib.ts"), "import");
    assert.equal(hits(r, "src/dep.ts"), "import");
  });

  test("an .mjs output maps to .mts", () => {
    const r = reach({
      "tsconfig.json": tsconfig,
      "t/x.harness.mjs": 'import "../dist/hooks.mjs";\n',
      "src/hooks.mts": "export {};\n",
    });
    assert.equal(hits(r, "src/hooks.mts"), "import");
  });

  test("the build's source adds imports only, not its runtime file reads", () => {
    const r = reach({
      "tsconfig.json": tsconfig,
      "t/x.harness.mjs": 'import { f } from "../dist/lib.js";\n',
      "src/lib.ts":
        'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n' +
        "export const f = (name: string) => readFileSync(join(process.cwd(), name));\n",
    });
    assert.equal(hits(r, "src/lib.ts"), "import");
    assert.equal(hits(r, "docs/readme.md"), undefined);
    assert.deepEqual(r.unresolved, []);
  });

  test("no tsconfig: a dist/ import stays what it is", () => {
    const r = reach({
      "t/x.harness.mjs": 'import { f } from "../dist/lib.js";\n',
      "src/lib.ts": "export const f = 1;\n",
    });
    assert.equal(hits(r, "src/lib.ts"), undefined);
  });
});
