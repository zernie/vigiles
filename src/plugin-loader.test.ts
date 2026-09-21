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

import { loadPlugin, loadPlugins } from "./plugin-loader.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import type { PluginLayout } from "./core/layout.js";
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

/**
 * A declared root that holds NOTHING LOADABLE must not become a scope.
 *
 * 🔴 WHY THIS TEST EXISTS, AND IT IS NOT A HYPOTHETICAL. `surfaceSource` falls
 * back to the project scope only when the scope list is EMPTY — that fallback is
 * the reason a plain repo is not read as an empty machine. An empty declared
 * root, counted as a scope, makes the list non-empty and cancels the fallback,
 * so a repo loses the `.claude/` tree it always had by adding one config line
 * that names a directory with nothing in it.
 *
 * MEASURED both ways on this exact fixture: with the probe filter the keys are
 * `["CLAUDE.md", ".claude/skills/alpha/README.md"]`; with it removed they are
 * `["CLAUDE.md"]` — the project tree silently gone.
 */
test("loadPlugin: an EMPTY declared root does not cancel the project scope", () => {
  const root = makeTmpDir("declared-empty");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# demo project\n");
    // Declared, and present on disk, but holding no loadable file.
    mkdirSync(join(root, ".ai", "skills"), { recursive: true });
    // The project tree the fallback exists to keep reading. Deliberately a
    // NON-loadable file: that is what makes `userHasLoadable` false and puts the
    // repo on the fallback path this test is about.
    mkdirSync(join(root, ".claude", "skills", "alpha"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "alpha", "README.md"),
      "hi\n",
    );

    assert.deepEqual(
      Object.keys(loadPlugin(root, claudeCodeLayout, undefined, [".ai"]).files),
      ["CLAUDE.md", ".claude/skills/alpha/README.md"],
      "the empty declaration changed nothing",
    );
    // The positive half, on the same fixture: fill the declared root and it DOES
    // become a scope — so "no new key" above is about emptiness, not about the
    // declaration being ignored outright.
    mkdirSync(join(root, ".ai", "skills", "check-dor"), { recursive: true });
    writeFileSync(
      join(root, ".ai", "skills", "check-dor", "SKILL.md"),
      "---\nname: check-dor\ndescription: checks the definition of ready\n---\nbody\n",
    );
    assert.deepEqual(
      Object.keys(loadPlugin(root, claudeCodeLayout, undefined, [".ai"]).files),
      [
        "CLAUDE.md",
        ".claude/skills/alpha/README.md",
        ".ai/skills/check-dor/SKILL.md",
      ],
    );
  } finally {
    cleanupTmpDir(root);
  }
});

/**
 * The two-level warning counts the HARNESS's OWN levels, not a declared root.
 *
 * It fires only when the plugin and project scopes are both present, and every
 * sentence in it is about what a real session loads under two names. A declared
 * root is not such a level, so its files must not be added to the total — the
 * warning would then report a number about files it is not talking about.
 *
 * Both halves on one fixture: the warning still FIRES (the real ambiguity is
 * there) and the number is 2, not the 3 that includes the declared skill.
 */
test("loadPlugin: the two-level warning excludes a declared root from its count", () => {
  const root = makeTmpDir("declared-count");
  try {
    const skill = (name: string): string =>
      `---\nname: ${name}\ndescription: does ${name} things for the fixture\n---\nbody\n`;
    writeFileSync(join(root, "CLAUDE.md"), "# demo project\n");
    for (const [rel, name] of [
      ["skills/plugin-one", "plugin-one"],
      [".claude/skills/project-one", "project-one"],
      [".ai/skills/declared-one", "declared-one"],
    ] as const) {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, "SKILL.md"), skill(name));
    }
    const warning = loadPlugin(root, claudeCodeLayout, undefined, [
      ".ai",
    ]).warnings.find((w) => w.includes("TWO discovery levels"));
    assert.ok(warning, "the real plugin/project ambiguity still warns");
    assert.match(warning, /2 file\(s\) were read from both/);
    assert.doesNotMatch(warning, /3 file\(s\)/);
  } finally {
    cleanupTmpDir(root);
  }
});

// ---------------------------------------------------------------------------
// loadPlugins — one repo, several declared harnesses (#240)
// ---------------------------------------------------------------------------

/**
 * 🔴 A FILE TWO HARNESSES BOTH READ IS READ ONCE AND COUNTED ONCE.
 *
 * The honest declaration for a repo serving one tree to both tools names that
 * tree under both harness keys. If the merge appended blindly, being honest
 * would DOUBLE every skill in it — the repo that told the truth would score
 * worse than the one that named a single harness. So the merge keys on the real
 * ON-DISK path, and the first harness to claim a file keeps it.
 *
 * ⚠️ THE FIXTURE IS SYNTHETIC ON PURPOSE, and this is the discriminating half —
 * the CLI-level version of this test CANNOT fail. With the two shipped adapters a
 * declared root materializes under its own base, so the key a file gets IS its
 * repo-relative path, and the `files` object deduplicates by key whether or not
 * the guard exists. MEASURED 2026-09-21: with `seenOnDisk` mutated off, a
 * dual-declaration audit over one tree still reported `skills = 1` — a green
 * mutation that says nothing about the protection. The guard bites only when a
 * layout RELOCATES (materializes under a prefix that is not the base), which is
 * what `relocating` below does, so the two keys differ for ONE file and the
 * count can actually be wrong.
 */
