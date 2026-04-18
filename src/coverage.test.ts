import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  readNpmScripts,
  collectDocumentedCommands,
  computeScriptCoverage,
  computeLinterRuleCoverage,
  checkCoverage,
  formatCoverageReport,
} from "./coverage.js";
import type { ClaudeSpec } from "./spec.js";
import { makeTmpDir, cleanupTmpDir, makeSpec } from "./test-utils.js";

// ---------------------------------------------------------------------------
// readNpmScripts
// ---------------------------------------------------------------------------

describe("readNpmScripts", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    cleanupTmpDir(tmpDir);
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
  it("extracts commands from spec objects", () => {
    const specs: ClaudeSpec[] = [
      makeSpec({
        commands: {
          "npm run build": "Compile",
          "npm test": "Test",
          "npm run fmt": "Format",
        },
      }),
    ];
    const commands = collectDocumentedCommands(".", specs);
    assert.ok(commands.has("npm run build"));
    assert.ok(commands.has("npm test"));
    assert.ok(commands.has("npm run fmt"));
  });

  it("merges commands from multiple specs", () => {
    const specs: ClaudeSpec[] = [
      makeSpec({ commands: { "npm test": "Test" } }),
      makeSpec({ commands: { "npm run build": "Build" } }),
    ];
    const commands = collectDocumentedCommands(".", specs);
    assert.ok(commands.has("npm test"));
    assert.ok(commands.has("npm run build"));
  });

  it("returns empty set for specs without commands", () => {
    const specs: ClaudeSpec[] = [makeSpec()];
    const commands = collectDocumentedCommands(".", specs);
    assert.equal(commands.size, 0);
  });

  it("returns empty set when no specs provided and no compiled files", () => {
    const emptyDir = makeTmpDir();
    const commands = collectDocumentedCommands(emptyDir);
    assert.equal(commands.size, 0);
    cleanupTmpDir(emptyDir);
  });
});

// ---------------------------------------------------------------------------
// computeScriptCoverage
// ---------------------------------------------------------------------------

describe("computeScriptCoverage", () => {
  let tmpDir: string;
  const specs: ClaudeSpec[] = [
    makeSpec({
      commands: {
        "npm run build": "Compile",
        "npm test": "Test",
        "npm run fmt": "Format",
      },
    }),
  ];

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
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("computes correct coverage", () => {
    const metric = computeScriptCoverage(tmpDir, undefined, specs);
    assert.equal(metric.total, 5);
    assert.equal(metric.covered, 3); // build, test, fmt
    assert.equal(metric.percent, 60);
  });

  it("reports uncovered scripts", () => {
    const metric = computeScriptCoverage(tmpDir, undefined, specs);
    assert.ok(metric.uncoveredItems.includes("lint"));
    assert.ok(metric.uncoveredItems.includes("deploy"));
  });

  it("passes when no threshold set", () => {
    const metric = computeScriptCoverage(tmpDir, undefined, specs);
    assert.equal(metric.passing, true);
  });

  it("passes when above threshold", () => {
    const metric = computeScriptCoverage(tmpDir, 50, specs);
    assert.equal(metric.passing, true);
  });

  it("fails when below threshold", () => {
    const metric = computeScriptCoverage(tmpDir, 80, specs);
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
  const checkSpecs: ClaudeSpec[] = [
    makeSpec({ commands: { "npm test": "Test" } }),
  ];

  before(() => {
    tmpDir = makeTmpDir();
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "jest", build: "tsc" } }),
    );
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("reports passing when all thresholds met", () => {
    const report = checkCoverage(
      tmpDir,
      { scripts: 40, linterRules: 0 },
      10,
      5,
      checkSpecs,
    );
    assert.equal(report.passing, true);
  });

  it("reports failing when any threshold not met", () => {
    const report = checkCoverage(
      tmpDir,
      { scripts: 100, linterRules: 0 },
      10,
      5,
      checkSpecs,
    );
    assert.equal(report.passing, false);
  });

  it("passes with no thresholds", () => {
    const report = checkCoverage(tmpDir, {}, 10, 5, checkSpecs);
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
