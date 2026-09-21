/**
 * Tests for the COMPOSITION-ROOT loader (src/plugin-loader.ts) — the half the
 * `vigiles/claude-code` wrapper does not expose.
 *
 * The wrapper's own suite (`src/adapters/claude-code/plugin-loader.test.ts`)
 * covers `loadPlugin(dir)` ergonomics and the Claude Code default layout. This
 * file covers the third parameter that only the generic loader takes: the
 * `ExcludeSet`, which is how `.vigilesrc.json#exclude` reaches surface discovery.
 * Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadPlugin } from "./plugin-loader.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { excludeSet } from "./exclude.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/**
 * `.vigilesrc.json#exclude` reaches SURFACE DISCOVERY (#192), not just the
 * instruction file.
 *
 * Measured 2026-09-21 before the fix, through the real CLI: a repo carrying
 * `{"exclude": [".claude"]}` plus one skill at `.claude/skills/demo/SKILL.md`
 * printed `Skills (1): ✓ demo` and docked Safety to 90 for that skill's missing
 * `disallowed-tools:` fence — i.e. the grade was computed over a tree the user
 * had explicitly told the tool to ignore. `loadPlugin` took no `ExcludeSet` at
 * all, so the filter had nowhere to apply.
 *
 * Both directions are asserted in the SAME test on the SAME fixture, because the
 * only interesting failure is a filter that stopped filtering — and a test that
 * asserted the quiet side alone cannot tell that from a fixture that never had
 * the file.
 */
test("loadPlugin: an ExcludeSet drops an excluded surface, and keeps every other", () => {
  const root = makeTmpDir("plugin-exclude");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# demo project\n");
    mkdirSync(join(root, "skills", "mine"), { recursive: true });
    writeFileSync(
      join(root, "skills", "mine", "SKILL.md"),
      "---\nname: mine\ndescription: the project's own skill\n---\nbody\n",
    );
    // A vendored third-party tree copied INSIDE the surface dir — the shape the
    // walk-the-dot-directories discovery pass will meet, and the reason a filter
    // at the surface-dir entry point alone would not be enough.
    mkdirSync(join(root, "skills", "vendored", "theirs"), { recursive: true });
    writeFileSync(
      join(root, "skills", "vendored", "theirs", "SKILL.md"),
      "---\nname: theirs\ndescription: somebody else's skill\n---\nbody\n",
    );

    const before = loadPlugin(root, claudeCodeLayout);
    const key = join(".claude", "skills", "vendored", "theirs", "SKILL.md");
    assert.ok(
      before.files[key],
      "precondition: with no ExcludeSet the vendored skill IS read (the bug)",
    );

    const after = loadPlugin(
      root,
      claudeCodeLayout,
      excludeSet(root, ["skills/vendored"]),
    );
    assert.equal(
      after.files[key],
      undefined,
      "an excluded surface must be absent from the file map the report is computed from",
    );
    assert.ok(
      after.files[join(".claude", "skills", "mine", "SKILL.md")],
      "…and the project's OWN skill must survive — this is a filter, not a mute",
    );
    assert.ok(
      after.files["CLAUDE.md"],
      "…as must the instruction file, which nothing excluded",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

/**
 * The instruction half of the same parameter: `exclude` naming the instruction
 * file drops it, which is the behaviour `VigilesConfig#exclude` has documented
 * all along ("`audit` does not read an excluded instruction file") and which
 * `loadPlugin` never implemented on its own.
 */
test("loadPlugin: an excluded instruction file is not read", () => {
  const root = makeTmpDir("plugin-exclude-instr");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# theirs\n");
    assert.ok(
      loadPlugin(root, claudeCodeLayout).files["CLAUDE.md"],
      "precondition: it is read when nothing excludes it",
    );
    assert.equal(
      loadPlugin(root, claudeCodeLayout, excludeSet(root, ["CLAUDE.md"])).files[
        "CLAUDE.md"
      ],
      undefined,
    );
  } finally {
    cleanupTmpDir(root);
  }
});
