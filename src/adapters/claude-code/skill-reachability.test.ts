/**
 * Tests for the shipped-skill reachability alarm (`src/skill-reachability.ts`).
 *
 * The defect it exists for, observed in a real consumer repo: `npm install
 * vigiles` puts six user-facing skills on disk at `node_modules/vigiles/skills/`,
 * which Claude Code never scans. The skills are wired by the GLOBAL plugin
 * install (`vigiles init` → `claude plugin install vigiles@vigiles`), and until
 * that has run the skills are silently unreachable — a user can spend a day doing
 * exactly what `test-harness` teaches with the skill three directories away.
 *
 * The subtle part these tests pin down: the authoritative record of a user-scope
 * plugin install is `~/.claude/plugins/installed_plugins.json`, NOT the repo's
 * `.claude/settings.json`. Reading only `settings.json` (which carries
 * PROJECT-level `enabledPlugins`) reports a correctly-installed plugin as
 * missing — the exact misread that made this look like an npm packaging bug.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkSkillReachability,
  formatSkillReachability,
} from "./skill-reachability.js";
import { SHIPPED_SKILLS } from "../../setup-plan.js";
import { buildInstallReader } from "../../core/install-reader.js";
import type { InstallReader } from "../../core/adapter.js";
import { claudeCodeAdapter } from "./adapter.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

/** A repo that depends on vigiles, plus a fake $HOME to point the check at. */
function scaffold(opts: {
  readonly dependsOnVigiles?: boolean;
  /** Raw `~/.claude/plugins/installed_plugins.json`, or omitted for none. */
  readonly installedPlugins?: string;
  /** Raw repo `.claude/settings.json`, or omitted for none. */
  readonly settings?: string;
  /** Skill dir names to vendor into the repo's `.claude/skills/`. */
  readonly repoSkills?: readonly string[];
  /** Vendor the shipped skills into `node_modules/vigiles/skills/`. */
  readonly nodeModulesSkills?: boolean;
  /** Make the audited dir vigiles itself. */
  readonly self?: boolean;
}): {
  dir: string;
  home: string;
  read: InstallReader;
  cleanup: () => void;
} {
  const dir = makeTmpDir("reach-repo");
  const home = makeTmpDir("reach-home");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: opts.self ? "vigiles" : "consumer",
      devDependencies: opts.dependsOnVigiles === false ? {} : { vigiles: "^4" },
    }),
  );
  if (opts.self) {
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "vigiles" }),
    );
  }
  if (opts.installedPlugins !== undefined) {
    const p = join(home, ".claude", "plugins");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "installed_plugins.json"), opts.installedPlugins);
  }
  if (opts.settings !== undefined) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), opts.settings);
  }
  for (const s of opts.repoSkills ?? []) {
    const d = join(dir, ".claude", "skills", s);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  if (opts.nodeModulesSkills) {
    for (const s of SHIPPED_SKILLS) {
      const d = join(dir, "node_modules", "vigiles", "skills", s);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `---\nname: ${s}\n---\n`);
    }
  }
  return {
    dir,
    home,
    // The check reads through the DOMAIN's bounded reader now, not `node:fs`,
    // so the fixture hands it the real one built over this scaffold — the same
    // function the CLI wires, pointed at a throwaway repo and $HOME.
    read: buildInstallReader(claudeCodeAdapter, dir, { home }),
    cleanup: () => {
      cleanupTmpDir(dir);
      cleanupTmpDir(home);
    },
  };
}

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    "vigiles@vigiles": [
      { scope: "user", installPath: "/root/.claude/plugins/cache/vigiles" },
    ],
  },
});

/** settings.json that enables SOME OTHER plugin — the observed real-world state. */
const OTHER_PLUGIN_ONLY = JSON.stringify({
  enabledPlugins: { "superpowers@superpowers": true },
});

test("says nothing about a repo that does not depend on vigiles", () => {
  const s = scaffold({ dependsOnVigiles: false });
  try {
    assert.equal(checkSkillReachability(s.read), null);
  } finally {
    s.cleanup();
  }
});

test("says nothing when the audited dir IS the vigiles plugin itself", () => {
  const s = scaffold({ self: true });
  try {
    assert.equal(checkSkillReachability(s.read), null);
  } finally {
    s.cleanup();
  }
});

test("a user-scope install in the GLOBAL registry counts as reachable, even when settings.json enables only an unrelated plugin", () => {
  // The misread that started this: `.claude/settings.json` lists
  // `superpowers@superpowers` and no vigiles, which LOOKS un-wired — but
  // `claude plugin install` records a user-scope install in the global
  // registry, and that is what actually decides.
  const s = scaffold({
    installedPlugins: INSTALLED,
    settings: OTHER_PLUGIN_ONLY,
    nodeModulesSkills: true,
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, true);
    assert.deepEqual([...r.sources], ["global-plugin"]);
    // Reachable → the audit says nothing at all.
    assert.equal(formatSkillReachability(r), null);
  } finally {
    s.cleanup();
  }
});

