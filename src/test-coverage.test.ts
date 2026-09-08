/**
 * Untested-surface detector test suite.
 *
 * Pure, filesystem-driven: build a tiny fake plugin in a tmp dir and assert the
 * ONE coverage detector (colocation), the user-invoked exemption, the
 * ignore-marker opt-out, hook-script discovery, and the report formatting. No
 * model, no network.
 *
 * Several tests here are INVERSIONS of ones that used to assert the opposite —
 * a name-mention and a `vigiles:covers` declaration both used to confer
 * coverage. They are kept as inversions rather than deleted so the removal is
 * pinned: a future re-introduction of either tier fails these.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  coverageEvidenceCounts,
  findUntestedSurfaces,
  coverageCaveats,
  formatUntestedReport,
  skillTestNudge,
  evalTierQuestion,
  suggestedTestPath,
} from "./test-coverage.js";
import { findUntestedSurfacesInFiles } from "./test-coverage-files.js";
import { isEvalScript } from "./coverage-evidence.js";
import { SCRIPT_EXTS } from "./adapters/claude-code/run-scripts.js";
import { surfaceSha } from "./coverage-artifact.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { codexLayout } from "./adapters/codex/layout.js";
import { testFileExt } from "./core/test-file-ext.js";
import { canRunTypeScript, detectNodeCaps } from "./ts-runner-caps.js";
import { interpreterArgs } from "./adapters/claude-code/run-scripts.js";

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function skill(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: A skill that does ${name} things for tests\n${extra}---\n\n# ${name}\n`;
}

test("surface discovery + hook-token are layout-driven (non-CC harness)", () => {
  // A harness with its OWN surface dirs and plugin-root token — proves the
  // de-CC-ing: skills/agents are found at the layout's dirs and a hook script is
  // resolved through the layout's token, NOT hard-coded `skills/`/`agents/`/
  // `${CLAUDE_PLUGIN_ROOT}`. (Regression guard for the scan.ts/test-coverage.ts
  // hard-codings.)
  const dir = makeTmpDir("tc-layout");
  write(dir, "mysurf/skill/foo/SKILL.md", skill("foo"));
  write(dir, "mysurf/agent/bar.md", skill("bar"));
  write(dir, "hooks/present.sh", "#!/bin/sh\n");
  write(
    dir,
    "my-manifest.json",
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { hooks: [{ command: "$MY_PLUGIN_ROOT/hooks/present.sh" }] },
        ],
      },
    }),
  );

  const layout = {
    ...claudeCodeLayout,
    skillDir: "mysurf/skill",
    agentDir: "mysurf/agent",
    commandDir: "mysurf/command",
    materializeRoot: "",
    manifestPath: "my-manifest.json",
    pluginRootToken: "${MY_PLUGIN_ROOT}",
  };

  const r = findUntestedSurfaces({ basePath: dir, layout });
  const byKind = (k: string) =>
    r.untested.filter((s) => s.kind === k).map((s) => s.name);
  assert.deepEqual(byKind("skill"), ["foo"], "skill found at layout.skillDir");
  assert.deepEqual(byKind("agent"), ["bar"], "agent found at layout.agentDir");
  assert.deepEqual(
    byKind("hook"),
    ["present"],
    "hook resolved via layout.pluginRootToken (unbraced $MY_PLUGIN_ROOT)",
  );

  // The default Claude Code layout sees none of it (different dirs/token).
  assert.equal(findUntestedSurfaces({ basePath: dir }).total, 0);
  cleanupTmpDir(dir);
});

test("skill is covered by a colocated eval", () => {
  const dir = makeTmpDir("tc-coloc");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.eval.mjs", "// trigger eval\n");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 0);
  assert.deepEqual(
    r.covered.map((s) => s.name),
    ["foo"],
  );
  cleanupTmpDir(dir);
});

test("loose skill under .claude/skills is covered by its colocated eval", () => {
  // Regression: the suggested eval lives under a DOT dir, so a globstar test
  // glob without `dot:true` never found it and the surface looked untested
  // even after the user added exactly the file the warning recommended.
  const dir = makeTmpDir("tc-dotdir");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  const before = findUntestedSurfaces({ basePath: dir });
  assert.equal(before.untested.length, 1, "skill is found and flagged first");
  assert.equal(
    suggestedTestPath(before.untested[0]),
    ".claude/skills/foo/foo.eval.mjs",
  );

  // Add exactly the suggested colocated eval — it must now count as covered.
  write(dir, ".claude/skills/foo/foo.eval.mjs", "// trigger eval\n");
  const after = findUntestedSurfaces({ basePath: dir });
  assert.equal(after.untested.length, 0);
  assert.deepEqual(
    after.covered.map((s) => s.name),
    ["foo"],
  );
  cleanupTmpDir(dir);
});

test("a test that only NAMES the skill does NOT cover it", () => {
  // Was "content-reference covers it". Inverted 2026-08-11: naming a surface is
  // not testing it, and the tier that believed otherwise supplied 9 of vigiles's
  // own 10 covered surfaces with at least three of them false.
  const dir = makeTmpDir("tc-ref");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "test/foo.eval.mjs", 'skillResolved(t, "myplugin:foo");\n');
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.untested.map((x) => x.name),
    ["foo"],
  );
  cleanupTmpDir(dir);
});

test("skill with no test is flagged", () => {
  const dir = makeTmpDir("tc-untested");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 1);
  assert.equal(r.untested[0].name, "foo");
  cleanupTmpDir(dir);
});

test("a command-only (disable-model-invocation) skill is NOT exempt — it still needs a test", () => {
  const dir = makeTmpDir("tc-userinvoked");
  write(
    dir,
    "skills/cmd/SKILL.md",
    skill("cmd", "disable-model-invocation: true\n"),
  );
  const r = findUntestedSurfaces({ basePath: dir });
  // Invocation mode no longer exempts anything: the command-only skill is held
  // to the requirement like any other and flagged when it has no test.
  assert.equal(r.total, 1);
  assert.equal(r.exempt, 0);
  assert.equal(r.untested.length, 1);
  assert.equal(r.untested[0].name, "cmd");
  cleanupTmpDir(dir);
});

test("vigiles:ignore-test marker is the only exemption (and is counted)", () => {
  const dir = makeTmpDir("tc-ignore");
  write(
    dir,
    "skills/foo/SKILL.md",
    skill("foo") + "\n<!-- vigiles:ignore-test -->\n",
  );
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.total, 0); // nothing held to the requirement
  assert.equal(r.exempt, 1); // the explicit opt-out is visible, not silent
  assert.equal(r.untested.length, 0);
  cleanupTmpDir(dir);
});

test("agent is covered by a name-prefixed sibling, flagged otherwise", () => {
  const dir = makeTmpDir("tc-agent");
  write(dir, "agents/planner.md", "---\nname: planner\n---\nbody\n");
  write(dir, "agents/reviewer.md", "---\nname: reviewer\n---\nbody\n");
  write(dir, "agents/planner.harness.mjs", "// planner test\n");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.covered.map((s) => s.name),
    ["planner"],
  );
  assert.deepEqual(
    r.untested.map((s) => s.name),
    ["reviewer"],
  );
  cleanupTmpDir(dir);
});

test("a hook rooted at the PROJECT var is discovered — not just the PLUGIN var", () => {
  // 🔴 A WHOLE SURFACE KIND WAS INVISIBLE. Only `${CLAUDE_PLUGIN_ROOT}` was
  // stripped, so `"$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` — Claude Code's
  // DOCUMENTED spelling for a project hook, used because hooks do not run with a
  // stable cwd — kept its literal prefix, failed `existsSync`, and was dropped
  // without a word.
  //
  // MEASURED on a real consumer repo, four numbers for the same thing:
  //   19 hook ENTRIES in settings · 16 inventoried by `audit` (every one printed
  //   "unresolved var — can't check") · 17 FILES in `.claude/hooks/` (two are not
  //   hooks) · 0 hook SURFACES. After the fix: 14, which is exactly the
  //   registered scripts under `.claude/hooks/`.
  const dir = makeTmpDir("cov-hooks-projvar");
  const hook = (n: string): void => {
    write(dir, `.claude/hooks/${n}`, "#!/bin/sh\n");
  };
  for (const n of ["a.sh", "b.mjs", "c.hook.ts", "d.sh"]) hook(n);
  write(dir, "node_modules/vigiles/dist/cli.js", "// the runtime\n");
  const cmd = (c: string) => ({
    matcher: "Bash",
    hooks: [{ type: "command", command: c }],
  });
  write(
    dir,
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        PreToolUse: [
          cmd('"$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh"'),
          cmd('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/b.mjs" post'),
          // The compiled-hook shape: the RUNTIME is a dependency, the operand is
          // the surface. Both are extracted from this one command.
          cmd(
            'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" ' +
              'hook-runtime run-program "$CLAUDE_PROJECT_DIR/.claude/hooks/c.hook.ts"',
          ),
          // No variable at all still works, and so does the plugin root.
          cmd(".claude/hooks/d.sh"),
        ],
      },
    }),
  );
  const names = findUntestedSurfaces({ basePath: dir })
    .untested.filter((x) => x.kind === "hook")
    .map((x) => x.path)
    .sort();
  assert.deepEqual(names, [
    ".claude/hooks/a.sh",
    ".claude/hooks/b.mjs",
    ".claude/hooks/c.hook.ts",
    ".claude/hooks/d.sh",
  ]);
  // ⚠️ A DEPENDENCY IS NOT A SURFACE. The same settings name the runtime that
  // runs the compiled hooks; holding `node_modules/vigiles/dist/cli.js` to
  // `untested-hook` would ask the author to test their package manager.
  assert.ok(
    !names.some((n) => n.includes("node_modules")),
    "a node_modules path must never be a surface",
  );

  // QUIET: a path that does not exist is still not a surface — stripping a token
  // must not turn a typo into a discovery.
  const dir2 = makeTmpDir("cov-hooks-projvar-missing");
  write(
    dir2,
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        PreToolUse: [cmd('"$CLAUDE_PROJECT_DIR/.claude/hooks/nope.sh"')],
      },
    }),
  );
  assert.deepEqual(
    findUntestedSurfaces({ basePath: dir2 }).untested.filter(
      (x) => x.kind === "hook",
    ),
    [],
  );
  cleanupTmpDir(dir);
  cleanupTmpDir(dir2);
});

test("the BROWSER twin reads the PROJECT var too — one settings file, one reader", () => {
  // 🔴 THE TWIN WAS LEFT BEHIND BY THE FIX ABOVE. The disk detector learned the
  // project token; `findUntestedSurfacesInFiles` — the engine `scanFiles` runs
  // against a GitHub file map, with no disk — still stripped only the PLUGIN
  // token, so the very same settings.json that yields four hook surfaces on disk
  // yielded ONE in the browser. Same defect, same file, second reader: the audit
  // under-reported the untested-hook count and therefore the score.
  //
  // This is the parity assertion, not a restatement: the two engines are handed
  // the SAME repo and must name the SAME hooks. It is written as an equality
  // against the disk result so it cannot pass by agreeing on the wrong answer —
  // the disk expectation is pinned by the test directly above.
  const cmd = (c: string) => ({
    matcher: "Bash",
    hooks: [{ type: "command", command: c }],
  });
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [
        cmd('"$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh"'),
        cmd('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/b.mjs" post'),
        cmd(
          'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" ' +
            'hook-runtime run-program "$CLAUDE_PROJECT_DIR/.claude/hooks/c.hook.ts"',
        ),
        cmd(".claude/hooks/d.sh"),
      ],
    },
  });
  const files: Record<string, string> = {
    ".claude/settings.json": settings,
    ".claude/hooks/a.sh": "#!/bin/sh\n",
    ".claude/hooks/b.mjs": "#!/bin/sh\n",
    ".claude/hooks/c.hook.ts": "#!/bin/sh\n",
    ".claude/hooks/d.sh": "#!/bin/sh\n",
    "node_modules/vigiles/dist/cli.js": "// the runtime\n",
  };
  const names = findUntestedSurfacesInFiles(files, claudeCodeLayout, "repo")
    .untested.filter((x) => x.kind === "hook")
    .map((x) => x.path)
    .sort();
  assert.deepEqual(names, [
    ".claude/hooks/a.sh",
    ".claude/hooks/b.mjs",
    ".claude/hooks/c.hook.ts",
    ".claude/hooks/d.sh",
  ]);
  // ⚠️ A DEPENDENCY IS NOT A SURFACE — the disk detector skips `node_modules/`,
  // and the twin did not even have that branch. A file map fetched from a repo
  // that vendors its runtime would have handed the author their package manager
  // to test.
  assert.ok(
    !names.some((n) => n.includes("node_modules")),
    "a node_modules path must never be a surface",
  );

  // QUIET: stripping a token must not turn a typo into a discovery. The map has
  // no such file, so nothing is found — same as the disk twin's quiet half.
  assert.deepEqual(
    findUntestedSurfacesInFiles(
      {
        ".claude/settings.json": JSON.stringify({
          hooks: {
            PreToolUse: [cmd('"$CLAUDE_PROJECT_DIR/.claude/hooks/nope.sh"')],
          },
        }),
      },
      claudeCodeLayout,
      "repo",
    ).untested.filter((x) => x.kind === "hook"),
    [],
  );
});

test("`.eval.` in the MIDDLE of a name is not the paid tier — the runner would never run it", () => {
  // 🔴 THE TIER SPLIT CLAIMED A SURFACE WAS EVAL-COVERED BY A FILE NO RUNNER
  // RUNS. The splitter tested `.eval.` as an INFIX, so a colocated deterministic
  // test named `parser.eval.test.ts` — picked up by an `include` of
  // `**/*.test.ts` — was pushed into the paid EVAL tier and REMOVED from the
  // free one. But `vigiles eval` discovers `**/*.eval.{mjs,cjs,js,mts,cts,ts}`
  // (scriptGlob, SCRIPT_EXTS in adapters/claude-code/run-scripts.ts): the name
  // ends `.test.ts`, so the eval runner never sees it. The surface was reported
  // as covered by the tier that cannot run it and uncovered by the tier that
  // does — exactly backwards.
  const dir = makeTmpDir("cov-eval-infix");
  write(
    dir,
    ".claude/skills/parser/SKILL.md",
    "---\nname: parser\n---\nbody\n",
  );
  write(dir, ".claude/skills/parser/parser.eval.test.ts", "// deterministic\n");
  const r = findUntestedSurfaces({
    basePath: dir,
    include: ["**/*.test.ts"],
  });
  assert.deepEqual(
    r.harness.covered.map((s) => s.name),
    ["parser"],
    "a *.test.ts file is deterministic — it belongs to the FREE tier",
  );
  assert.deepEqual(
    r.evals.covered.map((s) => s.name),
    [],
    "nothing the paid runner can discover covers this surface",
  );
  cleanupTmpDir(dir);
});

