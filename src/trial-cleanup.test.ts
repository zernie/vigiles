/**
 * `removeTrialDirs` is the cleanup of every trial that ran an agent. What it
 * proves: one dir that will not go is named in one warning and does not stop
 * the next dir, and nothing throws (a throw from a trial's `finally` replaces
 * the score already computed, which is the bug of #626).
 */
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { makeTmpDir, removeTree } from "./core/tmp-root.js";
import { removeTrialDirs } from "./trial-cleanup.js";

test("a dir that will not go is warned about once, and the next dir is still removed", () => {
  const next = makeTmpDir("trial-cleanup");
  const warnings: string[] = [];
  const removals = removeTrialDirs([join(next, "stuck"), undefined, next], {
    remove: (dir) =>
      dir.endsWith("stuck")
        ? { kind: "left-behind", path: dir, reason: "ENOTEMPTY" }
        : removeTree(dir),
    warn: (msg) => warnings.push(msg),
  });
  // Guards: an absent dir (no stub dir, no workspace) is skipped, not removed.
  assert.equal(removals.length, 2);
  // Guards: the failure does not stop the dirs after it.
  assert.equal(existsSync(next), false);
  // Guards: exactly one line, naming the path and the code, per dir left behind.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /stuck.*ENOTEMPTY/);
});

test("a clean cleanup prints nothing", () => {
  const dir = makeTmpDir("trial-cleanup-clean");
  mkdirSync(join(dir, "a"));
  const warnings: string[] = [];
  removeTrialDirs([dir], { warn: (msg) => warnings.push(msg) });
  // Guards: no warning noise on the normal path.
  assert.deepEqual(warnings, []);
});

test("by default the warning goes to stderr, one line", () => {
  const stderr = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    removeTrialDirs(["/stuck"], {
      remove: (dir) => ({ kind: "left-behind", path: dir, reason: "EBUSY" }),
    });
    // Guards: a dir left behind is never silent (the no-silent-skips rule).
    assert.equal(stderr.mock.calls.length, 1);
  } finally {
    stderr.mockRestore();
  }
});