test("a project-level enabledPlugins entry is NOT reachable on its own — Claude Code still requires an install", () => {
  // Per the Claude Code docs (Discover plugins → "Configure team marketplaces"),
  // as of CC v2.1.195: "A plugin that only the project's `.claude/settings.json`
  // enables, and that comes from an external source such as a GitHub repository
  // or npm package, doesn't load until the team member installs it."
  // vigiles ships from a GitHub marketplace, so it is exactly that case.
  // Treating this as reachable would silence the warning for a repo that is in
  // fact un-wired — the precise failure the check exists to prevent.
  const s = scaffold({
    settings: JSON.stringify({ enabledPlugins: { "vigiles@vigiles": true } }),
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
    assert.deepEqual([...r.sources], []);
    assert.equal(r.declaredNotInstalled, true);
  } finally {
    s.cleanup();
  }
});

test("declared-but-not-installed says so specifically, and names the per-machine install", () => {
  const s = scaffold({
    settings: JSON.stringify({ enabledPlugins: { "vigiles@vigiles": true } }),
  });
  try {
    const msg = formatSkillReachability(checkSkillReachability(s.read));
    assert.ok(msg);
    // It must NOT read as "you forgot to configure it" — the repo DID declare
    // it. The missing step is the per-machine install.
    assert.match(msg, /declares/i);
    assert.match(msg, /claude plugin install vigiles@vigiles/);
  } finally {
    s.cleanup();
  }
});

test("a global install PLUS a project declaration is reachable — the declaration is not harmful, just insufficient", () => {
  const s = scaffold({
    installedPlugins: INSTALLED,
    settings: JSON.stringify({ enabledPlugins: { "vigiles@vigiles": true } }),
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, true);
    assert.deepEqual([...r.sources], ["global-plugin"]);
    assert.equal(formatSkillReachability(r), null);
  } finally {
    s.cleanup();
  }
});

test("enabledPlugins set to FALSE is not reachable, and is not 'declared' either", () => {
  const s = scaffold({
    settings: JSON.stringify({ enabledPlugins: { "vigiles@vigiles": false } }),
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
    assert.equal(r.declaredNotInstalled, false);
  } finally {
    s.cleanup();
  }
});

test("skills vendored into the repo's .claude/skills count as reachable", () => {
  const s = scaffold({ repoSkills: ["test-harness"] });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, true);
    assert.deepEqual([...r.sources], ["repo-skills"]);
  } finally {
    s.cleanup();
  }
});

test("unrelated repo skills do NOT count — 38 skills, none of them vigiles', is still un-wired", () => {
  const s = scaffold({
    repoSkills: ["argument-arc", "handoff", "session-retro"],
    settings: OTHER_PLUGIN_ONLY,
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
    assert.deepEqual([...r.sources], []);
  } finally {
    s.cleanup();
  }
});

test("un-wired + skills stranded in node_modules is LOUD, names the stranded skills, and gives the fix", () => {
  const s = scaffold({
    settings: OTHER_PLUGIN_ONLY,
    nodeModulesSkills: true,
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
    assert.deepEqual([...r.strandedSkills], [...SHIPPED_SKILLS]);

    const msg = formatSkillReachability(r);
    assert.ok(msg, "an un-wired repo must produce a warning");
    // It must name the skill the user could not find, say WHERE it is
    // stranded, and give a command that fixes it.
    assert.match(msg, /test-harness/);
    assert.match(msg, /node_modules/);
    assert.match(msg, /claude plugin install vigiles@vigiles/);
  } finally {
    s.cleanup();
  }
});

test("un-wired with NOTHING in node_modules still warns, without claiming stranded skills", () => {
  const s = scaffold({ settings: OTHER_PLUGIN_ONLY });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
    assert.deepEqual([...r.strandedSkills], []);
    const msg = formatSkillReachability(r);
    assert.ok(msg);
    assert.doesNotMatch(msg, /node_modules/);
  } finally {
    s.cleanup();
  }
});

test("malformed JSON anywhere degrades to un-wired instead of throwing", () => {
  const s = scaffold({
    installedPlugins: "{ not json",
    settings: "also not json",
    nodeModulesSkills: true,
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
  } finally {
    s.cleanup();
  }
});

test("an unreadable package.json means we cannot tell — say nothing rather than guess", () => {
  const dir = makeTmpDir("reach-nopkg");
  const home = makeTmpDir("reach-home");
  try {
    assert.equal(
      checkSkillReachability(
        buildInstallReader(claudeCodeAdapter, dir, { home }),
      ),
      null,
    );
  } finally {
    cleanupTmpDir(dir);
    cleanupTmpDir(home);
  }
});

test("a plain `dependencies` entry counts, not just devDependencies", () => {
  const dir = makeTmpDir("reach-dep");
  const home = makeTmpDir("reach-home");
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "c", dependencies: { vigiles: "^4" } }),
    );
    const r = checkSkillReachability(
      buildInstallReader(claudeCodeAdapter, dir, { home }),
    );
    assert.ok(r);
    assert.equal(r.reachable, false);
  } finally {
    cleanupTmpDir(dir);
    cleanupTmpDir(home);
  }
});

test("an empty install record for vigiles is not an install", () => {
  const s = scaffold({
    installedPlugins: JSON.stringify({
      version: 2,
      plugins: { "vigiles@vigiles": [] },
    }),
  });
  try {
    const r = checkSkillReachability(s.read);
    assert.ok(r);
    assert.equal(r.reachable, false);
  } finally {
    s.cleanup();
  }
});

test("formatSkillReachability(null) is null — nothing to say", () => {
  assert.equal(formatSkillReachability(null), null);
});