test("…and the money hazard the infix was guarding stays closed", () => {
  // The infix was not arbitrary: it replaced the full suffix `.eval.mjs` because
  // `foo.eval.ts` would then have fallen into the FREE branch and been run on
  // every push, spending real model calls in CI. Narrowing to a SUFFIX must not
  // reopen that — every extension the eval runner accepts still lands paid.
  // The list is SCRIPT_EXTS, read from the runner, not from memory.
  for (const ext of SCRIPT_EXTS) {
    const dir = makeTmpDir(`cov-eval-paid-${ext}`);
    write(dir, ".claude/skills/p/SKILL.md", "---\nname: p\n---\nbody\n");
    write(dir, `.claude/skills/p/p.eval.${ext}`, "// paid\n");
    const r = findUntestedSurfaces({ basePath: dir });
    assert.deepEqual(
      r.evals.covered.map((s) => s.name),
      ["p"],
      `.eval.${ext} must be the PAID tier`,
    );
    assert.deepEqual(
      r.harness.covered.map((s) => s.name),
      [],
      `.eval.${ext} must NOT be run by the free per-push tier`,
    );
    cleanupTmpDir(dir);
  }
});

test("the eval-suffix rule is pinned to the extensions the runner really globs", () => {
  // The predicate lives in coverage-evidence.ts (browser-safe, both twins route
  // through it) and therefore re-declares the extension list rather than
  // importing the node-only runner module. This is the assertion that keeps the
  // copy honest: if SCRIPT_EXTS gains an extension, the splitter must gain it
  // too, or a paid file starts running on every push again.
  for (const ext of SCRIPT_EXTS) {
    assert.ok(
      isEvalScript(`x.eval.${ext}`),
      `SCRIPT_EXTS has .${ext} but the tier splitter does not know it`,
    );
  }
  assert.ok(!isEvalScript("parser.eval.test.ts"));
  assert.ok(!isEvalScript("evaluate.ts"));
  assert.ok(!isEvalScript("x.eval.mjs.bak"));
  assert.ok(!isEvalScript("x.harness.ts"));
});

test("hook scripts are discovered from plugin.json and matched by path", () => {
  const dir = makeTmpDir("tc-hooks");
  write(dir, "hooks/pre-edit.sh", "#!/usr/bin/env bash\n");
  write(dir, "hooks/post-edit.sh", "#!/usr/bin/env bash\n");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "p",
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-edit.sh",
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/post-edit.sh",
              },
            ],
          },
        ],
      },
    }),
  );
  // A unit test elsewhere that drives pre-edit BY PATH now covers nothing —
  // naming a hook is not testing it. This is the exact shape by which the
  // detector's own suite used to grant coverage to these two hooks.
  write(dir, "src/hooks.test.ts", 'runHook("hooks/pre-edit.sh", {});\n');
  let r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.total, 2);
  assert.deepEqual(r.untested.map((s) => s.name).sort(), [
    "post-edit",
    "pre-edit",
  ]);

  // A hook is covered by a name-prefixed SIBLING — placement, not mention.
  write(dir, "hooks/pre-edit.harness.mjs", "assert.ok(true);\n");
  r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.covered.map((s) => s.name),
    ["pre-edit"],
  );
  assert.deepEqual(
    r.untested.map((s) => s.name),
    ["post-edit"],
  );
  cleanupTmpDir(dir);
});

