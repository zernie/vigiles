import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readNpmScripts,
  collectDocumentedCommands,
  computeScriptCoverage,
  computeLinterRuleCoverage,
  checkCoverage,
  formatCoverageReport,
} from "./coverage.js";
import { writeSidecarManifest } from "./freshness.js";
import type { SidecarManifest } from "./freshness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vigiles-coverage-"));
}

// ---------------------------------------------------------------------------
// readNpmScripts
// ---------------------------------------------------------------------------

describe("readNpmScripts", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no package.json", () => {
    assert.deepEqual(readNpmScripts(tmpDir), []);
  });

  it("returns sorted script names", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { test: "jest", build: "tsc", lint: "eslint ." },
      }),
    );
    const scripts = readNpmScripts(tmpDir);
    assert.deepEqual(scripts, ["build", "lint", "test"]);
  });

  it("returns empty array for package.json without scripts", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    assert.deepEqual(readNpmScripts(tmpDir), []);
  });
});

// ---------------------------------------------------------------------------
// collectDocumentedCommands
// ---------------------------------------------------------------------------

describe("collectDocumentedCommands", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    const m: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: {},
    };
    writeSidecarManifest(tmpDir, m);

    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      [
        "<!-- vigiles:sha256:abc compiled from CLAUDE.md.spec.ts -->",
        "",
        "# CLAUDE.md",
        "",
        "## Commands",
        "",
        "- `npm run build` — Compile TypeScript",
        "- `npm test` — Run tests",
        "- `npm run fmt` — Format code",
        "",
        "## Rules",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts commands from compiled markdown", () => {
    const commands = collectDocumentedCommands(tmpDir);
    assert.ok(commands.has("npm run build"));
    assert.ok(commands.has("npm test"));
    assert.ok(commands.has("npm run fmt"));
  });

  it("returns empty set for missing .vigiles/", () => {
    const emptyDir = makeTmpDir();
    const commands = collectDocumentedCommands(emptyDir);
    assert.equal(commands.size, 0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// computeScriptCoverage
// ---------------------------------------------------------------------------

describe("computeScriptCoverage", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();

    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          build: "tsc",
          test: "jest",
          lint: "eslint .",
          fmt: "prettier --write .",
          deploy: "deploy.sh",
        },
      }),
    );

    const m: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: {},
    };
    writeSidecarManifest(tmpDir, m);

    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      [
        "<!-- vigiles:sha256:abc compiled from CLAUDE.md.spec.ts -->",
        "",
        "# CLAUDE.md",
        "",
        "## Commands",
        "",
        "- `npm run build` — Compile",
        "- `npm test` — Test",
        "- `npm run fmt` — Format",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes correct coverage", () => {
    const metric = computeScriptCoverage(tmpDir);
    assert.equal(metric.total, 5);
    assert.equal(metric.covered, 3); // build, test, fmt
    assert.equal(metric.percent, 60);
  });

  it("reports uncovered scripts", () => {
    const metric = computeScriptCoverage(tmpDir);
    assert.ok(metric.uncoveredItems.includes("lint"));
    assert.ok(metric.uncoveredItems.includes("deploy"));
  });

  it("passes when no threshold set", () => {
    const metric = computeScriptCoverage(tmpDir);
    assert.equal(metric.passing, true);
  });

  it("passes when above threshold", () => {
    const metric = computeScriptCoverage(tmpDir, 50);
    assert.equal(metric.passing, true);
  });

  it("fails when below threshold", () => {
    const metric = computeScriptCoverage(tmpDir, 80);
    assert.equal(metric.passing, false);
  });
});

// ---------------------------------------------------------------------------
// computeLinterRuleCoverage
// ---------------------------------------------------------------------------

describe("computeLinterRuleCoverage", () => {
  it("computes correct percentage", () => {
    const metric = computeLinterRuleCoverage(100, 30);
    assert.equal(metric.percent, 30);
  });

  it("returns 100% for zero enabled rules", () => {
    const metric = computeLinterRuleCoverage(0, 0);
    assert.equal(metric.percent, 100);
  });

  it("passes when no threshold set", () => {
    const metric = computeLinterRuleCoverage(100, 10);
    assert.equal(metric.passing, true);
  });

  it("passes when above threshold", () => {
    const metric = computeLinterRuleCoverage(100, 30, 20);
    assert.equal(metric.passing, true);
  });

  it("fails when below threshold", () => {
    const metric = computeLinterRuleCoverage(100, 10, 20);
    assert.equal(metric.passing, false);
  });
});

// ---------------------------------------------------------------------------
// checkCoverage
// ---------------------------------------------------------------------------

describe("checkCoverage", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "jest", build: "tsc" } }),
    );
    const m: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: {},
    };
    writeSidecarManifest(tmpDir, m);
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      [
        "<!-- vigiles:sha256:abc compiled from CLAUDE.md.spec.ts -->",
        "",
        "# CLAUDE.md",
        "",
        "## Commands",
        "",
        "- `npm test` — Test",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports passing when all thresholds met", () => {
    const report = checkCoverage(
      tmpDir,
      { scripts: 40, linterRules: 0 },
      10,
      5,
    );
    assert.equal(report.passing, true);
  });

  it("reports failing when any threshold not met", () => {
    const report = checkCoverage(
      tmpDir,
      { scripts: 100, linterRules: 0 },
      10,
      5,
    );
    assert.equal(report.passing, false);
  });

  it("passes with no thresholds", () => {
    const report = checkCoverage(tmpDir, {}, 10, 5);
    assert.equal(report.passing, true);
  });
});

// ---------------------------------------------------------------------------
// formatCoverageReport
// ---------------------------------------------------------------------------

describe("formatCoverageReport", () => {
  it("shows passing metrics with checkmark", () => {
    const output = formatCoverageReport({
      passing: true,
      metrics: [
        {
          name: "scripts",
          total: 5,
          covered: 4,
          percent: 80,
          threshold: 50,
          passing: true,
          coveredItems: [],
          uncoveredItems: ["deploy"],
        },
      ],
    });
    assert.ok(output.includes("✓"));
    assert.ok(output.includes("80%"));
    assert.ok(output.includes("threshold: 50%"));
  });

  it("shows failing metrics with cross and uncovered items", () => {
    const output = formatCoverageReport({
      passing: false,
      metrics: [
        {
          name: "scripts",
          total: 5,
          covered: 1,
          percent: 20,
          threshold: 50,
          passing: false,
          coveredItems: ["test"],
          uncoveredItems: ["build", "lint", "deploy", "fmt"],
        },
      ],
    });
    assert.ok(output.includes("✗"));
    assert.ok(output.includes("missing: build"));
  });

  it("shows no status marker when no threshold", () => {
    const output = formatCoverageReport({
      passing: true,
      metrics: [
        {
          name: "linterRules",
          total: 50,
          covered: 10,
          percent: 20,
          threshold: undefined,
          passing: true,
          coveredItems: [],
          uncoveredItems: [],
        },
      ],
    });
    assert.ok(!output.includes("✓"));
    assert.ok(!output.includes("✗"));
    assert.ok(output.includes("20%"));
  });
});
