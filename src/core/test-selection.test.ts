/**
 * `vigiles test --changed=<ref>` — which harness files a change can reach.
 *
 * The selector exists because the import-graph runners miss the commonest
 * harness shape: a test that SPAWNS the script beside it
 * (`spawnSync("node", ["hook.mjs"])`) or reads a data file has no import edge
 * to it, so Vitest's `--changed` and Jest's `--findRelatedTests` both report
 * "no affected tests" when that script changes, and exit 0. Folder colocation
 * is what covers it here; the import closure covers a shared helper elsewhere.
 *
 * The pure half is tested on paths; the CLI half is driven through the BUILT
 * CLI in a scratch git repo, because the defect class is "a green run that ran
 * nothing", and only the real exit code and output can show that.
 */
import { describe, test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_RUN_ALL_ON,
  formatSelection,
  parseChangedRef,
  selectTests,
  type ChangedSince,
} from "./test-selection.js";
import { harnessReach, type Reach } from "./test-reach.js";
import { nodeSourceHost } from "../host/changed-files.io.js";
import { initGitRepo, git, makeTmpDir, cleanupTmpDir } from "./test-utils.js";

const EMPTY: Reach = { imports: new Set(), effects: [], unresolved: [] };
const none = (): Reach => EMPTY;
const SINCE: ChangedSince = {
  files: ["docs/readme.md"],
  base: "0123456789abcdef",
  via: "merge-base",
  workflowsGlob: ".github/workflows/**",
};

describe("selectTests — one reason per selected file", () => {
  const files = ["hooks/guard/guard.harness.mjs", "skills/x/x.harness.mjs"];

  test("a changed file in the harness's own folder selects it (a spawned script)", () => {
    const s = selectTests({
      files,
      changed: ["hooks/guard/guard.mjs"],
      runAllOn: DEFAULT_RUN_ALL_ON,
      reach: none,
    });
    assert.deepEqual(s.selected, [
      {
        file: "hooks/guard/guard.harness.mjs",
        reason: { kind: "folder", changed: "hooks/guard/guard.mjs" },
      },
    ]);
    assert.deepEqual(s.skipped, ["skills/x/x.harness.mjs"]);
  });

  test("a change BELOW the folder selects it too", () => {
    const s = selectTests({
      files,
      changed: ["skills/x/fixtures/input.json"],
      runAllOn: [],
      reach: none,
    });
    assert.deepEqual(
      s.selected.map((x) => x.file),
      ["skills/x/x.harness.mjs"],
    );
  });

  test("a sibling folder with the same prefix is NOT below it", () => {
    const s = selectTests({
      files: ["skills/x/x.harness.mjs"],
      changed: ["skills/xy/other.mjs"],
      runAllOn: [],
      reach: none,
    });
    assert.deepEqual(s.selected, []);
  });

  test("a changed file in the import closure selects it", () => {
    const s = selectTests({
      files,
      changed: ["lib/util.mjs"],
      runAllOn: [],
      reach: (f) =>
        f === "skills/x/x.harness.mjs"
          ? { ...EMPTY, imports: new Set(["lib/util.mjs"]) }
          : EMPTY,
    });
    assert.deepEqual(s.selected, [
      {
        file: "skills/x/x.harness.mjs",
        reason: { kind: "import", changed: "lib/util.mjs" },
      },
    ]);
  });
});

describe("selectTests — effect calls, and failing closed", () => {
  const files = ["hooks/guard/guard.harness.mjs", "skills/x/x.harness.mjs"];
  const reads: Reach = {
    ...EMPTY,
    effects: [
      { path: "config/settings.json", prefix: false, call: "readFileSync" },
    ],
  };

  test("a changed file an effect call reads selects it, naming the call", () => {
    const s = selectTests({
      files,
      changed: ["config/settings.json"],
      runAllOn: [],
      reach: (f) => (f === "skills/x/x.harness.mjs" ? reads : EMPTY),
    });
    assert.deepEqual(s.selected, [
      {
        file: "skills/x/x.harness.mjs",
        reason: {
          kind: "reads",
          changed: "config/settings.json",
          call: "readFileSync",
        },
      },
    ]);
  });

  test("an effect path nobody can evaluate is skipped, and NAMED", () => {
    const unknown = { call: "spawnSync", file: "lib/run.mjs", line: 9 };
    const s = selectTests({
      files,
      changed: ["docs/readme.md"],
      runAllOn: [],
      reach: (f) =>
        f === "skills/x/x.harness.mjs"
          ? { ...EMPTY, unresolved: [unknown] }
          : EMPTY,
    });
    assert.deepEqual(s.selected, []);
    assert.deepEqual(s.unresolved, [
      { file: "skills/x/x.harness.mjs", at: unknown },
    ]);
    assert.match(
      formatSelection(s, "main", SINCE),
      /⚠ 1 skipped file\(s\) also make an effect call whose path cannot be evaluated \(first: skills\/x\/x\.harness\.mjs — spawnSync\(\) at lib\/run\.mjs:9\)/,
    );
  });
});