test("per-surface kind toggles disable scanning", () => {
  const dir = makeTmpDir("tc-toggle");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  const r = findUntestedSurfaces({ basePath: dir, skills: false });
  assert.equal(r.total, 0);
  cleanupTmpDir(dir);
});

test("formatUntestedReport: clean vs flagged, suggestedTestPath", () => {
  const dir = makeTmpDir("tc-fmt");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  const flagged = findUntestedSurfaces({ basePath: dir });
  const text = formatUntestedReport(flagged);
  assert.ok(text.includes("1 surface(s) with no test"));
  assert.ok(text.includes("skills/foo/foo.eval.mjs"));
  // The footer points at include for an external test loop (issue #113).
  assert.ok(text.includes("include"));
  assert.equal(
    suggestedTestPath(flagged.untested[0]),
    "skills/foo/foo.eval.mjs",
  );

  write(dir, "skills/foo/foo.eval.mjs", "// covered\n");
  const clean = findUntestedSurfaces({ basePath: dir });
  assert.ok(formatUntestedReport(clean).startsWith("✓"));
  cleanupTmpDir(dir);
});

test("discovers a bare SKILL.md AT the base (single-skill-dir target)", () => {
  // When lint/audit is pointed at one skill dir, the SKILL.md is at the base
  // itself, not under `skills/*/`. Without this the untested-skill check would
  // silently vanish for exactly that target.
  const dir = makeTmpDir("cov-solo");
  write(dir, "SKILL.md", "---\nname: solo\ndescription: x\n---\nbody\n");
  const report = findUntestedSurfaces({ basePath: dir });
  const found = report.untested.find((s) => s.kind === "skill");
  assert.ok(found, "the root SKILL.md is reported as an untested skill");
  assert.equal(found.path, "SKILL.md");
  cleanupTmpDir(dir);
});

test("a root SKILL.md is COVERED by a colocated eval (single-skill-dir target)", () => {
  // A colocated `solo.eval.mjs` beside a root SKILL.md must count as coverage —
  // globSync returns it without a "./" prefix, which the colocation check now
  // handles for a "." dir. Else the documented single-skill target false-fails CI.
  const dir = makeTmpDir("cov-solo-eval");
  write(dir, "SKILL.md", "---\nname: solo\ndescription: x\n---\nbody\n");
  write(dir, "solo.eval.mjs", "// colocated eval\n");
  const report = findUntestedSurfaces({ basePath: dir });
  assert.equal(
    report.untested.filter((s) => s.kind === "skill").length,
    0,
    "the colocated solo.eval.mjs covers the root SKILL.md",
  );
  cleanupTmpDir(dir);
});

// ── Two tiers, split at DISCOVERY ────────────────────────────────────────────
// A harness (`*.harness.mjs`, `*.test.*`) is free and runs on every push; an eval
// (`*.eval.mjs`) spends real model calls on a schedule and is the ONLY thing that
// answers "does this skill fire?". Erasing that at discovery makes it
// unrecoverable downstream — hence a per-tier split, not a display tweak.

test("tiers split at discovery: a harness-only skill is NOT evaluated, and vice versa", () => {
  const dir = makeTmpDir("cov-tiers");
  write(dir, "skills/harnessed/SKILL.md", skill("harnessed"));
  write(dir, "skills/harnessed/harnessed.harness.mjs", "// deterministic\n");
  write(dir, "skills/evaled/SKILL.md", skill("evaled"));
  write(dir, "skills/evaled/evaled.eval.mjs", "// real model\n");
  write(dir, "skills/bare/SKILL.md", skill("bare"));

  const r = findUntestedSurfaces({ basePath: dir });
  const names = (ss: readonly { name: string }[]) =>
    ss.map((s) => s.name).sort();

  // The UNION is unchanged: a test anywhere counts.
  assert.deepEqual(names(r.untested), ["bare"]);
  assert.deepEqual(names(r.covered), ["evaled", "harnessed"]);

  // The tiers disagree, which is the whole point — "has deterministic coverage,
  // no evals" is a different position from "has neither".
  assert.deepEqual(names(r.harness.covered), ["harnessed"]);
  assert.deepEqual(names(r.harness.untested), ["bare", "evaled"]);
  assert.deepEqual(names(r.evals.covered), ["evaled"]);
  assert.deepEqual(names(r.evals.untested), ["bare", "harnessed"]);
  cleanupTmpDir(dir);
});

test("a `*.test.ts` is NOT a vigiles test — it is the one name a foreign runner claims", () => {
  // INVERSION, 2026-08-11. This used to assert the opposite: `*.test.*` counted as
  // the deterministic tier. It was removed, and the reason is money.
  //
  // vigiles never RAN those files, but crediting them made the name reasonable —
  // so an author writes `skills/foo/foo.test.mjs`, and then `npx vitest` runs it,
  // because that name matches vitest's and jest's DEFAULT patterns exactly (read
  // out of the installed packages). A skill test calls runHarnessTest /
  // measureTriggerRate: it spawns a model. The accident is a silent bill, on every
  // push, in CI. Measured in a spike: a bare project with that file, plain
  // `npx vitest run`, and it executed — a dot-directory does not hide it.
  const dir = makeTmpDir("cov-tier-ts");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.test.ts", 'import "./SKILL.md";\n');
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.untested.map((s) => s.name),
    ["foo"],
  );
  cleanupTmpDir(dir);
});

test("…and the same file renamed to `.harness.ts` DOES count — TypeScript is first-class", () => {
  // The quiet half, and a feature in its own right: `.harness.ts` matched NOTHING
  // before, so a TypeScript project got no credit for a test it had written. Node
  // 22 runs `.ts`/`.mts`/`.cts` directly (type stripping, no toolchain) — measured.
  const dir = makeTmpDir("cov-tier-ts-ok");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.harness.ts", "const n: number = 1;\n");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.untested.map((s) => s.name),
    [],
  );
  assert.deepEqual(
    r.harness.untested.map((s) => s.name),
    [],
  );
  // …and it is the FREE tier: nothing has measured firing.
  assert.deepEqual(
    r.evals.untested.map((s) => s.name),
    ["foo"],
  );
  cleanupTmpDir(dir);
});

test("🔴 `foo.eval.ts` is the PAID tier — the split is by infix, not by `.eval.mjs`", () => {
  // The hazard that arrives WITH TypeScript support if the split is left alone:
  // the old test was `path.endsWith(".eval.mjs")`, so `foo.eval.ts` would have
  // landed in the harness branch — a file that spends real model calls, classified
  // as the free tier and run on every push. Accepting TS without this is worse than
  // not accepting it.
  const dir = makeTmpDir("cov-eval-ts");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.eval.ts", "const n: number = 1;\n");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.evals.untested.map((s) => s.name),
    [],
    "counted as the PAID tier",
  );
  assert.deepEqual(
    r.harness.untested.map((s) => s.name),
    ["foo"],
    "and NOT as the free one — an eval must never be mistaken for a per-push test",
  );
  cleanupTmpDir(dir);
});

test("a clean UNION still says when nothing has measured firing", () => {
  // Every surface has a deterministic harness, so the gate passes — but no
  // `*.eval.mjs` exists, so nothing has measured that the skill fires. A bare ✓
  // there would read as "firing verified" when the question was never asked.
  const dir = makeTmpDir("cov-clean-noeval");
  write(dir, "skills/a/SKILL.md", skill("a"));
  write(dir, "skills/a/a.harness.mjs", "// deterministic only\n");
  const harnessOnly = formatUntestedReport(
    findUntestedSurfaces({ basePath: dir }),
  );
  assert.ok(harnessOnly.startsWith("✓"), harnessOnly);
  assert.ok(harnessOnly.includes("no `*.eval.mjs`"), harnessOnly);
  assert.ok(harnessOnly.includes("actually fire"), harnessOnly);

  // Add the eval and the caveat disappears — a plain ✓, nothing left unasked.
  write(dir, "skills/a/a.eval.mjs", "// real model\n");
  const both = formatUntestedReport(findUntestedSurfaces({ basePath: dir }));
  assert.ok(both.startsWith("✓"), both);
  assert.ok(!both.includes("eval.mjs`"), both);
  cleanupTmpDir(dir);
});

test("formatUntestedReport names the two gaps SEPARATELY (no test/eval slash)", () => {
  const dir = makeTmpDir("cov-tier-fmt");
  write(dir, "skills/a/SKILL.md", skill("a"));
  write(dir, "skills/a/a.harness.mjs", "// deterministic only\n");
  write(dir, "skills/b/SKILL.md", skill("b"));
  const text = formatUntestedReport(findUntestedSurfaces({ basePath: dir }));
  // Only `b` is in the union list…
  assert.ok(text.includes("1 surface(s) with no test"));
  // …but the breakdown says 1 needs a harness and 2 need firing measured, with
  // the cost of each named. One number could not have said that.
  assert.ok(
    text.includes(
      "Two gaps, two costs: 1 with no deterministic harness (free, every push) · 2 whose firing was never measured",
    ),
    text,
  );
  cleanupTmpDir(dir);
});

