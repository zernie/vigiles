import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  computePerFileHashes,
  writeSidecarManifest,
  readSidecarManifest,
  iterateSidecars,
  sidecarPath,
} from "./sidecar.js";
import type { SidecarManifest } from "./sidecar.js";
import { makeTmpDir, cleanupTmpDir } from "./test-utils.js";

describe("computePerFileHashes", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "a.txt"), "alpha");
    writeFileSync(join(tmpDir, "b.txt"), "beta");
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("computes a hash for each file present", () => {
    const hashes = computePerFileHashes(["a.txt", "b.txt"], tmpDir);
    assert.match(hashes["a.txt"], /^[a-f0-9]{16}$/);
    assert.match(hashes["b.txt"], /^[a-f0-9]{16}$/);
    assert.notEqual(hashes["a.txt"], hashes["b.txt"]);
  });

  it("marks missing files as MISSING", () => {
    const hashes = computePerFileHashes(["a.txt", "missing.txt"], tmpDir);
    assert.equal(hashes["missing.txt"], "MISSING");
  });

  it("is deterministic for identical content", () => {
    writeFileSync(join(tmpDir, "c.txt"), "alpha");
    const hashes = computePerFileHashes(["a.txt", "c.txt"], tmpDir);
    assert.equal(hashes["a.txt"], hashes["c.txt"]);
  });
});

describe("sidecar manifests", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("sidecarPath uses .vigiles/<target>.inputs.json", () => {
    const p = sidecarPath(tmpDir, "CLAUDE.md");
    assert.ok(p.endsWith(".vigiles/CLAUDE.md.inputs.json"));
  });

  it("write then read round-trips", () => {
    const m: SidecarManifest = {
      specFile: "CLAUDE.md.spec.ts",
      target: "CLAUDE.md",
      compiledAt: new Date().toISOString(),
      files: { "CLAUDE.md.spec.ts": "abc123" },
    };
    writeSidecarManifest(tmpDir, m);
    const read = readSidecarManifest(tmpDir, "CLAUDE.md");
    assert.deepEqual(read, m);
  });

  it("returns null when manifest is missing", () => {
    assert.equal(readSidecarManifest(tmpDir, "DoesNotExist.md"), null);
  });

  it("returns null when manifest is malformed JSON", () => {
    mkdirSync(join(tmpDir, ".vigiles"), { recursive: true });
    writeFileSync(join(tmpDir, ".vigiles", "BAD.md.inputs.json"), "not json");
    assert.equal(readSidecarManifest(tmpDir, "BAD.md"), null);
  });
});

describe("iterateSidecars", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir();
    writeSidecarManifest(tmpDir, {
      specFile: "A.md.spec.ts",
      target: "A.md",
      compiledAt: new Date().toISOString(),
      files: { "A.md.spec.ts": "aaaa" },
    });
    writeSidecarManifest(tmpDir, {
      specFile: "B.md.spec.ts",
      target: "B.md",
      compiledAt: new Date().toISOString(),
      files: { "B.md.spec.ts": "bbbb" },
    });
  });

  after(() => {
    cleanupTmpDir(tmpDir);
  });

  it("calls fn once per manifest", () => {
    const seen: string[] = [];
    iterateSidecars(tmpDir, (target) => seen.push(target));
    assert.deepEqual(seen.sort(), ["A.md", "B.md"]);
  });

  it("does nothing when .vigiles/ does not exist", () => {
    const empty = makeTmpDir();
    let count = 0;
    iterateSidecars(empty, () => count++);
    assert.equal(count, 0);
    cleanupTmpDir(empty);
  });
});

describe("checkIntegrity", () => {
  it("treats files without hash as intact (hand-written)", async () => {
    const { checkIntegrity } = await import("./integrity.js");
    const result = checkIntegrity("# Hand-written file\n");
    assert.equal(result.intact, true);
  });

  it("detects valid hash", async () => {
    const { checkIntegrity } = await import("./integrity.js");
    const { addHash } = await import("./compile.js");
    const content = addHash("# Content\n", "test.spec.ts");
    const result = checkIntegrity(content);
    assert.equal(result.intact, true);
  });

  it("detects tampering", async () => {
    const { checkIntegrity } = await import("./integrity.js");
    const { addHash } = await import("./compile.js");
    const content = addHash("# Original\n", "test.spec.ts");
    const tampered = content.replace("# Original", "# Tampered");
    const result = checkIntegrity(tampered);
    assert.equal(result.intact, false);
  });
});