describe("selectTests — self, run-all, nothing", () => {
  const files = ["hooks/guard/guard.harness.mjs", "skills/x/x.harness.mjs"];

  test("the harness file itself changing selects it as `self`", () => {
    const s = selectTests({
      files,
      changed: ["skills/x/x.harness.mjs"],
      runAllOn: [],
      reach: none,
    });
    assert.deepEqual(s.selected, [
      { file: "skills/x/x.harness.mjs", reason: { kind: "self" } },
    ]);
  });

  test("a run-all trigger selects every file, naming the trigger", () => {
    for (const trigger of ["package.json", "package-lock.json"]) {
      const s = selectTests({
        files,
        changed: ["docs/a.md", trigger],
        runAllOn: DEFAULT_RUN_ALL_ON,
        reach: none,
      });
      assert.deepEqual(
        s.selected.map((x) => x.reason),
        [
          { kind: "run-all", trigger },
          { kind: "run-all", trigger },
        ],
      );
      assert.deepEqual(s.skipped, []);
    }
  });

  test("a configured run-all glob is a trigger", () => {
    const s = selectTests({
      files,
      changed: ["shared/prompts/base.md"],
      runAllOn: [...DEFAULT_RUN_ALL_ON, "shared/**"],
      reach: none,
    });
    assert.equal(s.selected.length, 2);
  });

  test("an unrelated change selects nothing and skips everything", () => {
    const s = selectTests({
      files,
      changed: ["docs/readme.md"],
      runAllOn: DEFAULT_RUN_ALL_ON,
      reach: none,
    });
    assert.deepEqual(s.selected, []);
    assert.deepEqual(s.skipped, files);
  });
});

describe("selectTests — a top-level harness", () => {
  test("a top-level harness owns the whole tree, but not a path outside it", () => {
    const top = selectTests({
      files: ["smoke.harness.mjs"],
      changed: ["any/where.mjs"],
      runAllOn: [],
      reach: none,
    });
    assert.equal(top.selected.length, 1);
    const outside = selectTests({
      files: ["smoke.harness.mjs"],
      changed: ["../sibling-package/x.mjs"],
      runAllOn: [],
      reach: none,
    });
    assert.equal(outside.selected.length, 0);
  });
});

describe("parseChangedRef", () => {
  test("refuses an empty ref and one that git would read as an option", () => {
    assert.equal(parseChangedRef("").kind, "error");
    assert.equal(parseChangedRef("--output=/tmp/x").kind, "error");
    assert.deepEqual(parseChangedRef("origin/main"), {
      kind: "ok",
      ref: "origin/main",
    });
  });
});

