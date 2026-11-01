/**
 * The shared symlink policy for recursive walks: `entryOf` for every entry INSIDE
 * a walk, `walkableRoot` for the walk's entry point.
 *
 * Both halves per shape: a symlinked DIRECTORY is refused (the cycle/escape case),
 * and everything else classifies exactly as a plain `statSync` walk would — a fix
 * that simply returned `"skip"` for everything would pass the first assertion
 * alone and silently empty every report built on these walks. The root half has
 * the same shape with the OPPOSITE default, and for a stated reason: a linked-in
 * shared skills dir is a real layout, so refusing every symlinked root would empty
 * the surface list for those repos — see `walkableRoot`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { entryOf, skillTreeEntryOf, walkableRoot } from "./fs-walk.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

test("a symlinked directory is refused; a symlinked file is not", () => {
  const dir = makeTmpDir("fs-walk");
  mkdirSync(join(dir, "real"), { recursive: true });
  writeFileSync(join(dir, "real", "a.md"), "a\n");
  symlinkSync(join(dir, "real"), join(dir, "linkdir"), "dir");
  symlinkSync(join(dir, "real", "a.md"), join(dir, "linkfile"), "file");
  symlinkSync(join(dir, "nowhere"), join(dir, "dangling"), "file");

  // FIRES: the one entry that can cycle or leave the checkout.
  assert.equal(entryOf(join(dir, "linkdir")).kind, "skip");
  // QUIET: everything else is classified as before.
  assert.equal(entryOf(join(dir, "real")).kind, "dir");
  assert.equal(entryOf(join(dir, "real", "a.md")).kind, "file");
  assert.equal(entryOf(join(dir, "linkfile")).kind, "file");
  // Unreadable is skipped, not thrown — a walk feeding a report must survive it.
  assert.equal(entryOf(join(dir, "dangling")).kind, "skip");
  assert.equal(entryOf(join(dir, "does-not-exist")).kind, "skip");
  cleanupTmpDir(dir);
});

test("the size comes back with the classification, so nobody stats twice", () => {
  // The loader needs "is this a file" AND "is it under the cap". Asking twice gave
  // the second question its own unreachable failure path — dead code that only the
  // 100% coverage gate ever noticed. One syscall answers both, and a non-file
  // reports 0 rather than something a size comparison could accidentally accept.
  const dir = makeTmpDir("fs-walk-size");
  mkdirSync(join(dir, "d"), { recursive: true });
  writeFileSync(join(dir, "f.md"), "12345");
  symlinkSync(join(dir, "f.md"), join(dir, "linkfile"), "file");

  assert.equal(entryOf(join(dir, "f.md")).size, 5);
  assert.equal(entryOf(join(dir, "linkfile")).size, 5, "the TARGET's size");
  assert.equal(entryOf(join(dir, "d")).size, 0);
  assert.equal(entryOf(join(dir, "does-not-exist")).size, 0);
  cleanupTmpDir(dir);
});

test("a symlinked ROOT is followed, unless it swallows the tree being scanned", () => {
  // 🔴 The entry point never went through the policy at all: both walks hand a
  // surface root straight to `readdirSync`, which FOLLOWS the link. So the
  // containment each walk promises ("only the surface dirs are walked, the rest of
  // the repo and any node_modules beside it is never entered") held for every
  // entry except the one the walk starts at.
  const dir = makeTmpDir("fs-walk-root");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  mkdirSync(join(dir, "shared-skills"), { recursive: true });
  mkdirSync(join(repo, "real-skills"), { recursive: true });

  // FIRES: a root whose target CONTAINS the scanned repo — the cycle-and-swallow
  // case, where the walk re-enters the tree it is scanning through a door the
  // layout did not open.
  symlinkSync(repo, join(repo, ".claude", "up-self"), "dir");
  symlinkSync(dir, join(repo, ".claude", "up-parent"), "dir");
  assert.equal(walkableRoot(join(repo, ".claude", "up-self"), repo), false);
  assert.equal(walkableRoot(join(repo, ".claude", "up-parent"), repo), false);

  // QUIET: the ordinary layouts must all still be walked. A blanket refusal would
  // pass the two assertions above and silently report ZERO skills for every repo
  // that links its skills directory somewhere — the failure this rule is shaped
  // to avoid, and the reason a root is not judged like an inner entry.
  symlinkSync(
    join(dir, "shared-skills"),
    join(repo, ".claude", "skills"),
    "dir",
  );
  assert.equal(
    walkableRoot(join(repo, ".claude", "skills"), repo),
    true,
    "a shared skills dir linked in from outside is an ordinary, supported layout",
  );
  symlinkSync(
    join(repo, "real-skills"),
    join(repo, ".claude", "inside"),
    "dir",
  );
  assert.equal(walkableRoot(join(repo, ".claude", "inside"), repo), true);
  // A plain directory is unchanged — this must not become a second existence check.
  assert.equal(walkableRoot(join(repo, "real-skills"), repo), true);
  // …and an unreadable or dangling root is refused rather than thrown at.
  symlinkSync(join(dir, "nowhere"), join(repo, ".claude", "dangling"), "dir");
  assert.equal(walkableRoot(join(repo, ".claude", "dangling"), repo), false);
  assert.equal(walkableRoot(join(repo, "does-not-exist"), repo), false);
  cleanupTmpDir(dir);
});

test("a skills walk enters ONE linked skill folder per path, never one that loops back", () => {
  // `vigiles init` links shipped skills in as folders and the harness lists
  // them, so a skills walk follows the link — once. Both refusals are the
  // cycle case; the hop limit is what makes termination a matter of
  // construction rather than of a visited-set.
  const dir = makeTmpDir("fs-walk-skill-links");
  const repo = join(dir, "repo");
  const skills = join(repo, ".claude", "skills");
  mkdirSync(join(skills, "own"), { recursive: true });
  mkdirSync(join(dir, "shared", "linked"), { recursive: true });
  symlinkSync(join(dir, "shared", "linked"), join(skills, "linked"), "dir");

  // FOLLOWED: a skill folder linked in from outside, and nothing below it may
  // cross another link.
  assert.deepEqual(skillTreeEntryOf(join(skills, "linked"), repo, true), {
    kind: "dir",
    size: 0,
    mayFollowBelow: false,
  });
  // …but not once a link has already been crossed on this path: then it is
  // exactly `entryOf`'s refusal.
  assert.deepEqual(skillTreeEntryOf(join(skills, "linked"), repo, false), {
    kind: "skip",
    size: 0,
    mayFollowBelow: false,
  });
  // A real folder passes the allowance down unchanged.
  assert.deepEqual(skillTreeEntryOf(join(skills, "own"), repo, true), {
    kind: "dir",
    size: 0,
    mayFollowBelow: true,
  });

  // REFUSED: a target containing the scanned repo, and a target containing the
  // link itself — both re-enter the tree being walked.
  symlinkSync(repo, join(skills, "up"), "dir");
  symlinkSync(skills, join(skills, "own", "back"), "dir");
  assert.equal(skillTreeEntryOf(join(skills, "up"), repo, true).kind, "skip");
  assert.equal(
    skillTreeEntryOf(join(skills, "own", "back"), repo, true).kind,
    "skip",
  );
  // REFUSED: a dangling link, and a link to something that is not a folder.
  symlinkSync(join(dir, "nowhere"), join(skills, "dangling"), "dir");
  assert.equal(
    skillTreeEntryOf(join(skills, "dangling"), repo, true).kind,
    "skip",
  );
  execFileSync("mkfifo", [join(dir, "fifo")]);
  symlinkSync(join(dir, "fifo"), join(skills, "pipe"));
  assert.equal(skillTreeEntryOf(join(skills, "pipe"), repo, true).kind, "skip");
  cleanupTmpDir(dir);
});