// ── Evidence: a STRING is not a test ─────────────────────────────────────────
// The detector used to count any occurrence of a surface's path/namespace ANYWHERE
// in a discovered test file. Measured on a real repo (37 skills, 14 hooks),
// appending one COMMENT line — `// probe: skills/argument-arc` — moved the
// untested count 33 → 32. Meanwhile a harness that genuinely asserts over 21
// skills but builds its paths at runtime contained no literal `skills/<name>` and
// covered nothing: generality was penalised, gaming was free.

test("a surface named ONLY in a comment is NOT covered (the one-line probe)", () => {
  const dir = makeTmpDir("cov-comment-probe");
  write(dir, "skills/argument-arc/SKILL.md", skill("argument-arc"));
  // Verbatim shape of the reproduction: a real harness file, plus a comment that
  // happens to spell the surface's path. Nothing asserts anything about it.
  write(
    dir,
    "test/pipeline.harness.mjs",
    [
      "import { readFileSync } from 'node:fs';",
      "// probe: skills/argument-arc",
      "export default () => readFileSync('unrelated.txt');",
      "",
    ].join("\n"),
  );
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.untested.map((s) => s.name),
    ["argument-arc"],
    "a comment is prose about a test, not a test",
  );
  cleanupTmpDir(dir);
});

test("a declaration cannot confer coverage on a file that asserts nothing", () => {
  // The lie this removal exists to stop: a file whose entire content is a
  // `vigiles:covers` comment used to report BOTH surfaces as tested.
  const dir = makeTmpDir("cov-liar");
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  write(dir, "skills/beta/SKILL.md", skill("beta"));
  write(
    dir,
    "test/liar.harness.mjs",
    "// vigiles:covers skills/alpha, skills/beta\n",
  );
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(r.untested.map((x) => x.name).sort(), ["alpha", "beta"]);
  cleanupTmpDir(dir);
});

test("coverage cannot be changed by editing text INSIDE a test file", () => {
  // Placement decides coverage now, so the detector never reads a test's
  // contents — which is what made the old metric editable by one comment line.
  const dir = makeTmpDir("cov-content-blind");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(
    dir,
    "test/foo.test.ts",
    'loadSkill("skills/foo"); // vigiles:covers skills/foo\n',
  );
  assert.equal(findUntestedSurfaces({ basePath: dir }).untested.length, 1);
  cleanupTmpDir(dir);
});

