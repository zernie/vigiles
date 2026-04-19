import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  gitChangedFiles,
  gitHead,
  loadSpecSurface,
  loadKeyFilesFromSpecs,
  analyzeSession,
  formatSessionReport,
} from "./session.js";
import { writeSidecarManifest } from "./sidecar.js";
import type { SidecarManifest } from "./sidecar.js";
import { makeTmpDir, cleanupTmpDir, initGitRepo, git } from "./test-utils.js";

// ---------------------------------------------------------------------------
// gitChangedFiles
// ---------------------------------------------------------------------------

describe("gitChangedFiles", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("returns empty array when nothing changed", () => {
    const result = gitChangedFiles(tmpDir, "HEAD");
    assert.deepEqual(result, []);
  });

  it("detects modified files", () => {
    writeFileSync(join(tmpDir, "README.md"), "# changed");
    const result = gitChangedFiles(tmpDir, "HEAD");
    assert.ok(result.includes("README.md"));
  });

  it("detects new untracked files", () => {
    writeFileSync(join(tmpDir, "new-file.ts"), "export {}");
    const result = gitChangedFiles(tmpDir, "HEAD");
    assert.ok(result.includes("new-file.ts"));
  });

  it("returns sorted results", () => {
    writeFileSync(join(tmpDir, "z.ts"), "z");
    writeFileSync(join(tmpDir, "a.ts"), "a");
    const result = gitChangedFiles(tmpDir, "HEAD");
    const sorted = [...result].sort();
    assert.deepEqual(result, sorted);
  });
});

// ---------------------------------------------------------------------------
// gitHead
// ---------------------------------------------------------------------------

describe("gitHead", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("returns a commit hash", () => {
    const head = gitHead(tmpDir);
    assert.ok(head);
    assert.match(head, /^[a-f0-9]{40}$/);
  });

  it("returns null for non-git directory", () => {
    const noGit = makeTmpDir();
    const head = gitHead(noGit);
    assert.equal(head, null);
    cleanupTmpDir(noGit);
  });
});

// ---------------------------------------------------------------------------
// loadSpecSurface
// ---------------------------------------------------------------------------

describe("loadSpecSurface", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    const m1: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: {
        "CLAUDE.md.spec.ts": "aaaa",
        "eslint.config.mjs": "bbbb",
        "src/compile.ts": "cccc",
      },
    };
    writeSidecarManifest(tmpDir, m1);
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("loads spec files from manifests", () => {
    const surface = loadSpecSurface(tmpDir);
    assert.ok(surface.specFiles.has("CLAUDE.md.spec.ts"));
  });

  it("loads targets from manifests", () => {
    const surface = loadSpecSurface(tmpDir);
    assert.ok(surface.targets.has("CLAUDE.md"));
  });

  it("loads tracked inputs from manifests", () => {
    const surface = loadSpecSurface(tmpDir);
    assert.ok(surface.trackedInputs.has("eslint.config.mjs"));
    assert.ok(surface.trackedInputs.has("src/compile.ts"));
  });

  it("builds file-to-specs map", () => {
    const surface = loadSpecSurface(tmpDir);
    assert.deepEqual(surface.fileToSpecs.get("eslint.config.mjs"), [
      "CLAUDE.md",
    ]);
  });

  it("returns empty surface for directory without .vigiles/", () => {
    const emptyDir = makeTmpDir();
    const surface = loadSpecSurface(emptyDir);
    assert.equal(surface.manifests.length, 0);
    assert.equal(surface.trackedInputs.size, 0);
    cleanupTmpDir(emptyDir);
  });
});

// ---------------------------------------------------------------------------
// loadKeyFilesFromSpecs
// ---------------------------------------------------------------------------

describe("loadKeyFilesFromSpecs", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    // Create a sidecar manifest so we know CLAUDE.md is a target
    const m: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: { "CLAUDE.md.spec.ts": "aaaa" },
    };
    writeSidecarManifest(tmpDir, m);

    // Create a compiled CLAUDE.md with Key Files section
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      [
        "<!-- vigiles:sha256:abc compiled from CLAUDE.md.spec.ts -->",
        "",
        "# CLAUDE.md",
        "",
        "## Key Files",
        "",
        "- `src/compile.ts` — Compiler",
        "- `src/spec.ts` — Type system",
        "- `src/linters.ts` — Linter engine",
        "",
        "## Rules",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("extracts keyFiles from compiled markdown", () => {
    const keyFiles = loadKeyFilesFromSpecs(tmpDir);
    assert.ok(keyFiles.has("src/compile.ts"));
    assert.ok(keyFiles.has("src/spec.ts"));
    assert.ok(keyFiles.has("src/linters.ts"));
  });

  it("returns empty set for missing .vigiles/", () => {
    const emptyDir = makeTmpDir();
    const keyFiles = loadKeyFilesFromSpecs(emptyDir);
    assert.equal(keyFiles.size, 0);
    cleanupTmpDir(emptyDir);
  });
});

// ---------------------------------------------------------------------------
// analyzeSession
// ---------------------------------------------------------------------------

