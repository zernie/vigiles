/**
 * `.claude/rules/**` — the path-scoped instruction layer (#175.3).
 *
 * Claude Code loads these as project instructions, scoped by a `paths:`
 * frontmatter key, and teams put their hardest policies there. No `PluginLayout`
 * named the directory, so the loader never read it and every text check —
 * `frontmatter-valid`, the rule map — silently saw nothing. An adopter reported
 * five such files arriving in a session labelled "project instructions" while
 * `vigiles lint` did not mention them at all.
 *
 * The additive promise is tested as hard as the feature: a layout without
 * `rulesDir` must behave EXACTLY as before, and rules must not start counting as
 * a loadable machine (they are instructions, not an invocable surface).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadPlugin } from "./plugin-loader.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { makeClassifier } from "./scan-core.js";
import { malformedFrontmatterFor } from "./scan-core.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const BROKEN_RULE = `---
paths: ["src/**"]
description: broken: colon here
---

Never force-push.
`;

function withRules(build: (dir: string) => void): string {
  const dir = makeTmpDir();
  build(dir);
  return dir;
}

function skillAt(dir: string, base: string, name: string): void {
  mkdirSync(join(dir, base, "skills", name), { recursive: true });
  writeFileSync(
    join(dir, base, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does the ${name} thing.\n---\n\nBody.\n`,
  );
}

test("a rules file under .claude/ is loaded", () => {
  const dir = withRules((d) => {
    skillAt(d, ".claude", "demo");
    mkdirSync(join(d, ".claude", "rules"), { recursive: true });
    writeFileSync(join(d, ".claude", "rules", "git.md"), BROKEN_RULE);
  });
  try {
    const files = Object.keys(loadPlugin(dir, claudeCodeLayout).files);
    assert.ok(files.includes(".claude/rules/git.md"));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("rules load even when the SKILLS live at the repo root", () => {
  // The shape that broke the first implementation: rules are not tied to where
  // the invocable surfaces live, so keying them off the resolved scopes read the
  // wrong directory and found nothing.
  const dir = withRules((d) => {
    skillAt(d, "", "demo");
    mkdirSync(join(d, ".claude", "rules"), { recursive: true });
    writeFileSync(join(d, ".claude", "rules", "git.md"), BROKEN_RULE);
  });
  try {
    const files = Object.keys(loadPlugin(dir, claudeCodeLayout).files);
    assert.ok(
      files.includes(".claude/rules/git.md"),
      "a published-plugin layout still keeps its rules under .claude/",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("frontmatter-valid now sees a broken rule file", () => {
  const dir = withRules((d) => {
    skillAt(d, ".claude", "demo");
    mkdirSync(join(d, ".claude", "rules"), { recursive: true });
    writeFileSync(join(d, ".claude", "rules", "git.md"), BROKEN_RULE);
  });
  try {
    const loaded = loadPlugin(dir, claudeCodeLayout);
    const cls = makeClassifier(claudeCodeLayout);
    const issues = malformedFrontmatterFor(loaded.files, cls);
    assert.deepEqual(
      issues.map((i) => i.path),
      [".claude/rules/git.md"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a rule in a SUBDIRECTORY is classified — the dir is read recursively", () => {
  // 🔴 THE CLASSIFIER USED TO BE FLAT (`<rulesDir>/[^/]+\.md`) WHILE THE LOADER
  // WALKED THE DIRECTORY RECURSIVELY, so a nested rule was READ into the file
  // map and classified as nothing: never frontmatter-checked, never counted,
  // never weighed (zernie/vigiles#262 §3). Vendor: all `.md` files under a rules
  // directory are discovered recursively. The depth rule now lives once, in
  // `RULE_FILE_LEAF_RE`, and both readers quote it.
  const dir = withRules((d) => {
    skillAt(d, ".claude", "demo");
    mkdirSync(join(d, ".claude", "rules", "team"), { recursive: true });
    writeFileSync(join(d, ".claude", "rules", "team", "git.md"), BROKEN_RULE);
  });
  try {
    const loaded = loadPlugin(dir, claudeCodeLayout);
    const cls = makeClassifier(claudeCodeLayout);
    assert.equal(cls.isRule(".claude/rules/team/git.md"), true);
    assert.deepEqual(
      malformedFrontmatterFor(loaded.files, cls).map((i) => i.path),
      [".claude/rules/team/git.md"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a WELL-FORMED rule file is not flagged", () => {
  // The other half — the check must not fire merely because the layer is now
  // visible, which would be the loudest possible way to get this reverted.
  const dir = withRules((d) => {
    skillAt(d, ".claude", "demo");
    mkdirSync(join(d, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(d, ".claude", "rules", "ok.md"),
      `---\npaths: ["src/**"]\ndescription: "fine: quoted"\n---\n\nBody.\n`,
    );
  });
  try {
    const loaded = loadPlugin(dir, claudeCodeLayout);
    const issues = malformedFrontmatterFor(
      loaded.files,
      makeClassifier(claudeCodeLayout),
    );
    assert.deepEqual(issues, []);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("rules alone are NOT a loadable machine", () => {
  // The additive promise. Rules are instructions, not an invocable surface, so
  // folding them into `surfaceDirs` would silently redefine "empty machine" for
  // every harness. A repo with rules and nothing else must still say so.
  const dir = withRules((d) => {
    mkdirSync(join(d, ".claude", "rules"), { recursive: true });
    writeFileSync(join(d, ".claude", "rules", "git.md"), BROKEN_RULE);
  });
  try {
    const loaded = loadPlugin(dir, claudeCodeLayout);
    const cls = makeClassifier(claudeCodeLayout);
    const surfaces = Object.keys(loaded.files).filter(
      (f) => cls.isSkill(f) || cls.isAgent(f) || cls.isCommand(f),
    );
    assert.deepEqual(surfaces, [], "no invocable surface was invented");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a layout WITHOUT rulesDir reads nothing and classifies nothing", () => {
  // Byte-for-byte the old behaviour for any harness that does not have the layer.
  const noRules = { ...claudeCodeLayout, rulesDir: undefined };
  const dir = withRules((d) => {
    skillAt(d, ".claude", "demo");
    mkdirSync(join(d, ".claude", "rules"), { recursive: true });
    writeFileSync(join(d, ".claude", "rules", "git.md"), BROKEN_RULE);
  });
  try {
    const files = Object.keys(loadPlugin(dir, noRules).files);
    assert.equal(files.includes(".claude/rules/git.md"), false);
    assert.equal(makeClassifier(noRules).isRule(".claude/rules/git.md"), false);
  } finally {
    cleanupTmpDir(dir);
  }
});