test("a runtime-path harness covers nothing until its tests are colocated", () => {
  // The honest cost of colocation-only, pinned rather than hidden: a harness
  // that really does assert over both skills but assembles paths at runtime
  // counts for neither. The fix is a test inside each skill's directory, not a
  // marker claiming credit from afar.
  const dir = makeTmpDir("cov-runtime");
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  write(dir, "skills/beta/SKILL.md", skill("beta"));
  write(
    dir,
    "test/pipeline.harness.mjs",
    [
      "// vigiles:covers skills/alpha, skills/beta",
      "for (const name of ['alpha', 'beta']) {",
      "  assertFrontmatter(join(root, 'skills', name, 'SKILL.md'));",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(findUntestedSurfaces({ basePath: dir }).untested.length, 2);

  // Colocate one, and exactly one flips.
  write(dir, "skills/alpha/alpha.harness.mjs", "assert.ok(true);\n");
  const after = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    after.untested.map((x) => x.name),
    ["beta"],
  );
  assert.deepEqual(coverageEvidenceCounts(after), {
    executed: 0,
    colocated: 1,
    configured: 0,
  });
  cleanupTmpDir(dir);
});

test("provenance is reported, and says placement is not proof of a run", () => {
  const dir = makeTmpDir("cov-provenance");
  write(dir, "skills/covered/SKILL.md", skill("covered"));
  write(dir, "skills/covered/covered.eval.mjs", "assert.ok(true);\n");
  const report = formatUntestedReport(findUntestedSurfaces({ basePath: dir }));
  assert.match(report, /1 colocated/);
  // The remaining hole is NAMED in the output rather than left for the reader
  // to discover: an empty colocated file still counts.
  assert.match(report, /EXISTS, not/);
  cleanupTmpDir(dir);
});

test("an EMPTY colocated file still counts — the known, reported hole", () => {
  // Pinned deliberately, and still true of the FALLBACK tier: colocation proves
  // placement, not execution. What changed on 2026-08-11 is that a recorded run
  // OUTRANKS it (the `executed` block at the end of this file), so a surface
  // answered by colocation is one that nothing has ever been run against. The
  // report says so out loud, so the number is not read as more than it is.
  const dir = makeTmpDir("cov-empty");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.eval.mjs", "");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 0);
  assert.deepEqual(coverageEvidenceCounts(r), {
    executed: 0,
    colocated: 1,
    configured: 0,
  });
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// skillTestNudge — the edit-time delivery of `untested-skill`.
//
// The rule was already stated correctly; it only ever ran inside `vigiles lint`,
// which someone has to type. These pin the four behaviours that make the nudge
// worth wiring: it fires on an untested surface, it distinguishes "never
// evaluated" from "no test at all", it stays silent when covered, and it always
// hands off to the `test-harness` skill rather than restating "write a test".
// ---------------------------------------------------------------------------

test("skillTestNudge: an untested skill gets a nudge that names the test-harness skill", () => {
  const dir = makeTmpDir("nudge-untested");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  const msg = skillTestNudge("skills/foo/SKILL.md", { basePath: dir });
  assert.ok(msg, "an untested skill must produce a nudge");
  // The load-bearing property: it points at the vocabulary, not at the duty.
  assert.match(msg, /test-harness/);
  assert.match(msg, /measureTriggerRate/);
  // …and it tells the agent where to put the result.
  assert.match(msg, /skills\/foo\/foo\.eval\.mjs/);
  // A nudge must never read as a gate.
  assert.match(msg, /not a block/);
  cleanupTmpDir(dir);
});

test("skillTestNudge: a harness-covered skill is nudged about FIRING, not about tests", () => {
  // The case an edit to a SKILL.md usually IS: the description (= the trigger
  // surface) changed, and a deterministic harness structurally cannot tell you
  // whether it still fires.
  const dir = makeTmpDir("nudge-uneval");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.harness.mjs", "// vigiles:covers skills/foo\n");
  const msg = skillTestNudge("skills/foo/SKILL.md", { basePath: dir });
  assert.ok(msg, "covered-but-never-evaluated must still nudge");
  assert.match(msg, /FIRES/);
  assert.match(msg, /measureTriggerRate/);
  // It must NOT claim the surface is untested — it isn't.
  assert.doesNotMatch(msg, /no test or eval covers it/);
  // 🔴 …and it must name the DRIVER argument. The nudge is layout-aware, so it
  // reaches repos targeting a harness other than the eval tier's default, and a
  // bare `measureTriggerRate(spec)` falls back to that default driver — it does
  // not fail, it measures a DIFFERENT harness and reports a number. A remedy that
  // silently answers about someone else's harness is worse than no remedy.
  assert.match(msg, /evalDriver/);
  assert.match(msg, /DEFAULT harness/);
  cleanupTmpDir(dir);
});

test("skillTestNudge: the firing remedy is runnable on a NON-default harness too", () => {
  // The half that pins the reason. Same repo shape, Codex layout: the surfaces
  // live under `.codex/`, the nudge finds them (that is what layout-awareness
  // bought), and the remedy it prints must be one this repo can actually run.
  const dir = makeTmpDir("nudge-uneval-codex");
  write(dir, ".codex/skills/foo/SKILL.md", skill("foo"));
  write(dir, ".codex/skills/foo/foo.harness.mjs", "// deterministic only\n");
  const msg = skillTestNudge(".codex/skills/foo/SKILL.md", {
    basePath: dir,
    layout: codexLayout,
  });
  assert.ok(msg, "a Codex repo's skill must still be nudged about firing");
  assert.match(msg, /FIRES/);
  // Runnable: `measureTriggerRate(spec, { evalDriver: codexEvalDriver })` is
  // exported from `vigiles/codex`, so the tier IS reachable here — what the old
  // wording omitted was the argument that points it at THIS harness.
  assert.match(msg, /evalDriver/);
  cleanupTmpDir(dir);
});

test("skillTestNudge: silent when the surface is covered on both tiers", () => {
  const dir = makeTmpDir("nudge-covered");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.harness.mjs", "// vigiles:covers skills/foo\n");
  write(dir, "skills/foo/foo.eval.mjs", "// vigiles:covers skills/foo\n");
  assert.equal(skillTestNudge("skills/foo/SKILL.md", { basePath: dir }), null);
  cleanupTmpDir(dir);
});

test("skillTestNudge: silent for a file that is not a surface, and for another skill's edit", () => {
  const dir = makeTmpDir("nudge-other");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "README.md", "# not a surface\n");
  assert.equal(skillTestNudge("README.md", { basePath: dir }), null);
  // An absolute-ish path ending in the surface path still matches (the hook
  // passes a repo-relative path, but a caller may not).
  assert.ok(skillTestNudge("/abs/repo/skills/foo/SKILL.md", { basePath: dir }));
  cleanupTmpDir(dir);
});

test("skillTestNudge: a harness-covered AGENT is nudged about its CONTRACT, not about firing", () => {
  // 🔴 The reported defect. `skillTestNudge` disables only hooks, so an agent
  // reaches the never-evaluated branch exactly as a skill does — and it used to
  // be handed the SKILL's sentence: that its description must "FIRE", remedied
  // by `measureTriggerRate`. Both halves of that are wrong for an agent. It is
  // dispatched BY NAME through `Task`; firing is not its question. And the tool
  // named cannot address it at all — measured 2026-08-12, no model spent:
  //
  //   packageSkillsDir(<agents dir>)                  → THREW "No <name>/SKILL.md
  //                                                      skills found under …"
  //   measureTriggerRateWith({ pluginDir: <agents-    → rate = 0 | competitors = 0
  //     only plugin> }, fakeRunner)
  //
  // The plugin form does not fail: it reports a NUMBER for a surface it never
  // installed, which is the same "worse than an error" the sibling driver note
  // exists for.
  const dir = makeTmpDir("nudge-agent-uneval");
  write(dir, "agents/bar.md", skill("bar"));
  write(dir, "agents/bar.harness.mjs", "// deterministic only\n");
  const msg = skillTestNudge("agents/bar.md", { basePath: dir });
  assert.ok(msg, "covered-but-never-evaluated must still nudge an agent");
  // What it must NOT say — the skill's question, and the tool that cannot run.
  assert.doesNotMatch(msg, /actually FIRES/);
  assert.doesNotMatch(msg, /irrelevantPrompts/);
  assert.doesNotMatch(msg, /measureTriggerRate\(spec/);
  // …and what it must say instead: the real-model tier, with the assertions the
  // repo's own subagent guidance names (docs/rules/untested-subagent.md).
  assert.match(msg, /runEval/);
  assert.match(msg, /subagent\(name/);
  assert.match(msg, /notTool/);
  assert.match(msg, /assertAgentOk/);
  // ⚠️ It must not invent an argument the function does not take: `runEval` /
  // `measure` / `measureArms` hard-wire `spawnAgent`, and `runEvalWith` is not
  // exported from `vigiles/eval` — only `paid_measureTriggerRate` has that seam.
  // Suggesting `runEval(spec, { evalDriver })` would be this finding's own class
  // of defect (a remedy that does not apply), so the honest limit is stated.
  assert.doesNotMatch(msg, /runEval\(spec, \{ evalDriver/);
  assert.match(msg, /no public dispatch/);
  assert.match(msg, /not a block/);
  cleanupTmpDir(dir);
});

test("skillTestNudge: the SKILL sentence is untouched — the fix is a branch, not a rewrite", () => {
  // The quiet half of the branch. A skill in the same position keeps every word
  // the two sibling tests pin, so the per-kind split cannot be mistaken for a
  // regression of the skill remedy.
  const dir = makeTmpDir("nudge-skill-uneval-still");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  write(dir, "skills/foo/foo.harness.mjs", "// deterministic only\n");
  const msg = skillTestNudge("skills/foo/SKILL.md", { basePath: dir });
  assert.ok(msg);
  assert.match(msg, /actually FIRES/);
  assert.match(msg, /measureTriggerRate\(spec, \{ evalDriver \}\)/);
  // …and it does NOT acquire the agent's vocabulary.
  assert.doesNotMatch(msg, /assertAgentOk/);
  cleanupTmpDir(dir);
});

test("evalTierQuestion: total over SurfaceKind — a hook has no eval-tier question", () => {
  // The exhaustiveness guarantee, asserted at the only place it is observable.
  // `skillTestNudge` scans with `hooks: false`, so this arm is unreachable
  // through it; without a direct test a hook would inherit whatever the last
  // branch happened to return, which is how the agent got the skill's sentence.
  assert.equal(evalTierQuestion("hook"), null);
  // The two that DO have one are distinct texts, not the same string twice.
  const forSkill = evalTierQuestion("skill");
  const forAgent = evalTierQuestion("agent");
  assert.ok(forSkill && forAgent);
  assert.notEqual(forSkill, forAgent);
  assert.match(forSkill, /FIRES/);
  assert.match(forAgent, /tool contract/);
});

test("skillTestNudge: an agent surface is covered too, and a broken scan is silent", () => {
  const dir = makeTmpDir("nudge-agent");
  write(dir, "agents/bar.md", skill("bar"));
  const msg = skillTestNudge("agents/bar.md", { basePath: dir });
  assert.ok(msg);
  assert.match(msg, /bar\.harness\.mjs/); // agents suggest a harness, not an eval
  // A nonexistent base must not throw out of a PostToolUse hook.
  assert.equal(
    skillTestNudge("skills/foo/SKILL.md", { basePath: join(dir, "nope") }),
    null,
  );
  cleanupTmpDir(dir);
});

// ── colocation must be NAMED, not merely nearby (defect found by dogfooding) ──
// Placement says where a file sits; only the name says what it is about. The rule
// read "any file under the skill's directory", which is the substitution the
// removed `mention` tier made, reached by a different route. Observed live: a
// consumer repo's `paper-pipeline/` held SIX evals, exactly one about that skill,
// the rest sitting there for a historical reason — and the orchestrator scored as
// covered with no test of its own.

test("a test named after ANOTHER skill does not cover the one it sits with", () => {
  const dir = makeTmpDir("cov-foreign");
  write(dir, ".claude/skills/orchestrator/SKILL.md", skill("orchestrator"));
  write(dir, ".claude/skills/grader/SKILL.md", skill("grader"));
  // The historical accident: a test ABOUT `grader`, living in `orchestrator/`.
  write(
    dir,
    ".claude/skills/orchestrator/grader-ablation.eval.mjs",
    "// about grader\n",
  );
  const report = findUntestedSurfaces({ basePath: dir });
  const untested = report.untested.map((s) => s.name).sort();
  assert.deepEqual(untested, ["grader", "orchestrator"]);
  cleanupTmpDir(dir);
});

test("…and its own, correctly named test still covers it", () => {
  // The quiet half. Without it the assertion above passes on a detector that
  // credits nothing at all, which is the failure mode this suite exists to catch.
  const dir = makeTmpDir("cov-own-name");
  write(dir, ".claude/skills/orchestrator/SKILL.md", skill("orchestrator"));
  write(
    dir,
    ".claude/skills/orchestrator/orchestrator.eval.mjs",
    "// about orchestrator\n",
  );
  const report = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    report.untested.map((s) => s.name),
    [],
  );
  assert.equal(coverageEvidenceCounts(report).colocated, 1);
  cleanupTmpDir(dir);
});

test("a test in a SUBDIRECTORY is not colocated, however well named", () => {
  // Colocation is worth having for one property: `ls` answers "is this tested?".
  // Permit a subdirectory and it takes `find` instead — and two permitted shapes
  // is a choice at write time and a lookup at read time.
  //
  // Measured before removing the allowance: across two real repos exactly ONE
  // nested test exists, `verify-citations/scripts/verify-cites.test.mjs` — a unit
  // test for a script the skill BUNDLES, not a test of the skill. It credited
  // nothing anyone wanted.
  const dir = makeTmpDir("cov-nested");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(dir, ".claude/skills/foo/tests/foo.harness.mjs", "// about foo\n");
  const report = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    report.untested.map((s) => s.name),
    ["foo"],
  );
  cleanupTmpDir(dir);
});

test("…and a bundled script's own unit test does not credit the skill either", () => {
  // The real case above, reproduced: `scripts/<script>.test.mjs` pins a pure
  // reducer the skill ships. A good test of a script is not a test of a skill.
  const dir = makeTmpDir("cov-script-test");
  write(
    dir,
    ".claude/skills/verify-citations/SKILL.md",
    skill("verify-citations"),
  );
  write(
    dir,
    ".claude/skills/verify-citations/scripts/verify-cites.test.mjs",
    "// pure reducer\n",
  );
  const report = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    report.untested.map((s) => s.name),
    ["verify-citations"],
  );
  cleanupTmpDir(dir);
});

test("a single-skill target takes its identity from `name:`, not the checkout dir", () => {
  // The base of a single-skill target is wherever the thing happens to be checked
  // out — a temp dir, a CI workspace. Deriving the identity from the path would
  // ask the author to name their test after their checkout directory.
  const dir = makeTmpDir("cov-root-identity");
  write(dir, "SKILL.md", skill("solo"));
  write(dir, "solo.eval.mjs", "// about solo\n");
  const report = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    report.untested.map((s) => s.name),
    [],
  );
  cleanupTmpDir(dir);
});

// ── the retired `vigiles:covers` marker explains its own removal ──────────────
// Up to 15.0.2 the untested finding TOLD people to write this marker. Removing
// the tier without a word means anyone who complied loses coverage on upgrade
// with no error — the marker quietly becomes a comment. A migration nobody is
// told about is indistinguishable from a bug they caused.

test("a test still carrying `vigiles:covers` is named, with what changed", () => {
  const dir = makeTmpDir("cov-legacy-marker");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(
    dir,
    ".claude/skills/foo/foo.harness.mjs",
    "// vigiles:covers skills/foo\n",
  );
  const report = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(report.legacyCoversFiles, [
    ".claude/skills/foo/foo.harness.mjs",
  ]);
  const text = formatUntestedReport(report);
  assert.match(text, /retired/);
  // Printed even though this repo is at ZERO untested — a repo can lose the tier
  // and still be clean, and would then never hear about it.
  assert.equal(report.untested.length, 0);
  cleanupTmpDir(dir);
});

test("…and a repo that never used the marker hears nothing about it", () => {
  const dir = makeTmpDir("cov-no-legacy");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(dir, ".claude/skills/foo/foo.harness.mjs", "// an ordinary test\n");
  const report = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(report.legacyCoversFiles, []);
  assert.doesNotMatch(formatUntestedReport(report), /retired/);
  cleanupTmpDir(dir);
});

// ── the EXECUTION tier: `.vigiles/coverage.json` ─────────────────────────────
//
// The order of answers is execution → name → nothing, and the report must say
// which one it used. Each behaviour below has both halves: it fires with an
// artifact present, and the corpus is untouched when there is none — a fresh
// clone and somebody else's repo must not get one extra nudge from this tier.

/**
 * Write a run artifact naming `surfacePath` as exercised by `by` — AND put that
 * script on disk, because a run that produced the record necessarily executed a
 * file that was there. A record counts only while BOTH files it names are still
 * present, so a fixture that named a script it never created was describing a
 * checkout that cannot happen (and, before that rule, was the fixture shape in
 * which a deleted harness kept granting coverage forever).
 */
function artifact(
  dir: string,
  entries: readonly {
    path: string;
    name: string;
    sha: string;
    tier?: "harness" | "eval";
    by?: string;
    at?: string;
    kind?: "skill" | "agent" | "hook";
  }[],
): void {
  const runs = entries.map((e) => ({
    kind: e.kind ?? "skill",
    path: e.path,
    name: e.name,
    tier: e.tier ?? "harness",
    how: "fired",
    by: e.by ?? "runner.harness.mjs",
    at: e.at ?? "2026-08-11T10:00:00.000Z",
    sha: e.sha,
  }));
  for (const by of new Set(runs.map((r) => r.by))) {
    // `by` reaches the artifact exactly as it was typed, absolute spellings
    // included — so resolve it the way the detector does before creating it.
    const abs = isAbsolute(by) ? by : join(dir, by);
    if (!existsSync(abs)) {
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "// the script that ran\n");
    }
  }
  write(
    dir,
    ".vigiles/coverage.json",
    JSON.stringify({ v: 1, generated: "2026-08-11T10:00:00.000Z", runs }),
  );
}

test("a recorded run covers a surface that has NO file named after it", () => {
  // The whole point: `skills.harness.mjs` builds its paths at runtime and
  // contains no literal `skills/<name>`, so colocation credits it with nothing.
  // A run says otherwise, and the run is the thing that happened.
  const dir = makeTmpDir("cov-exec");
  const body = skill("alpha");
  write(dir, "skills/alpha/SKILL.md", body);
  write(dir, "test/pipeline.harness.mjs", "// builds paths at runtime\n");
  assert.equal(findUntestedSurfaces({ basePath: dir }).untested.length, 1);

  artifact(dir, [
    { path: "skills/alpha/SKILL.md", name: "alpha", sha: surfaceSha(body) },
  ]);
  const after = findUntestedSurfaces({ basePath: dir });
  assert.equal(after.untested.length, 0);
  assert.deepEqual(coverageEvidenceCounts(after), {
    executed: 1,
    colocated: 0,
    configured: 0,
  });
  cleanupTmpDir(dir);
});

test("execution OUTRANKS colocation, and the report words them differently", () => {
  const dir = makeTmpDir("cov-exec-rank");
  const alpha = skill("alpha");
  const beta = skill("beta");
  write(dir, "skills/alpha/SKILL.md", alpha);
  write(dir, "skills/alpha/alpha.harness.mjs", "assert.ok(true);\n");
  write(dir, "skills/beta/SKILL.md", beta);
  write(dir, "skills/beta/beta.harness.mjs", ""); // an EMPTY file still colocates
  artifact(dir, [
    { path: "skills/alpha/SKILL.md", name: "alpha", sha: surfaceSha(alpha) },
  ]);
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(coverageEvidenceCounts(r), {
    executed: 1,
    colocated: 1,
    configured: 0,
  });
  const text = formatUntestedReport(r);
  // "measured by a run" and "there is a file with a matching name" are two
  // different facts. A reader who cannot tell them apart has the old number.
  assert.match(text, /1 MEASURED BY A RUN/);
  assert.match(text, /1 colocated/);
  assert.match(text, /EXISTS, not that it ran/);
  cleanupTmpDir(dir);
});

test("a run against OLDER text grants nothing, and says so out loud", () => {
  const dir = makeTmpDir("cov-stale");
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  artifact(dir, [
    {
      path: "skills/alpha/SKILL.md",
      name: "alpha",
      sha: surfaceSha("the text it had LAST week"),
    },
  ]);
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 1, "a stale run is not coverage");
  assert.deepEqual(
    (r.staleRuns ?? []).map((s) => s.path),
    ["skills/alpha/SKILL.md"],
  );
  // Silently counting it is the PIPELINE-STATUS disease — a tick against a
  // document somebody rewrote afterwards.
  assert.match(formatUntestedReport(r), /BEFORE their current/);
  cleanupTmpDir(dir);
});

