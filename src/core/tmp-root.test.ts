/**
 * The regression test for the realpath-resolved fixture root (#241).
 *
 * 🔴 IT BUILDS ITS OWN SYMLINK, and that is the whole design. On Linux
 * `realpathSync` is the identity over `tmpdir()`, so a test that merely called
 * `makeTmpDir()` and compared it with itself would pass with the fix REMOVED —
 * a green that means "this platform has no trap", not "the trap is closed".
 * Creating the symlink explicitly reproduces the macOS shape on any platform.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeTmpDir, cleanupTmpDir } from "./tmp-root.js";

test("makeTmpDir returns a path with no symlink left in it", () => {
  const dir = makeTmpDir("tmp-root");
  try {
    assert.equal(
      dir,
      realpathSync(dir),
      "the root must equal its own realpath — that is the property macOS breaks",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the FIX, not the platform: TMPDIR under a symlink, and the helper resolves it", () => {
  // 🔴 THIS TEST EXISTS BECAUSE THE FIRST VERSION OF IT DID NOT WORK. It staged a
  // symlink and then resolved a path INLINE, so it demonstrated the principle
  // without ever calling `makeTmpDir`. Measured: removing `realpathSync` from the
  // helper left all three tests GREEN — a decorative test, and a survived
  // mutation is a finding about the test, not a verdict about the code.
  //
  // What holds the fix on Linux: `os.tmpdir()` honours `TMPDIR` on POSIX, so
  // pointing it at a symlink reproduces the macOS shape INSIDE the helper.
  const real = realpathSync(
    mkdtempSync(join(tmpdir(), "vigiles-tmp-root-real-")),
  );
  const target = join(real, "target");
  const link = join(real, "link");
  const saved = process.env.TMPDIR;
  try {
    mkdirSync(target);
    symlinkSync(target, link);

    // Control first: with TMPDIR pointing at the link, the UNRESOLVED shape —
    // the one a harness author hand-rolls — really does carry two spellings. If
    // this fails, the staging is broken and the assert below proves nothing.
    process.env.TMPDIR = link;
    const handRolled = mkdtempSync(join(tmpdir(), "hand-rolled-"));
    assert.notEqual(
      handRolled,
      realpathSync(handRolled),
      "control: the trap must be present, or the next assert is vacuous",
    );

    // And now the helper itself, through the same TMPDIR.
    const viaHelper = makeTmpDir("tmp-root-staged");
    assert.equal(
      viaHelper,
      realpathSync(viaHelper),
      "makeTmpDir must resolve the root even when tmpdir() itself is a symlink",
    );
    assert.ok(
      viaHelper.startsWith(realpathSync(target)),
      "and the resolved root lives under the target's own spelling",
    );
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(real, { recursive: true, force: true });
  }
});

test("a harness's OWN symlink is still testable — the fix does not swallow it", () => {
  // The fix resolves the ROOT. A symlink the harness creates inside that root is
  // explicit and must survive, or every symlink-handling test would become
  // untestable — which was the risk worth naming.
  const dir = makeTmpDir("tmp-root-own");
  try {
    const target = join(dir, "target");
    const link = join(dir, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    assert.notEqual(
      link,
      realpathSync(link),
      "the author's own symlink is intact",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
