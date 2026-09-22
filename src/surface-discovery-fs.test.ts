/**
 * Tests for the DISK half of BOUNDED DISCOVERY (`src/surface-discovery-fs.ts`):
 * that both walks — surfaces and instructions — are BOUNDED, and that
 * `.vigilesrc.json#exclude` reaches each of them.
 *
 * One fixture, asserted from both sides in the same test — the tree that must be
 * found sits beside the trees that must not, so "the walk stopped walking" and
 * "the fixture never had those files" cannot be confused. Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { excludeSet } from "./exclude.js";
import {
  boundedInstructionFiles,
  boundedSurfacePaths,
  discoverSurfacesOnDisk,
} from "./surface-discovery-fs.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
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

/**
 * The INSTRUCTION half of the same bound (`boundedInstructionFiles`).
 *
 * The thing this replaced walked wherever an adapter's glob pointed, so the
 * negative half below is not decoration: `node_modules/dep/AGENTS.md` and
 * `pkg/sub/AGENTS.md` were BOTH read and BOTH summed into the printed weight.
 */
test("the instruction walk covers the root, dot-dirs and the rules TREE, and nothing else", () => {
  const root = makeTmpDir("instruction-bound");
  try {
    mkdirSync(join(root, ".claude/rules/team"), { recursive: true });
    mkdirSync(join(root, "pkg/sub"), { recursive: true });
    mkdirSync(join(root, "node_modules/dep"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root");
    writeFileSync(join(root, "README.md"), "prose");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, ".claude/CLAUDE.md"), "dot");
    writeFileSync(join(root, ".claude/settings.json"), "{}");
    writeFileSync(join(root, ".claude/rules/flat.md"), "flat");
    writeFileSync(join(root, ".claude/rules/team/deep.md"), "deep");
    writeFileSync(join(root, "pkg/sub/CLAUDE.md"), "nested");
    writeFileSync(join(root, "node_modules/dep/CLAUDE.md"), "theirs");

    const files = boundedInstructionFiles(root, claudeCodeLayout);
    assert.deepEqual(Object.keys(files).sort(), [
      ".claude/CLAUDE.md",
      ".claude/rules/flat.md",
      // The rules dir is read RECURSIVELY — the flat classifier that used to
      // pair with it stopped at depth 1, so this file was read by the loader and
      // classified by nothing (#262 §3).
      ".claude/rules/team/deep.md",
      // A settings SOURCE, in the map and never weighed: it decides WHICH files
      // load (`claudeMdExcludes`), which is a different job from being one.
      ".claude/settings.json",
      "CLAUDE.md",
      // Root markdown the harness will simply not recognize. It is in the bound
      // because a repo may declare its OWN instruction filename in settings
      // (Codex's `project_doc_fallback_filenames`), and the domain cannot know
      // the name in advance; the harness ignores what it does not claim.
      "README.md",
    ]);
    // `package.json` is at the root and is NOT markdown: the bound reads the
    // root's markdown, not the root.
    assert.equal(files["package.json"], undefined);
  } finally {
    cleanupTmpDir(root);
  }
});

test("a SYMLINKED rules home is walked, as a symlinked surface dir already is", () => {
  // Codex review on #265. `entryOf` answers "skip" for a symlinked directory ON
  // PURPOSE — that rule is for entries a walk finds INSIDE a tree — so the
  // rules walk, which asked `kind !== "dir"`, dropped a `.claude/rules` that
  // is a link to a shared policy directory, and with it every rule the harness
  // loads from there. The surface walk beside it asked the same question
  // correctly (`openableSurfaceDir`: refuse a FILE, let `walkableRoot` judge a
  // link) and says why in its own comment. Two spellings of one entry check.
  const root = makeTmpDir("rules-symlink");
  try {
    mkdirSync(join(root, "shared-policy"), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "shared-policy/team.md"), "a rule");
    symlinkSync(
      join(root, "shared-policy"),
      join(root, ".claude/rules"),
      "dir",
    );

    const files = boundedInstructionFiles(root, claudeCodeLayout);
    assert.equal(files[".claude/rules/team.md"], "a rule");
  } finally {
    cleanupTmpDir(root);
  }
});

