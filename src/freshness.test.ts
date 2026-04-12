import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHash } from "node:crypto";

import {
  detectLockFiles,
  detectLinterConfigs,
  discoverInputs,
  computeInputHash,
  addInputHash,
  extractInputHash,
  checkOutputHashFreshness,
  checkInputHashFreshness,
} from "./freshness.js";
import type { ClaudeSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "vigiles-freshness-"));
}

function makeSpec(overrides?: Partial<ClaudeSpec>): ClaudeSpec {
  return {
    _specType: "claude",
    rules: {},
    ...overrides,
  } as ClaudeSpec;
}

// ---------------------------------------------------------------------------
// detectLockFiles
// ---------------------------------------------------------------------------

describe("detectLockFiles", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no lock files exist", () => {
    const result = detectLockFiles(tmpDir);
    assert.deepEqual(result, []);
  });

  it("detects package-lock.json", () => {
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("package-lock.json"));
  });

  it("detects yarn.lock", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("yarn.lock"));
  });

  it("detects pnpm-lock.yaml", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("pnpm-lock.yaml"));
  });

  it("detects bun.lockb", () => {
    writeFileSync(join(tmpDir, "bun.lockb"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("bun.lockb"));
  });

  it("detects Gemfile.lock", () => {
    writeFileSync(join(tmpDir, "Gemfile.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("Gemfile.lock"));
  });

  it("detects poetry.lock", () => {
    writeFileSync(join(tmpDir, "poetry.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("poetry.lock"));
  });

  it("detects uv.lock", () => {
    writeFileSync(join(tmpDir, "uv.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("uv.lock"));
  });

  it("detects pdm.lock", () => {
    writeFileSync(join(tmpDir, "pdm.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("pdm.lock"));
  });

  it("detects Cargo.lock", () => {
    writeFileSync(join(tmpDir, "Cargo.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("Cargo.lock"));
  });

  it("detects go.sum", () => {
    writeFileSync(join(tmpDir, "go.sum"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("go.sum"));
  });

  it("detects composer.lock", () => {
    writeFileSync(join(tmpDir, "composer.lock"), "{}");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("composer.lock"));
  });

  it("detects packages.lock.json (.NET)", () => {
    writeFileSync(join(tmpDir, "packages.lock.json"), "{}");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("packages.lock.json"));
  });

  it("detects Package.resolved (Swift)", () => {
    writeFileSync(join(tmpDir, "Package.resolved"), "{}");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("Package.resolved"));
  });

  it("detects mix.lock (Elixir)", () => {
    writeFileSync(join(tmpDir, "mix.lock"), "");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("mix.lock"));
  });

  it("detects requirements.txt", () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0");
    const result = detectLockFiles(tmpDir);
    assert.ok(result.includes("requirements.txt"));
  });

  it("returns multiple lock files for polyglot projects", () => {
    // tmpDir already has all the above files
    const result = detectLockFiles(tmpDir);
    assert.ok(
      result.length > 5,
      `Expected many lock files, got ${result.length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// detectLinterConfigs
// ---------------------------------------------------------------------------

describe("detectLinterConfigs", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no configs exist", () => {
    const result = detectLinterConfigs(tmpDir);
    assert.deepEqual(result, []);
  });

  it("detects eslint.config.mjs", () => {
    writeFileSync(join(tmpDir, "eslint.config.mjs"), "export default [];");
    const result = detectLinterConfigs(tmpDir);
    assert.ok(result.includes("eslint.config.mjs"));
  });

  it("detects .rubocop.yml", () => {
    writeFileSync(join(tmpDir, ".rubocop.yml"), "---");
    const result = detectLinterConfigs(tmpDir);
    assert.ok(result.includes(".rubocop.yml"));
  });

  it("detects pyproject.toml", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "[tool.ruff]");
    const result = detectLinterConfigs(tmpDir);
    assert.ok(result.includes("pyproject.toml"));
  });

  it("detects .pylintrc", () => {
    writeFileSync(join(tmpDir, ".pylintrc"), "[MAIN]");
    const result = detectLinterConfigs(tmpDir);
    assert.ok(result.includes(".pylintrc"));
  });

  it("detects Cargo.toml", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]");
    const result = detectLinterConfigs(tmpDir);
    assert.ok(result.includes("Cargo.toml"));
  });
});

// ---------------------------------------------------------------------------
// discoverInputs
// ---------------------------------------------------------------------------

describe("discoverInputs", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "CLAUDE.md.spec.ts"), "export default {};");
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: {} }),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("always includes the spec file", () => {
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    assert.ok(result.files.includes("CLAUDE.md.spec.ts"));
  });

  it("includes package.json when present", () => {
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    assert.ok(result.files.includes("package.json"));
  });

  it("includes keyFiles from spec", () => {
    const spec = makeSpec({
      keyFiles: { "src/index.ts": "Entry point" },
    });
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    assert.ok(result.files.includes("src/index.ts"));
  });

  it("includes extra configured inputs", () => {
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir, [
      "../../yarn.lock",
    ]);
    assert.ok(result.files.includes("../../yarn.lock"));
  });

  it("includes detected linter configs", () => {
    writeFileSync(join(tmpDir, "eslint.config.mjs"), "export default [];");
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    assert.ok(result.files.includes("eslint.config.mjs"));
    assert.ok(result.linterConfigs.includes("eslint.config.mjs"));
  });

  it("includes detected lock files", () => {
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    assert.ok(result.files.includes("package-lock.json"));
    assert.ok(result.lockFiles.includes("package-lock.json"));
  });

  it("includes .vigiles/generated.d.ts when present", () => {
    mkdirSync(join(tmpDir, ".vigiles"), { recursive: true });
    writeFileSync(join(tmpDir, ".vigiles/generated.d.ts"), "// types");
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    assert.ok(result.files.includes(".vigiles/generated.d.ts"));
  });

  it("returns sorted file list", () => {
    const spec = makeSpec();
    const result = discoverInputs("CLAUDE.md.spec.ts", spec, tmpDir);
    const sorted = [...result.files].sort();
    assert.deepEqual(result.files, sorted);
  });
});

// ---------------------------------------------------------------------------
// computeInputHash
// ---------------------------------------------------------------------------

describe("computeInputHash", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "hello");
    writeFileSync(join(tmpDir, "b.txt"), "world");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a 16-char hex string", () => {
    const hash = computeInputHash(["a.txt", "b.txt"], tmpDir);
    assert.match(hash, /^[a-f0-9]{16}$/);
  });

  it("returns same hash for same inputs", () => {
    const h1 = computeInputHash(["a.txt", "b.txt"], tmpDir);
    const h2 = computeInputHash(["a.txt", "b.txt"], tmpDir);
    assert.equal(h1, h2);
  });

  it("changes when file content changes", () => {
    const h1 = computeInputHash(["a.txt"], tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "changed");
    const h2 = computeInputHash(["a.txt"], tmpDir);
    assert.notEqual(h1, h2);
  });

  it("changes when a file is deleted", () => {
    writeFileSync(join(tmpDir, "c.txt"), "temp");
    const h1 = computeInputHash(["c.txt"], tmpDir);
    rmSync(join(tmpDir, "c.txt"));
    const h2 = computeInputHash(["c.txt"], tmpDir);
    assert.notEqual(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// addInputHash / extractInputHash
// ---------------------------------------------------------------------------

describe("addInputHash / extractInputHash", () => {
  it("embeds hash after sha256 comment", () => {
    const md =
      "<!-- vigiles:sha256:abc123 compiled from X.spec.ts -->\n\n# Doc\n";
    const result = addInputHash(md, "deadbeef12345678");
    assert.ok(result.includes("<!-- vigiles:inputs:deadbeef12345678 -->"));
    // sha256 line should still be first
    assert.ok(result.startsWith("<!-- vigiles:sha256:"));
  });

  it("extracts embedded input hash", () => {
    const md =
      "<!-- vigiles:sha256:abc123 compiled from X.spec.ts -->\n<!-- vigiles:inputs:deadbeef12345678 -->\n\n# Doc\n";
    const hash = extractInputHash(md);
    assert.equal(hash, "deadbeef12345678");
  });

  it("returns null when no input hash present", () => {
    const md =
      "<!-- vigiles:sha256:abc123 compiled from X.spec.ts -->\n\n# Doc\n";
    const hash = extractInputHash(md);
    assert.equal(hash, null);
  });
});

// ---------------------------------------------------------------------------
// checkOutputHashFreshness
// ---------------------------------------------------------------------------

describe("checkOutputHashFreshness", () => {
  it("returns fresh for hand-written file (no hash)", () => {
    const result = checkOutputHashFreshness("# CLAUDE.md\n\nSome content.\n");
    assert.equal(result.fresh, true);
    assert.equal(result.mode, "output-hash");
  });

  it("returns fresh when hash matches", () => {
    // Build a valid hashed file
    const body = "# CLAUDE.md\n\nContent.\n";
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const content = `<!-- vigiles:sha256:${hash} compiled from CLAUDE.md.spec.ts -->\n\n${body}`;
    const result = checkOutputHashFreshness(content);
    assert.equal(result.fresh, true);
  });

  it("returns stale when hash mismatches", () => {
    const content =
      "<!-- vigiles:sha256:0000000000000000 compiled from CLAUDE.md.spec.ts -->\n\n# CLAUDE.md\n\nEdited.\n";
    const result = checkOutputHashFreshness(content);
    assert.equal(result.fresh, false);
    assert.equal(result.mode, "output-hash");
  });
});

// ---------------------------------------------------------------------------
// checkInputHashFreshness
// ---------------------------------------------------------------------------

describe("checkInputHashFreshness", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "spec.ts"), "export default {};");
    writeFileSync(join(tmpDir, "config.js"), "module.exports = {};");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns stale when no input hash is stored", () => {
    const content =
      "<!-- vigiles:sha256:abc compiled from spec.ts -->\n\n# Doc\n";
    const result = checkInputHashFreshness(content, ["spec.ts"], tmpDir);
    assert.equal(result.fresh, false);
    assert.equal(result.mode, "input-hash");
  });

  it("returns fresh when input hash matches", () => {
    const files = ["spec.ts", "config.js"];
    const hash = computeInputHash(files, tmpDir);
    const content = `<!-- vigiles:sha256:abc compiled from spec.ts -->\n<!-- vigiles:inputs:${hash} -->\n\n# Doc\n`;
    const result = checkInputHashFreshness(content, files, tmpDir);
    assert.equal(result.fresh, true);
  });

  it("returns stale when input file changes", () => {
    const files = ["spec.ts", "config.js"];
    const hash = computeInputHash(files, tmpDir);
    const content = `<!-- vigiles:sha256:abc compiled from spec.ts -->\n<!-- vigiles:inputs:${hash} -->\n\n# Doc\n`;

    // Change an input file
    writeFileSync(
      join(tmpDir, "config.js"),
      "module.exports = { changed: true };",
    );

    const result = checkInputHashFreshness(content, files, tmpDir);
    assert.equal(result.fresh, false);
  });

  it("reports deleted files", () => {
    writeFileSync(join(tmpDir, "temp.txt"), "exists");
    const files = ["spec.ts", "temp.txt"];
    const hash = computeInputHash(files, tmpDir);
    const content = `<!-- vigiles:sha256:abc compiled from spec.ts -->\n<!-- vigiles:inputs:${hash} -->\n\n# Doc\n`;

    rmSync(join(tmpDir, "temp.txt"));
    const result = checkInputHashFreshness(content, files, tmpDir);
    assert.equal(result.fresh, false);
    assert.ok(result.changedFiles?.some((f) => f.includes("temp.txt")));
  });
});
