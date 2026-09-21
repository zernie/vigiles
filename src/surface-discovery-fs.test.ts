/**
 * Tests for the DISK half of surface discovery (`src/surface-discovery-fs.ts`):
 * that the walk is BOUNDED, and that `.vigilesrc.json#exclude` reaches it.
 *
 * One fixture, asserted from both sides in the same test — the tree that must be
 * found sits beside the trees that must not, so "the walk stopped walking" and
 * "the fixture never had those files" cannot be confused. Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { excludeSet } from "./exclude.js";
import {
  boundedSurfacePaths,
  discoverSurfacesOnDisk,
} from "./surface-discovery-fs.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/** Write `<root>/<rel>/SKILL.md`, creating parents. */
function skillAt(root: string, rel: string, name: string): void {
  mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(
    join(root, rel, "SKILL.md"),
    `---\nname: ${name}\ndescription: does ${name} things for the fixture\n---\n\n# ${name}\n`,
  );
}

/**
 * The bound, on real directories: the repo root and its DOT-DIRECTORIES are
 * discovery roots; `src/`, `packages/` and `node_modules/` are not.
 *
 * The negative half is #240's own warning — the reporter measured that an
 * unbounded `**\/SKILL.md` finds 53 vendored third-party plugin skills beside
 * the 37 real ones and grades them as one machine.
 */
test("the disk walk covers the root and dot-dirs, and refuses everything else", () => {
  const root = makeTmpDir("discovery-bound");
  try {
    skillAt(root, ".ai/skills/check-dor", "check-dor"); // dot-dir  → found
    skillAt(root, ".claude/skills/alpha", "alpha"); // dot-dir  → found
    skillAt(root, "skills/gamma", "gamma"); // root     → found
    skillAt(root, "src/skills/nope", "nope"); // not a root
    skillAt(root, "packages/x/skills/nope2", "nope2"); // not a root
    skillAt(root, "node_modules/evil/.claude/skills/bad", "bad"); // floor
    const found = discoverSurfacesOnDisk(root)
      .map((s) => s.dir)
      .sort();
    assert.deepEqual(found, [".ai/skills", ".claude/skills", "skills"]);

    // 🔴 AND THE WALK'S OWN BOUND, SEPARATELY — measured, not assumed. The
    // bound is enforced TWICE: here (which directories are ever opened) and
    // again in the pure classifier (which paths are ever a surface). Asserting
    // only through `discoverSurfacesOnDisk` cannot tell them apart: a mutation
    // that opens EVERY top-level directory leaves that assertion green, because
    // the classifier throws the extra paths away afterwards. It is the cost
    // bound that would be gone, silently — a walk into `node_modules` on a real
    // repo — so the enumerator is pinned on its own.
    assert.deepEqual(
      [...boundedSurfacePaths(root)].sort(),
      [
        ".ai/skills/check-dor/SKILL.md",
        ".claude/skills/alpha/SKILL.md",
        "skills/gamma/SKILL.md",
      ],
      "the walk must never open src/, packages/ or node_modules/",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

/**
 * `exclude` reaches this walk (the precondition b751471 shipped for exactly
 * this pass), and reaches it PER ENTRY rather than only at the entry point —
 * a vendored tree is normally excluded at its own root inside a surface dir.
 *
 * The third leg is the discriminator the two-sided rule demands: a pattern that
 * matches NOTHING must leave the finding exactly as it was, so a filter that
 * silently swallows everything cannot pass as a correct exclusion.
 */
test("exclude drops the named subtree, a descendant of it, and nothing else", () => {
  const root = makeTmpDir("discovery-exclude");
  try {
    skillAt(root, ".ai/skills/check-dor", "check-dor");
    skillAt(root, ".ai/skills/vendored", "vendored");
    skillAt(root, ".claude/skills/alpha", "alpha");
    const dirsFor = (patterns: readonly string[]): readonly string[] =>
      discoverSurfacesOnDisk(root, excludeSet(root, patterns))
        .map((s) => s.path)
        .sort();

    // Precondition: with no exclude, all three are found.
    assert.deepEqual(dirsFor([]), [
      ".ai/skills/check-dor/SKILL.md",
      ".ai/skills/vendored/SKILL.md",
      ".claude/skills/alpha/SKILL.md",
    ]);
    // The whole dot-dir root.
    assert.deepEqual(dirsFor([".ai"]), [".claude/skills/alpha/SKILL.md"]);
    // A DESCENDANT of a surface dir — the entry-point-only bug this guards.
    assert.deepEqual(dirsFor([".ai/skills/vendored"]), [
      ".ai/skills/check-dor/SKILL.md",
      ".claude/skills/alpha/SKILL.md",
    ]);
    // A pattern matching nothing must change nothing.
    assert.deepEqual(dirsFor([".nonexistent"]), dirsFor([]));
  } finally {
    cleanupTmpDir(root);
  }
});