test("a rules home that is a FILE, or a link that loops back over the root, is not walked", () => {
  // The control half: the fix must not turn "follow a link" into "follow
  // anything". A file named `rules` is refused by the entry check, and a link
  // whose target contains the scanned root is refused by `walkableRoot`.
  const root = makeTmpDir("rules-symlink-refused");
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude/rules"), "not a directory");
    const asFile = boundedInstructionFiles(root, claudeCodeLayout);
    assert.deepEqual(
      Object.keys(asFile).filter((k) => k.startsWith(".claude/rules")),
      [],
    );
  } finally {
    cleanupTmpDir(root);
  }
  const loop = makeTmpDir("rules-symlink-loop");
  try {
    mkdirSync(join(loop, ".claude"), { recursive: true });
    writeFileSync(join(loop, "CLAUDE.md"), "root");
    symlinkSync(loop, join(loop, ".claude/rules"), "dir");
    const looped = boundedInstructionFiles(loop, claudeCodeLayout);
    assert.deepEqual(
      Object.keys(looped).filter((k) => k.startsWith(".claude/rules")),
      [],
    );
  } finally {
    cleanupTmpDir(loop);
  }
});

test("exclude reaches the instruction walk, including inside the rules tree", () => {
  const root = makeTmpDir("instruction-exclude");
  try {
    mkdirSync(join(root, ".claude/rules/vendored"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "root");
    writeFileSync(join(root, ".claude/rules/mine.md"), "mine");
    writeFileSync(join(root, ".claude/rules/vendored/theirs.md"), "theirs");

    const keys = (patterns: string[]): string[] =>
      Object.keys(
        boundedInstructionFiles(
          root,
          claudeCodeLayout,
          excludeSet(root, patterns),
        ),
      ).sort();

    assert.deepEqual(keys([]), [
      ".claude/rules/mine.md",
      ".claude/rules/vendored/theirs.md",
      "CLAUDE.md",
    ]);
    // A DESCENDANT of the rules dir, which is the entry-point-only bug the
    // surface walk already guards against — same policy, same failure shape.
    assert.deepEqual(keys([".claude/rules/vendored"]), [
      ".claude/rules/mine.md",
      "CLAUDE.md",
    ]);
  } finally {
    cleanupTmpDir(root);
  }
});

/**
 * The IMPORT pass: the one read outside the dot-directory bound, allowed because
 * the repository OWNER wrote the path in their own file — and ONE LEVEL, which
 * is a measurement rather than a shortcut (see `resolveImports`).
 */
test("an @import names one concrete path, and it is read — one level, no recursion", () => {
  const root = makeTmpDir("instruction-imports");
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "@docs/a.md");
    // The shape 4 of the 6 real imports in the measured corpus have: the
    // AGENTS.md workaround, from before Claude Code read it natively (v2.1.277).
    writeFileSync(join(root, "docs/a.md"), "@docs/b.md");
    writeFileSync(join(root, "docs/b.md"), "leaf");
    // Never named by anything: the pass follows tokens, it does not glob.
    writeFileSync(join(root, "docs/unnamed.md"), "not imported");

    const files = boundedInstructionFiles(root, claudeCodeLayout);
    // 🔴 `docs/b.md` IS ABSENT ON PURPOSE. A transitive import is a real Claude
    // Code feature and its nested size is NOT counted: no file in the 198-file
    // corpus behind this decision has one, and a recursive walk driven by
    // strings found in files is the defect #262 is about. If a real case turns
    // up, the thing to redo is that measurement, not this assertion.
    assert.deepEqual(Object.keys(files).sort(), ["CLAUDE.md", "docs/a.md"]);
  } finally {
    cleanupTmpDir(root);
  }
});

test("an @import that escapes the repo is not read", () => {
  const root = makeTmpDir("instruction-import-escape");
  try {
    writeFileSync(
      join(root, "CLAUDE.md"),
      "@../escape.md @~/notes.md @/etc/x.md",
    );
    assert.deepEqual(
      Object.keys(boundedInstructionFiles(root, claudeCodeLayout)).sort(),
      ["CLAUDE.md"],
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("an @import names a file that is not there — nothing is read, nothing throws", () => {
  const root = makeTmpDir("instruction-import-missing");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "@docs/gone.md");
    assert.deepEqual(
      Object.keys(boundedInstructionFiles(root, claudeCodeLayout)).sort(),
      ["CLAUDE.md"],
    );
  } finally {
    cleanupTmpDir(root);
  }
});
