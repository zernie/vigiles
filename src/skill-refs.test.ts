/**
 * `brokenSkillRefs` — the near-miss rule, and the four ways a naive version
 * turns into noise. Pure: synthesized skills, no filesystem, no model.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brokenSkillRefs, formatSkillRefIssue } from "./skill-refs.js";
import { scanPlugin } from "./scan.js";
import { scanFiles } from "./scan-files.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { claudeCodeDialect } from "./adapters/claude-code/dialect.js";

const s = (name: string, content: string) => ({
  name,
  path: `.claude/skills/${name}/SKILL.md`,
  content,
});

test("a renamed sibling is caught, and the intended target is named", () => {
  const issues = brokenSkillRefs([
    s("orchestrator", "First run `verify-citation`, then stop."),
    s("verify-citations", "…"),
  ]);
  assert.equal(issues.length, 1);
  const issue = issues[0];
  assert.ok(issue, "expected exactly one issue");
  assert.equal(issue.missing, "verify-citation");
  assert.equal(issue.didYouMean, "verify-citations");
  assert.match(formatSkillRefIssue(issue), /no such skill exists/);
});

test("ordinary hyphenated prose does NOT fire — the whole reason for near-miss", () => {
  // `node-fetch` and `pull-request` are nowhere near the skill names. A rule that
  // flagged every backticked kebab token would fire on both, and a checker that
  // fires on clean input is muted within a day.
  const issues = brokenSkillRefs([
    s(
      "draft-paper",
      "Install `node-fetch` and open a `pull-request` in `claude-code`.",
    ),
    s("verify-citations", "…"),
  ]);
  assert.deepEqual(issues, []);
});

test("a reference to a skill that DOES exist is not an issue", () => {
  const issues = brokenSkillRefs([
    s("a", "compose with `verify-citations`"),
    s("verify-citations", "…"),
  ]);
  assert.deepEqual(issues, []);
});

test("a skill naming ITSELF is normal and never reported", () => {
  // Every skill quotes its own id — in its header, its run command, its examples.
  const issues = brokenSkillRefs([
    s("draft-paper", "run `draft-paper` like so"),
  ]);
  assert.deepEqual(issues, []);
});

test("the same broken name twice in one file reports once", () => {
  const issues = brokenSkillRefs([
    s("a", "`find-venu` … later `find-venu` again"),
    s("find-venue", "…"),
  ]);
  assert.equal(issues.length, 1);
});

test("a single word in backticks is never a reference", () => {
  // `true`, `--force`, `null` — a skill id has at least one hyphen, and single
  // tokens in backticks are overwhelmingly flags and fields.
  const issues = brokenSkillRefs([
    s("a", "pass `true` or `null` to `render`"),
    s("render-paper", "…"),
  ]);
  assert.deepEqual(issues, []);
});

test("the near-miss is measured against OTHER skills, not the referrer itself", () => {
  // `draft-papers` is one edit from `draft-paper` — but that IS the referrer, and
  // a skill that mistypes its own name should not be told "did you mean yourself".
  // It must match the other skill, or nothing.
  const issues = brokenSkillRefs([s("draft-paper", "see `draft-papers`")]);
  assert.deepEqual(issues, []);
});

// ---------------------------------------------------------------------------
// WIRING — the rule above was correct and reached nothing.
//
// `loaded.files` is keyed by the CANONICAL materialized key: a plugin shipping
// `skills/foo/SKILL.md` is loaded under `.claude/skills/foo/SKILL.md`. The
// report looked contents up by `ScanSkill.path`, which is the REAL on-disk path
// — so in the ordinary published-plugin layout every lookup missed and every
// skill was dropped. Measured 2026-08-11 on this exact pair of files: 2 findings
// under `.claude/skills/`, 0 under `skills/`, byte-identical content.
// ---------------------------------------------------------------------------
const REF_A = `---
name: find-venue
description: Discover and rank real venues for a paper, scored by visa weight.
---
Run \`verify-citation\` first, then rank what is left.
`;
const REF_B = `---
name: verify-citations
description: Confirm each citation is real and state its one-line delta.
---
Compose with \`find-venues\` when the venue is still open.
`;

test("skill→skill refs are found in a `skills/` plugin, not just under `.claude/`", () => {
  for (const root of ["skills", ".claude/skills"]) {
    // The disk scanner.
    const dir = makeTmpDir("skill-refs");
    try {
      mkdirSync(join(dir, root, "find-venue"), { recursive: true });
      mkdirSync(join(dir, root, "verify-citations"), { recursive: true });
      writeFileSync(join(dir, root, "find-venue", "SKILL.md"), REF_A);
      writeFileSync(join(dir, root, "verify-citations", "SKILL.md"), REF_B);
      const issues =
        scanPlugin(dir, claudeCodeLayout, claudeCodeDialect).skillRefIssues ??
        [];
      assert.equal(issues.length, 2, `${root}: expected both refs reported`);
      // The message names a file the reader can open — the REAL path, not the
      // synthetic key the lookup is done by.
      assert.ok(
        issues.every((i) => i.startsWith(`${root}/`)),
        `${root}: ${JSON.stringify(issues)}`,
      );
    } finally {
      cleanupTmpDir(dir);
    }
    // The browser twin, which reads the same map and had the same defect.
    assert.equal(
      (
        scanFiles({
          [`${root}/find-venue/SKILL.md`]: REF_A,
          [`${root}/verify-citations/SKILL.md`]: REF_B,
        }).skillRefIssues ?? []
      ).length,
      2,
      `${root}: scanFiles`,
    );
  }
});