test("a record whose HARNESS was deleted grants nothing — and that is the permanent case", () => {
  // 🔴 The staleness contract pinned the SURFACE and not the thing that did the
  // executing. Delete the passing harness and the record stays fresh forever:
  // freshness is keyed to the surface's text, which removing the test does not
  // touch. And unlike an emptied harness — which the next `vigiles test` retracts
  // because a `vacuous` run is in the retraction set — a DELETED file can never
  // appear in `discoverScripts` output again, so no future run can withdraw it.
  // Permanent, unfalsifiable execution coverage.
  const dir = makeTmpDir("cov-deleted-harness");
  const body = skill("alpha");
  write(dir, "skills/alpha/SKILL.md", body);
  artifact(dir, [
    {
      path: "skills/alpha/SKILL.md",
      name: "alpha",
      sha: surfaceSha(body),
      by: "test/pipeline.harness.mjs",
    },
  ]);
  // The precondition, so the assertion below cannot pass by measuring nothing.
  const before = findUntestedSurfaces({ basePath: dir });
  assert.equal(before.untested.length, 0);
  assert.deepEqual(coverageEvidenceCounts(before), {
    executed: 1,
    colocated: 0,
    configured: 0,
  });

  // FIRES: exactly one change — the harness is gone.
  rmSync(join(dir, "test/pipeline.harness.mjs"));
  const after = findUntestedSurfaces({ basePath: dir });
  assert.equal(after.untested.length, 1, "nothing left in this tree ran it");
  assert.deepEqual(coverageEvidenceCounts(after), {
    executed: 0,
    colocated: 0,
    configured: 0,
  });
  // Not "measured, but not this version" either: the surface was never edited,
  // so calling it stale would name the wrong file.
  assert.deepEqual(after.staleRuns ?? [], []);
  assert.doesNotMatch(formatUntestedReport(after), /MEASURED BY A RUN/);
  cleanupTmpDir(dir);
});

test("…and a RENAMED harness is the same case, because the old name never returns", () => {
  // The rename is why presence is checked at read time rather than left to
  // retraction: the new name writes a new record, and the OLD record — which the
  // retraction set can never name again — would otherwise sit there green.
  const dir = makeTmpDir("cov-renamed-harness");
  const body = skill("alpha");
  write(dir, "skills/alpha/SKILL.md", body);
  artifact(dir, [
    {
      path: "skills/alpha/SKILL.md",
      name: "alpha",
      sha: surfaceSha(body),
      by: "test/old-name.harness.mjs",
    },
  ]);
  rmSync(join(dir, "test/old-name.harness.mjs"));
  write(dir, "test/new-name.harness.mjs", "// same file, new name\n");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(coverageEvidenceCounts(r), {
    executed: 0,
    colocated: 0,
    configured: 0,
  });
  cleanupTmpDir(dir);
});

test("…but a spelling of the SAME file still counts — presence, not string equality", () => {
  // The QUIET half, and the one a naive `existsSync(by)` gets wrong.
  // `discoverScripts` passes an argument naming an existing file through
  // VERBATIM, so `by` can be `./t.harness.mjs` or an absolute path, and reading
  // either as "not on disk" would delete real coverage on every scan.
  const dir = makeTmpDir("cov-by-spellings");
  const body = skill("alpha");
  write(dir, "skills/alpha/SKILL.md", body);
  write(dir, "test/t.harness.mjs", "// the script that ran\n");
  for (const by of [
    "test/t.harness.mjs",
    "./test/t.harness.mjs",
    "test/fixtures/../t.harness.mjs",
    join(dir, "test/t.harness.mjs"),
  ]) {
    artifact(dir, [
      {
        path: "skills/alpha/SKILL.md",
        name: "alpha",
        sha: surfaceSha(body),
        by,
      },
    ]);
    assert.deepEqual(
      coverageEvidenceCounts(findUntestedSurfaces({ basePath: dir })),
      { executed: 1, colocated: 0, configured: 0 },
      by,
    );
  }
  cleanupTmpDir(dir);
});