test("loadPlugins reads a doubly-claimed file once, even under two keys", () => {
  const root = makeTmpDir("dual-claim");
  try {
    mkdirSync(join(root, "skills/alpha"), { recursive: true });
    writeFileSync(
      join(root, "skills/alpha/SKILL.md"),
      "---\nname: alpha\ndescription: d\n---\n# alpha\n",
    );
    // Two layouts reading the SAME repo-root `skills/` tree and materializing it
    // under DIFFERENT prefixes — the materialize prefix is what relocates a
    // repo-root plugin scope, so one file arrives under two keys and a key-only
    // merge cannot see that they are the same bytes.
    //
    // 🔴 THIS FIXTURE USED TO BUILD AN ILLEGAL STATE, and that is worth saying
    // because it is the only place in the tree that did. It set
    // `materializeRoot: ""` beside `claudeCodeLayout`'s `userSurfaceRoot:
    // ".claude"` — two fields naming the relocation prefix, deliberately made to
    // DISAGREE, which nothing defined the meaning of. With one field the same
    // two shapes are expressible and each now means something: `plain` is a
    // layout with no second surface home (prefix ""), `relocating` is one whose
    // second home is `mirror`.
    const plain: PluginLayout = {
      ...claudeCodeLayout,
      userSurfaceRoot: undefined,
    };
    const relocating: PluginLayout = {
      ...claudeCodeLayout,
      name: "relocating",
      userSurfaceRoot: "mirror",
    };
    const keys = (p: { files: Record<string, string> }): string[] =>
      Object.keys(p.files)
        .filter((k) => k.endsWith("/SKILL.md"))
        .sort();
    assert.deepEqual(
      keys(loadPlugins(root, [{ layout: plain }])),
      ["skills/alpha/SKILL.md"],
      "one harness: one skill",
    );
    assert.deepEqual(
      keys(loadPlugins(root, [{ layout: relocating }])),
      ["mirror/skills/alpha/SKILL.md"],
      "the other harness alone keys the SAME file differently — which is what " +
        "makes the merge below a real question",
    );
    const two = loadPlugins(root, [{ layout: plain }, { layout: relocating }]);
    assert.deepEqual(
      keys(two),
      ["skills/alpha/SKILL.md"],
      "two harnesses over one tree: STILL one skill, not one per claimant",
    );
    // The surviving key is the FIRST claimant's, so the rest of the report is
    // consistent with the harness whose dialect it is rendered in.
    assert.equal(
      two.sources["skills/alpha/SKILL.md"],
      join(root, "skills/alpha/SKILL.md"),
    );
  } finally {
    cleanupTmpDir(root);
  }
});

/**
 * The counterpart: two harnesses over DIFFERENT trees both get read. Without it
 * the test above passes for a merge that simply drops everything after the first
 * harness — "counted once" and "read at all" are separate claims.
 */
test("loadPlugins reads every declared harness's own tree", () => {
  const root = makeTmpDir("dual-trees");
  try {
    for (const [base, name] of [
      ["a", "alpha"],
      ["b", "beta"],
    ]) {
      mkdirSync(join(root, `${base}/skills/${name}`), { recursive: true });
      writeFileSync(
        join(root, `${base}/skills/${name}/SKILL.md`),
        `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`,
      );
    }
    // The SECOND harness is the only one with settings, and the only one with a
    // surface that warns. Both merge halves are therefore exercised in the one
    // direction that can be wrong — "first wins" must not mean "first only".
    mkdirSync(join(root, "b/agents"), { recursive: true });
    writeFileSync(
      join(root, "b/agents/worker.md"),
      "---\nname: worker\ndescription: d\n---\n# worker\n",
    );
    mkdirSync(join(root, ".second"), { recursive: true });
    writeFileSync(
      join(root, ".second/settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [] } }),
    );
    const plain: PluginLayout = {
      ...claudeCodeLayout,
      userSurfaceRoot: undefined,
      // No settings file of its own, so the merge must reach past it.
      settingsPath: ".first/settings.json",
    };
    const both = loadPlugins(root, [
      { layout: plain, roots: ["a"] },
      {
        layout: {
          ...plain,
          name: "second",
          settingsPath: ".second/settings.json",
        },
        roots: ["b"],
      },
    ]);
    assert.deepEqual(
      Object.keys(both.files)
        .filter((k) => k.endsWith("/SKILL.md"))
        .sort(),
      ["a/skills/alpha/SKILL.md", "b/skills/beta/SKILL.md"],
    );
    assert.ok(
      both.warnings.some((w) => w.includes("subagent file(s)")),
      "a warning raised by the SECOND harness survives the merge",
    );
    assert.deepEqual(
      both.settings.hooks,
      { PostToolUse: [] },
      "…and so do its settings, when the first harness has none",
    );
  } finally {
    cleanupTmpDir(root);
  }
});