describe("harnessReach on disk — relative imports, resolved, transitively", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir("selection-imports");
  });
  afterEach(() => {
    cleanupTmpDir(dir);
  });
  const imports = (file: string): ReadonlySet<string> =>
    harnessReach({ cwd: dir, file, host: nodeSourceHost, layout: undefined })
      .imports;

  test("follows import, re-export, require and literal dynamic import; not packages", () => {
    const w = (rel: string, body: string): void => {
      mkdirSync(resolve(join(dir, rel), ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    w(
      "t/a.harness.mjs",
      'import "../lib/a.js";\nimport "vigiles";\nconst c = require("../lib/c.cjs");\nawait import("../lib/d.mjs");\n',
    );
    w("lib/a.ts", 'export * from "./b.mjs";\n');
    w(
      "lib/b.mjs",
      'import data from "../data/x.json" with { type: "json" };\n',
    );
    w("lib/c.cjs", "module.exports = 1;\n");
    w("lib/d.mjs", "export {};\n");
    w("data/x.json", "{}\n");
    w("lib/unused.mjs", "export {};\n");
    assert.deepEqual([...imports("t/a.harness.mjs")].sort(), [
      "data/x.json",
      "lib/a.ts",
      "lib/b.mjs",
      "lib/c.cjs",
      "lib/d.mjs",
    ]);
  });

  test("an import cycle terminates", () => {
    writeFileSync(join(dir, "a.mjs"), 'import "./b.mjs";\n');
    writeFileSync(join(dir, "b.mjs"), 'import "./a.mjs";\n');
    assert.deepEqual([...imports("a.mjs")], ["b.mjs"]);
  });
});

// __dirname is src/core/ when vitest resolves the .ts source.
const CLI = resolve(__dirname, "..", "..", "dist", "cli.js");

let dir: string;

function write(rel: string, body: string): void {
  mkdirSync(resolve(join(dir, rel), ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function run(...args: string[]): {
  code: number | null;
  out: string;
  err: string;
} {
  const r = spawnSync("node", [CLI, "test", ...args], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * Two harnesses on branch `base`: one that ONLY spawns the script beside it (no
 * import edge), one that reaches a helper in another folder by import.
 */
function fixture(): void {
  dir = makeTmpDir("selection-cli");
  initGitRepo(dir);
  write(
    "hooks/guard/guard.harness.mjs",
    'import { spawnSync } from "node:child_process";\n' +
      "const r = spawnSync(process.execPath, [new URL('./guard.mjs', import.meta.url).pathname]);\n" +
      "process.exit(r.status ?? 1);\n",
  );
  write("hooks/guard/guard.mjs", "process.exit(0);\n");
  write("skills/x/x.harness.mjs", 'import "../../lib/util.mjs";\n');
  write("lib/util.mjs", "export const n = 1;\n");
  write("docs/notes.md", "# notes\n");
  git(dir, "add .");
  git(dir, 'commit -m "fixture"');
  git(dir, "branch base");
}

describe("vigiles test --changed — each reason, through the built CLI", () => {
  beforeEach(fixture);
  afterEach(() => {
    cleanupTmpDir(dir);
  });

  test("a changed spawned script selects the harness beside it, by folder", () => {
    write("hooks/guard/guard.mjs", "process.exit(0); // edited\n");
    const r = run("--changed=base");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(
      r.out,
      /hooks\/guard\/guard\.harness\.mjs — folder: hooks\/guard\/guard\.mjs changed/,
    );
    assert.match(r.out, /Selected 1 of 2 test file\(s\); 1 skipped/);
    assert.match(r.out, /Running 1 test file\(s\)/);
  });

  test("a changed helper selects the harness that imports it, by import", () => {
    write("lib/util.mjs", "export const n = 2;\n");
    git(dir, "commit -am edit");
    const r = run("--changed=base");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(
      r.out,
      /skills\/x\/x\.harness\.mjs — import: lib\/util\.mjs changed/,
    );
    assert.match(r.out, /Selected 1 of 2 test file\(s\); 1 skipped/);
  });

  test("package.json changing runs everything", () => {
    write("package.json", '{ "name": "x" }\n');
    const r = run("--changed=base");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Selected 2 of 2 test file\(s\); 0 skipped/);
    assert.match(r.out, /run-all: package\.json changed/);
  });

  test("a run-all glob from .vigilesrc.json runs everything", () => {
    write(
      ".vigilesrc.json",
      JSON.stringify({ test: { runAllOn: ["docs/**"] } }),
    );
    git(dir, "add .");
    git(dir, 'commit -m "config"');
    git(dir, "branch -f base");
    write("docs/notes.md", "# edited\n");
    const r = run("--changed=base");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /run-all: docs\/notes\.md changed/);
  });
});

describe("vigiles test --changed — nothing selected, floors, bad refs", () => {
  beforeEach(fixture);
  afterEach(() => {
    cleanupTmpDir(dir);
  });

  test("an unrelated change runs NOTHING and says so, with the skip count", () => {
    write("docs/notes.md", "# notes, edited\n");
    const r = run("--changed=base");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /0 of 2 test file\(s\) selected/);
    assert.match(r.out, /Nothing ran; 2 skipped/);
    assert.doesNotMatch(r.out, /Running/);
  });

  test("an untracked new file counts as changed", () => {
    write("hooks/guard/extra.json", "{}\n");
    assert.match(
      run("--changed=base").out,
      /folder: hooks\/guard\/extra\.json changed/,
    );
  });

  test("--min counts what discovery matched, before --changed narrows it", () => {
    write("docs/notes.md", "# edited\n");
    assert.equal(run("--changed=base", "--min=2").code, 0);
    const r = run("--changed=base", "--min=3");
    assert.equal(r.code, 1);
    assert.match(r.err, /--min=3 but only 2 test file\(s\) matched/);
  });

  test("an unknown ref is a usage error, not a run of everything or nothing", () => {
    const r = run("--changed=no-such-branch");
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /no-such-branch/);
  });
});