test("a stale run is reported even when the repo is at ZERO untested", () => {
  // Same reason `legacyCoversNote` prints in both branches: a repo can be clean
  // and still be resting on a measurement of text that no longer exists.
  const dir = makeTmpDir("cov-stale-clean");
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  write(dir, "skills/alpha/alpha.harness.mjs", "assert.ok(true);\n");
  artifact(dir, [
    { path: "skills/alpha/SKILL.md", name: "alpha", sha: surfaceSha("older") },
  ]);
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 0);
  assert.match(formatUntestedReport(r), /BEFORE their current/);
  cleanupTmpDir(dir);
});

test("a re-run refreshes the surface and the stale notice goes away", () => {
  const dir = makeTmpDir("cov-stale-refresh");
  const body = skill("alpha");
  write(dir, "skills/alpha/SKILL.md", body);
  // The artifact keeps the old record AND a fresh one, as merging leaves it.
  artifact(dir, [
    {
      path: "skills/alpha/SKILL.md",
      name: "alpha",
      sha: surfaceSha("older"),
      by: "old.harness.mjs",
      at: "2026-08-01T00:00:00.000Z",
    },
    {
      path: "skills/alpha/SKILL.md",
      name: "alpha",
      sha: surfaceSha(body),
      by: "new.harness.mjs",
    },
  ]);
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 0);
  assert.deepEqual(r.staleRuns, [], "a permanent notice is an ignored notice");
  assert.deepEqual(coverageEvidenceCounts(r), {
    executed: 1,
    colocated: 0,
    configured: 0,
  });
  cleanupTmpDir(dir);
});

test("an executed HARNESS does not silence `firing was never measured`", () => {
  // The tiers cost three orders of magnitude apart. A free deterministic run
  // must not answer the question only a real model can.
  const dir = makeTmpDir("cov-exec-tier");
  const body = skill("alpha");
  write(dir, "skills/alpha/SKILL.md", body);
  artifact(dir, [
    {
      path: "skills/alpha/SKILL.md",
      name: "alpha",
      sha: surfaceSha(body),
      tier: "harness",
    },
  ]);
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.harness.untested.length, 0);
  assert.equal(r.evals.untested.length, 1);
  assert.match(formatUntestedReport(r), /no `\*\.eval\.mjs`|never measured/);
  cleanupTmpDir(dir);
});

test("NO artifact ⇒ byte-for-byte the old behaviour, including the report text", () => {
  // The conservative direction, pinned. A fresh clone and anyone else's repo
  // must not get one extra nudge, or one fewer, from this tier existing.
  const dir = makeTmpDir("cov-no-artifact");
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  write(dir, "skills/beta/SKILL.md", skill("beta"));
  write(dir, "skills/beta/beta.harness.mjs", "assert.ok(true);\n");
  const r = findUntestedSurfaces({ basePath: dir });
  assert.deepEqual(
    r.untested.map((s) => s.name),
    ["alpha"],
  );
  assert.deepEqual(coverageEvidenceCounts(r), {
    executed: 0,
    colocated: 1,
    configured: 0,
  });
  const text = formatUntestedReport(r);
  assert.doesNotMatch(text, /MEASURED BY A RUN/);
  assert.doesNotMatch(text, /BEFORE their current/);
  cleanupTmpDir(dir);
});

test("a run record for a surface nobody discovers changes nothing", () => {
  const dir = makeTmpDir("cov-ghost");
  write(dir, "skills/alpha/SKILL.md", skill("alpha"));
  artifact(dir, [
    { path: "skills/deleted/SKILL.md", name: "deleted", sha: "whatever" },
  ]);
  const r = findUntestedSurfaces({ basePath: dir });
  assert.equal(r.untested.length, 1);
  assert.deepEqual(r.staleRuns, []);
  cleanupTmpDir(dir);
});

// ─── the SUGGESTED path must be one `vigiles test` will actually run ────────────
//
// 🔴 Measured defect, not a hypothetical: on Node 20 — which this repo's own CI
// runs — a project holding a `tsconfig.json` but no local `tsx` was told to add
// `foo.harness.ts`, and `interpreterArgs` then threw `Cannot run TypeScript test
// script`. The author does the work and the tool says no.

test("fires: no tsx and no native type stripping ⇒ suggest `.mjs`, and the runner accepts it", () => {
  const dir = makeTmpDir("tc-ts-caps");
  write(dir, "tsconfig.json", "{}");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  // The capability the runner branches on, forced to the Node-20-no-tsx state.
  const caps = { tsx: false, stripTypes: false };
  assert.equal(canRunTypeScript(caps), false);
  assert.equal(
    testFileExt({ hasTsconfig: true, canRunTypeScript: false }),
    "mjs",
  );
  // The property that matters end to end: the runner does not refuse the file the
  // finding just asked for.
  assert.doesNotThrow(() =>
    interpreterArgs(
      suggestedTestPath(
        {
          kind: "skill",
          name: "foo",
          path: "skills/foo/SKILL.md",
          tokens: [],
          ignored: false,
        },
        testFileExt({ hasTsconfig: true, canRunTypeScript: false }),
      ),
      caps,
    ),
  );
  // …and the SAME repo with tsx present keeps its `.ts` suggestion — the fix is a
  // capability check, not a blanket downgrade of TypeScript projects.
  assert.equal(
    testFileExt({ hasTsconfig: true, canRunTypeScript: true }),
    "ts",
  );
  cleanupTmpDir(dir);
});

/**
 * Run `fn` with the Node-20 capability profile: no `--experimental-strip-types`.
 * `process.allowedNodeEnvironmentFlags` is a configurable accessor, so this is the
 * one way to exercise `findUntestedSurfaces`'s REAL wiring on any Node — otherwise
 * the whole gate is untestable on a dev box (Node 22 strips types natively, so the
 * answer is `.ts` with or without the fix, and dropping the wiring breaks nothing
 * until CI's Node 20 sees it).
 */
/**
 * The MIRROR of {@link asNode20} — pretend the host CAN strip types.
 *
 * 🔴 WITHOUT THIS, THE "CAPABILITY RESTORED" HALF IS HOST-DEPENDENT, and that is
 * exactly how this suite went red: it asserted `.ts` on whatever node happened to
 * run it, passed on a Node 22 dev box, and failed on CI's Node 20 — where the
 * capability is genuinely absent and `.mjs` is the CORRECT answer. The assertion
 * was testing the runner, not the code.
 *
 * Simulating BOTH directions makes each half deterministic everywhere, which is
 * the same lesson the `--experimental-test-isolation=none` probe taught two hours
 * earlier in `eval-node-test-guard.test.ts`: never assert a behaviour that depends
 * on which node picked up the job.
 */
function asNodeWithStripTypes(fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(
    process,
    "allowedNodeEnvironmentFlags",
  );
  assert.ok(original?.configurable, "cannot simulate strip-types support");
  Object.defineProperty(process, "allowedNodeEnvironmentFlags", {
    value: new Set<string>(["--experimental-strip-types"]),
    configurable: true,
  });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "allowedNodeEnvironmentFlags", original);
  }
}

function asNode20(fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(
    process,
    "allowedNodeEnvironmentFlags",
  );
  assert.ok(original?.configurable, "cannot simulate Node 20");
  Object.defineProperty(process, "allowedNodeEnvironmentFlags", {
    value: new Set<string>(),
    configurable: true,
  });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "allowedNodeEnvironmentFlags", original);
  }
}

test("fires end-to-end: on Node 20 with no tsx, the REPORT itself suggests `.mjs`", () => {
  // Pins the WIRING, not just the pure decision — without the `canRunTypeScript`
  // argument in `findUntestedSurfaces`, this repo's own CI (Node 20.20.2) hands
  // out a path `vigiles test` refuses to run.
  const dir = makeTmpDir("tc-ts-caps-wired");
  write(dir, "tsconfig.json", "{}");
  write(dir, "skills/foo/SKILL.md", skill("foo"));
  asNode20(() => {
    assert.equal(canRunTypeScript(detectNodeCaps(dir)), false);
    const report = findUntestedSurfaces({ basePath: dir });
    assert.equal(report.testExt, "mjs");
    const [surface] = report.untested;
    assert.ok(surface, "the skill must be reported untested");
    assert.doesNotThrow(() =>
      interpreterArgs(
        suggestedTestPath(surface, report.testExt),
        detectNodeCaps(dir),
      ),
    );
  });
  // Same fixture, capability SIMULATED back on → the TypeScript suggestion returns.
  // Simulated, not ambient: on CI's Node 20 the real capability is absent and
  // `.mjs` is correct there, so asserting `.ts` against the host tested the
  // runner rather than the gate.
  asNodeWithStripTypes(() => {
    assert.equal(findUntestedSurfaces({ basePath: dir }).testExt, "ts");
  });
  cleanupTmpDir(dir);
});

