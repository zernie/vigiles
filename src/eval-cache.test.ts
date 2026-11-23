/**
 * Tests for the eval record/replay cache (src/eval-cache.ts) — the pure key,
 * record I/O, and filesystem snapshot/restore. Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  cacheKey,
  readCache,
  writeCache,
  snapshotDir,
  restoreDir,
  hashDir,
  CACHE_FORMAT_VERSION,
  type CacheKeyInput,
} from "./eval-cache.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const baseKey: CacheKeyInput = {
  task: "do it",
  model: "haiku",
  tools: ["Read", "Edit"],
  files: { "a.txt": "x" },
  settings: { hooks: {} },
  trialIndex: 0,
};

test("cacheKey is stable and order-independent for object inputs", () => {
  const k1 = cacheKey(baseKey);
  // same logical input, object keys in a different order → same key
  const k2 = cacheKey({
    trialIndex: 0,
    settings: { hooks: {} },
    files: { "a.txt": "x" },
    tools: ["Read", "Edit"],
    model: "haiku",
    task: "do it",
  });
  assert.equal(k1, k2);
});

test("cacheKey changes when ANY key part changes (every field + version axes)", () => {
  // Codex on #479: the per-run cap ends a turn early, so it is a model input.
  assert.notEqual(
    cacheKey(baseKey),
    cacheKey({ ...baseKey, maxBudgetUsd: 0.5 }),
  );
  const base = cacheKey(baseKey);
  // one assertion per CacheKeyInput field — a regression that drops a field from
  // the key surfaces here.
  assert.notEqual(base, cacheKey({ ...baseKey, trialIndex: 1 }), "trialIndex");
  assert.notEqual(base, cacheKey({ ...baseKey, task: "other" }), "task");
  assert.notEqual(
    base,
    cacheKey({ ...baseKey, files: { "a.txt": "y" } }),
    "files",
  );
  assert.notEqual(
    base,
    cacheKey({ ...baseKey, settings: { hooks: { a: 1 } } }),
    "settings",
  );
  assert.notEqual(base, cacheKey({ ...baseKey, env: { X: "1" } }), "env");
  assert.notEqual(
    base,
    cacheKey({ ...baseKey, pluginDirHash: "abcd" }),
    "pluginDirHash",
  );
  assert.notEqual(base, cacheKey({ ...baseKey, tools: ["Read"] }), "tool set");

  // Version axes — different VERSIONS of the model and the harness must each
  // produce a different key (a stale replay across either would be wrong):
  assert.notEqual(
    base,
    cacheKey({ ...baseKey, model: "opus" }),
    "model family",
  );
  assert.notEqual(
    cacheKey({ ...baseKey, model: "claude-sonnet-4-6" }),
    cacheKey({ ...baseKey, model: "claude-sonnet-4-5-20250101" }),
    "model snapshot version",
  );
  assert.notEqual(
    cacheKey({ ...baseKey, harnessVersion: "2.1" }),
    cacheKey({ ...baseKey, harnessVersion: "2.2" }),
    "harness minor version",
  );
});

test("cacheKey treats the tool list as a SET (order-insensitive)", () => {
  // logically a set — ["Read","Edit"] and ["Edit","Read"] must hash the same,
  // or you get phantom cache misses on a reordered allowlist.
  assert.equal(
    cacheKey({ ...baseKey, tools: ["Read", "Edit"] }),
    cacheKey({ ...baseKey, tools: ["Edit", "Read"] }),
  );
});

test("cacheKey EXCLUDES the throwaway ephemeral HOME/TMPDIR (per-run noise)", () => {
  // The opt-in ephemeral run env points HOME/TMPDIR at a fresh random dir every
  // run; folding them into the key would make every run unique → the cache could
  // NEVER hit. Two inputs differing ONLY in HOME/TMPDIR must hash the same.
  const a = cacheKey({
    ...baseKey,
    env: { HOME: "/tmp/home-aaaa", TMPDIR: "/tmp/home-aaaa" },
  });
  const b = cacheKey({
    ...baseKey,
    env: { HOME: "/tmp/home-bbbb", TMPDIR: "/tmp/home-bbbb" },
  });
  assert.equal(a, b, "HOME/TMPDIR are per-run noise, excluded from the key");
  // And an env that is ONLY HOME/TMPDIR keys identically to no env at all (the
  // residual is empty → undefined), so a non-ephemeral run's key is unchanged.
  assert.equal(a, cacheKey(baseKey));
});

test("cacheKey env exclusion is SURGICAL — a real model-affecting var still differs", () => {
  // Excluding HOME/TMPDIR must not become a blanket env drop: an intercept config
  // (or any other model-affecting var) alongside the throwaway HOME still partitions.
  const a = cacheKey({
    ...baseKey,
    env: { HOME: "/tmp/home-aaaa", VIGILES_INTERCEPT_TOOLS: "Bash" },
  });
  const b = cacheKey({
    ...baseKey,
    env: { HOME: "/tmp/home-bbbb", VIGILES_INTERCEPT_TOOLS: "Read" },
  });
  assert.notEqual(a, b, "the model-affecting var must still change the key");
});

test("cacheKey keys on pluginDirHash (a native --plugin-dir's contents)", () => {
  const none = cacheKey(baseKey);
  const h1 = cacheKey({ ...baseKey, pluginDirHash: "aaaa" });
  const h2 = cacheKey({ ...baseKey, pluginDirHash: "bbbb" });
  assert.notEqual(none, h1); // adding a plugin dir changes the key
  assert.notEqual(h1, h2); // a different dir digest changes it
});

test("CACHE_FORMAT_VERSION is a salted integer", () => {
  assert.equal(typeof CACHE_FORMAT_VERSION, "number");
});

test("hashDir digests content, sensitive to edit/add, path-aware, skips junk dirs", () => {
  const dir = makeTmpDir("plugin");
  mkdirSync(join(dir, "skills", "foo"), { recursive: true });
  writeFileSync(join(dir, "skills", "foo", "SKILL.md"), "body");
  const h1 = hashDir(dir);
  assert.equal(hashDir(dir), h1); // stable: same content → same hash

  writeFileSync(join(dir, "skills", "foo", "SKILL.md"), "body changed");
  const h2 = hashDir(dir);
  assert.notEqual(h1, h2); // edit → different

  writeFileSync(join(dir, "skills", "foo", "extra.md"), "x");
  assert.notEqual(h2, hashDir(dir)); // add → different

  // node_modules / .git are skipped — adding one doesn't change the digest
  const h3 = hashDir(dir);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "junk.js"), "lots");
  assert.equal(hashDir(dir), h3);

  // path-aware: same content at a different path → different digest
  writeFileSync(join(dir, "skills", "foo", "renamed.md"), "x");
  rmSync(join(dir, "skills", "foo", "extra.md"));
  assert.notEqual(hashDir(dir), h3);
  cleanupTmpDir(dir);
});

test("readCache returns null on a miss but THROWS on a corrupt record", () => {
  const dir = makeTmpDir("cache");
  try {
    const key = cacheKey(baseKey);
    assert.equal(readCache(dir, key), null); // miss — normal, run proceeds
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), "{ not json");
    // a broken cassette must fail loud, not silently re-run (CI gate surfaces it)
    assert.throws(() => readCache(dir, key), /corrupt record/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("writeCache then readCache round-trips a record", () => {
  const dir = makeTmpDir("cache");
  try {
    const key = cacheKey(baseKey);
    const record = {
      out: { code: 0, stdout: "stream" },
      files: { "OUT.txt": "result" },
    };
    writeCache(dir, key, record);
    const got = readCache(dir, key);
    assert.deepEqual(got, record);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("snapshotDir captures nested text files; restoreDir rebuilds them", () => {
  const src = makeTmpDir("snap-src");
  const dst = makeTmpDir("snap-dst");
  try {
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "top.txt"), "top");
    writeFileSync(join(src, "sub", "deep.txt"), "deep");
    // node_modules is skipped
    mkdirSync(join(src, "node_modules"), { recursive: true });
    writeFileSync(join(src, "node_modules", "skip.txt"), "skip");

    const snap = snapshotDir(src);
    assert.equal(snap["top.txt"], "top");
    assert.equal(snap[join("sub", "deep.txt")], "deep");
    assert.ok(
      !(join("node_modules", "skip.txt") in snap),
      "node_modules skipped",
    );

    restoreDir(dst, snap);
    assert.ok(existsSync(join(dst, "top.txt")));
    assert.ok(existsSync(join(dst, "sub", "deep.txt")));
  } finally {
    cleanupTmpDir(src);
    cleanupTmpDir(dst);
  }
});