describe("analyzeSession", () => {
  let tmpDir: string;
  let baseCommit: string;

  before(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);

    // Create a sidecar manifest
    const m: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: {
        "CLAUDE.md.spec.ts": "aaaa",
        "eslint.config.mjs": "bbbb",
        "package.json": "cccc",
      },
    };
    writeSidecarManifest(tmpDir, m);

    // Create compiled output with keyFiles
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      [
        "<!-- vigiles:sha256:abc compiled from CLAUDE.md.spec.ts -->",
        "",
        "# CLAUDE.md",
        "",
        "## Key Files",
        "",
        "- `src/compile.ts` — Compiler",
        "",
      ].join("\n"),
    );

    // Create the tracked files
    writeFileSync(join(tmpDir, "eslint.config.mjs"), "export default [];");
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(tmpDir, "CLAUDE.md.spec.ts"), "export default {};");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/compile.ts"), "// compiler");

    // Commit everything as the baseline
    git(tmpDir, "add .");
    git(tmpDir, 'commit -m "setup"');
    const head = gitHead(tmpDir);
    assert.ok(head, "Expected git HEAD to exist");
    baseCommit = head;
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("reports no findings when nothing changed", () => {
    const report = analyzeSession(tmpDir, "HEAD");
    assert.equal(report.changedFiles.length, 0);
    assert.equal(report.findings.length, 0);
  });

  it("detects untracked file modifications", () => {
    writeFileSync(join(tmpDir, "src/random.ts"), "// new file");
    const report = analyzeSession(tmpDir, baseCommit);
    const untracked = report.findings.filter(
      (f) => f.type === "untracked-file",
    );
    assert.ok(untracked.some((f) => f.file === "src/random.ts"));
  });

  it("detects tracked input changes", () => {
    writeFileSync(join(tmpDir, "eslint.config.mjs"), "export default [{}];");
    const report = analyzeSession(tmpDir, baseCommit);
    const stale = report.findings.filter((f) => f.type === "stale-spec");
    assert.ok(stale.some((f) => f.file === "eslint.config.mjs"));
    assert.ok(
      stale[0].type !== "untracked-file" &&
        stale[0].specs.includes("CLAUDE.md"),
    );
  });

  it("detects direct edits to compiled output", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# hand-edited");
    const report = analyzeSession(tmpDir, baseCommit);
    const targetMods = report.findings.filter(
      (f) => f.type === "target-modified",
    );
    assert.ok(targetMods.some((f) => f.file === "CLAUDE.md"));
  });

  it("detects spec modifications", () => {
    writeFileSync(
      join(tmpDir, "CLAUDE.md.spec.ts"),
      "export default { rules: {} };",
    );
    const report = analyzeSession(tmpDir, baseCommit);
    const specMods = report.findings.filter((f) => f.type === "spec-modified");
    assert.ok(specMods.some((f) => f.file === "CLAUDE.md.spec.ts"));
  });

  it("ignores lock files and dist/", () => {
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(join(tmpDir, "dist/index.js"), "// built");
    const report = analyzeSession(tmpDir, baseCommit);
    const untracked = report.findings.filter(
      (f) => f.type === "untracked-file",
    );
    assert.ok(!untracked.some((f) => f.file === "package-lock.json"));
    assert.ok(!untracked.some((f) => f.file === "dist/index.js"));
  });
});

// ---------------------------------------------------------------------------
// formatSessionReport
// ---------------------------------------------------------------------------

describe("formatSessionReport", () => {
  it("reports no changes", () => {
    const output = formatSessionReport({
      baseRef: "HEAD",
      changedFiles: [],
      trackedChanges: [],
      untrackedChanges: [],
      findings: [],
    });
    assert.ok(output.includes("No changes detected"));
  });

  it("formats untracked files", () => {
    const output = formatSessionReport({
      baseRef: "abc123",
      changedFiles: ["src/random.ts"],
      trackedChanges: [],
      untrackedChanges: ["src/random.ts"],
      findings: [
        {
          type: "untracked-file",
          file: "src/random.ts",
          message: "Modified file not tracked by any spec",
        },
      ],
    });
    assert.ok(output.includes("src/random.ts"));
    assert.ok(output.includes("not tracked"));
  });

  it("formats stale specs", () => {
    const output = formatSessionReport({
      baseRef: "abc123",
      changedFiles: ["eslint.config.mjs"],
      trackedChanges: ["eslint.config.mjs"],
      untrackedChanges: [],
      findings: [
        {
          type: "stale-spec",
          file: "eslint.config.mjs",
          message: "Tracked input changed",
          specs: ["CLAUDE.md"],
        },
      ],
    });
    assert.ok(output.includes("eslint.config.mjs"));
    assert.ok(output.includes("CLAUDE.md"));
  });

  it("includes summary line", () => {
    const output = formatSessionReport({
      baseRef: "HEAD",
      changedFiles: ["a.ts", "b.ts"],
      trackedChanges: ["a.ts"],
      untrackedChanges: ["b.ts"],
      findings: [
        {
          type: "stale-spec",
          file: "a.ts",
          message: "changed",
          specs: ["X.md"],
        },
        {
          type: "untracked-file",
          file: "b.ts",
          message: "untracked",
        },
      ],
    });
    assert.ok(output.includes("Summary:"));
  });
});