test("silent: THIS repo — a real TypeScript project that CAN run TS — still gets `.ts`", () => {
  // Real input, not a fixture: the vigiles checkout has a `tsconfig.json` AND a
  // local `tsx`, so the capability gate must be invisible here. If this ever flips
  // to `.mjs`, the gate has started punishing TypeScript repos instead of
  // protecting the ones with no runner.
  const repoRoot = join(__dirname, "..");
  assert.equal(canRunTypeScript(detectNodeCaps(repoRoot)), true);
  assert.equal(findUntestedSurfaces({ basePath: repoRoot }).testExt, "ts");
});

test("an EXPLICIT `testExtension: ts` survives with no runner — the field exists to disagree", () => {
  // Withdrawing a configured value would be the tool overruling a decision the
  // author typed on purpose (they may be adding tsx in the same commit).
  assert.equal(
    testFileExt({
      hasTsconfig: false,
      configured: "ts",
      canRunTypeScript: false,
    }),
    "ts",
  );
});

// ── one list of caveats, so a renderer cannot carry half of them ─────────────
// `audit` builds its own fact block from this report and used to print neither
// qualifier, so the note explaining a silent migration was itself silent for
// anyone who runs `audit` rather than `lint`. Both renderers now read this one
// list; a third caveat added here reaches both or neither.

test("coverageCaveats collects the qualifiers, and is empty when there are none", () => {
  const dirty = makeTmpDir("cov-caveats-dirty");
  write(dirty, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(
    dirty,
    ".claude/skills/foo/foo.harness.mjs",
    "// vigiles:covers skills/foo\n",
  );
  const withMarker = coverageCaveats(findUntestedSurfaces({ basePath: dirty }));
  assert.equal(withMarker.length, 1);
  assert.match(withMarker[0] ?? "", /retired `vigiles:covers` marker/);
  // Everything the lint renderer shows about caveats comes from here.
  for (const line of withMarker)
    assert.ok(
      formatUntestedReport(findUntestedSurfaces({ basePath: dirty })).includes(
        line,
      ),
    );
  cleanupTmpDir(dirty);

  const clean = makeTmpDir("cov-caveats-clean");
  write(clean, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(clean, ".claude/skills/foo/foo.harness.mjs", "// an ordinary test\n");
  assert.deepEqual(
    coverageCaveats(findUntestedSurfaces({ basePath: clean })),
    [],
  );
  cleanupTmpDir(clean);
});

// ── the other half of the 15.x migration: the suffix that stopped counting ────
// `*.test.*` left DEFAULT_TEST_GLOBS because a default vitest/jest run collects
// it and a skill test spends money. The rename was announced to nobody: the
// finding prints the SURFACE path and suggests adding a file, so an author with
// `foo.test.mjs` already on disk is told to write the test they wrote.

test("a `<surface>.test.*` beside an UNTESTED surface is named, with the reason", () => {
  const dir = makeTmpDir("cov-retired-suffix");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(dir, ".claude/skills/foo/foo.test.mjs", "// a skill test, misnamed\n");
  const report = findUntestedSurfaces({ basePath: dir });
  // Unchanged: the name grants no coverage. This is about SAYING so.
  assert.equal(report.untested.length, 1);
  assert.deepEqual(report.retiredTestNames, [
    {
      path: ".claude/skills/foo/foo.test.mjs",
      surface: ".claude/skills/foo/SKILL.md",
    },
  ]);
  const text = formatUntestedReport(report);
  assert.match(text, /foo\.test\.mjs/);
  assert.match(text, /vitest\/jest/);
  cleanupTmpDir(dir);
});

test("…and says nothing when the surface IS covered — a stray unit test is not our business", () => {
  const dir = makeTmpDir("cov-retired-suffix-covered");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  write(dir, ".claude/skills/foo/foo.harness.mjs", "// the real one\n");
  write(dir, ".claude/skills/foo/foo.test.mjs", "// somebody's unit test\n");
  const report = findUntestedSurfaces({ basePath: dir });
  assert.equal(report.untested.length, 0);
  assert.deepEqual(report.retiredTestNames, []);
  assert.deepEqual(coverageCaveats(report), []);
  cleanupTmpDir(dir);
});

test("…and nothing at all in a repo with no such file", () => {
  const dir = makeTmpDir("cov-retired-suffix-none");
  write(dir, ".claude/skills/foo/SKILL.md", skill("foo"));
  // Named after the surface, sitting beside it, and NOT a runnable test name —
  // the suffix is the whole reason this finding exists, so it has to be load-bearing.
  write(dir, ".claude/skills/foo/foo.notes.md", "not a test\n");
  write(dir, ".claude/skills/foo/foo.test.fixture.json", "{}\n");
  const report = findUntestedSurfaces({ basePath: dir });
  assert.equal(report.untested.length, 1);
  assert.deepEqual(report.retiredTestNames, []);
  assert.doesNotMatch(formatUntestedReport(report), /vitest\/jest/);
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// `{surface}` in include — a centralized layout, without weakening what
// coverage MEANS (#175.2)
// ---------------------------------------------------------------------------

test("a {surface} testGlob credits a centralized test", () => {
  // The reported layout: suites live in tests/<skill>/evals/, not beside the
  // skill. `include` alone did not move the number (35 before, 35 after),
  // because it widens what counts as a TEST FILE and says nothing about which
  // SURFACE the file is for.
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, "skills", "mysql-designer"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "mysql-designer", "SKILL.md"),
      "---\nname: mysql-designer\ndescription: Designs schemas.\n---\n\nBody.\n",
    );
    mkdirSync(join(dir, "tests", "mysql-designer", "evals"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "tests", "mysql-designer", "evals", "promptfooconfig.yaml"),
      "prompts: []\n",
    );

    const before = findUntestedSurfaces({ basePath: dir });
    assert.equal(before.untested.length, 1, "uncovered without the glob");

    const after = findUntestedSurfaces({
      basePath: dir,
      include: ["tests/{surface}/evals/promptfooconfig*.yaml"],
    });
    assert.equal(after.untested.length, 0);
    assert.equal(after.decisions[0]?.evidence, "configured");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a {surface} glob credits ONLY the surface it names", () => {
  // The load-bearing half. The retired `name-mentioned` tier died because a
  // substring credited surfaces nothing had touched; the placeholder must not
  // reintroduce that. One skill has a suite, its neighbour does not.
  const dir = makeTmpDir();
  try {
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(dir, "skills", name), { recursive: true });
      writeFileSync(
        join(dir, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Does ${name}.\n---\n\nBody.\n`,
      );
    }
    mkdirSync(join(dir, "tests", "alpha", "evals"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "alpha", "evals", "promptfooconfig.yaml"),
      "prompts: []\n",
    );

    const r = findUntestedSurfaces({
      basePath: dir,
      include: ["tests/{surface}/evals/promptfooconfig*.yaml"],
    });
    assert.deepEqual(
      r.untested.map((s) => s.name),
      ["beta"],
      "alpha's suite must not cover beta",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a plain custom glob still credits NOTHING by itself", () => {
  // Unchanged behaviour, pinned: without the placeholder there is no name
  // binding, and inferring one from a substring is the tier that was retired.
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, "skills", "gamma"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "gamma", "SKILL.md"),
      "---\nname: gamma\ndescription: Does gamma.\n---\n\nBody.\n",
    );
    mkdirSync(join(dir, "tests", "gamma", "evals"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "gamma", "evals", "promptfooconfig.yaml"),
      "prompts: []\n",
    );

    const r = findUntestedSurfaces({
      basePath: dir,
      include: ["tests/*/evals/promptfooconfig*.yaml"],
    });
    assert.equal(r.untested.length, 1, "no placeholder ⇒ no surface binding");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("colocation still wins, and is reported as colocation", () => {
  // Precedence: a repo doing both must not be relabelled by the new tier.
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, "skills", "delta"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "delta", "SKILL.md"),
      "---\nname: delta\ndescription: Does delta.\n---\n\nBody.\n",
    );
    writeFileSync(
      join(dir, "skills", "delta", "delta.harness.mjs"),
      "// a colocated harness\n",
    );
    mkdirSync(join(dir, "tests", "delta", "evals"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "delta", "evals", "promptfooconfig.yaml"),
      "prompts: []\n",
    );

    // BOTH glob orders, because the point is that the answer does NOT depend on
    // the order. A first-found implementation passes one of these and fails the
    // other — which is exactly how the stale "strongest, not first-found" doc
    // comment was caught: it described a ranking the code did not do.
    for (const include of [
      ["**/*.harness.mjs", "tests/{surface}/evals/promptfooconfig*.yaml"],
      ["tests/{surface}/evals/promptfooconfig*.yaml", "**/*.harness.mjs"],
    ]) {
      const r = findUntestedSurfaces({ basePath: dir, include });
      assert.equal(r.untested.length, 0);
      assert.equal(
        r.decisions[0]?.evidence,
        "colocated",
        `colocation must win with globs ordered ${JSON.stringify(include)}`,
      );
    }
  } finally {
    cleanupTmpDir(dir);
  }
});
