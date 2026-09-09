/**
 * `vigiles audit` test suite. Builds a tiny fake plugin in a tmp dir and asserts
 * the deterministic report: skill description/user-invoked flags, agent tool
 * contracts (incl. the inherits-all footgun), hook script resolution across the
 * braced/unbraced `$CLAUDE_PLUGIN_ROOT` forms (ok / missing / unresolved),
 * command + MCP detection, and the formatted output. No model, no network.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  scanPlugin,
  formatScanReport,
  expandMarketplace,
  inspectMarketplace,
  verifyLiveMcpTools,
  formatMcpContractReport,
  isManagedHookCommand,
  preferCompiledHooksMessage,
} from "./scan.js";
import { loadPlugin } from "./adapters/claude-code/plugin-loader.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { claudeCodeDialect } from "./adapters/claude-code/dialect.js";
import { codexLayout } from "./adapters/codex/layout.js";
import { codexDialect } from "./adapters/codex/dialect.js";
import { auditScore } from "./audit-score.js";

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function fixture(): string {
  const dir = makeTmpDir("scan");
  write(
    dir,
    "skills/good/SKILL.md",
    "---\nname: good\ndescription: A skill that does good things across many cases\n---\n# good\n",
  );
  write(dir, "skills/nodesc/SKILL.md", "---\nname: nodesc\n---\n# nodesc\n");
  write(
    dir,
    "skills/cmd/SKILL.md",
    "---\nname: cmd\ndescription: A user-invoked command skill for tests here\ndisable-model-invocation: true\n---\n# cmd\n",
  );
  write(
    dir,
    "agents/withtools.md",
    "---\nname: withtools\ntools: Read, Grep\n---\nbody\n",
  );
  write(dir, "agents/notools.md", "---\nname: notools\n---\nbody\n");
  write(dir, "commands/doit.md", "# doit command\n");
  write(dir, "hooks/present.sh", "#!/usr/bin/env bash\n");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "fix",
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/present.sh",
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
                command: "bash $CLAUDE_PLUGIN_ROOT/hooks/absent.sh",
              },
            ],
          },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: 'bash "$HOME"/weird.sh' }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "npm test" }] }],
      },
    }),
  );
  write(
    dir,
    ".mcp.json",
    JSON.stringify({
      mcpServers: { demo: { command: "node", args: ["s.js"] } },
    }),
  );
  return dir;
}

test("scanPlugin discovers skills in an end-user .claude/skills repo (not a plugin)", () => {
  // The majority shape: a plain CC user, skills under `.claude/skills/`, no
  // plugin.json. Before this the report was empty (F/0 "no loadable surface").
  const dir = makeTmpDir("scan-userrepo");
  try {
    write(dir, "CLAUDE.md", "# proj\n");
    write(
      dir,
      ".claude/skills/rca/SKILL.md",
      "---\nname: rca\ndescription: Investigate an incident with two signals\n---\n# rca\n",
    );
    write(
      dir,
      ".claude/agents/reviewer.md",
      "---\nname: reviewer\ntools: Read\n---\nbody\n",
    );
    const r = scanPlugin(dir);
    assert.equal(r.skills.length, 1, "the .claude/skills skill is discovered");
    assert.equal(r.skills[0].name, "rca");
    assert.ok(r.skills[0].hasDescription);
    assert.equal(
      r.agents.length,
      1,
      "the .claude/agents subagent is discovered",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("scanPlugin resolves a .claude/skills skill's bundled resource on real disk", () => {
  // A `.claude/skills` skill materializes under the same canonical key as a
  // repo-root one; its bundled resource must resolve against its REAL dir
  // (`.claude/skills/rca/`), not a reverse-guessed `skills/rca/`.
  const dir = makeTmpDir("scan-userres");
  try {
    write(dir, "CLAUDE.md", "# proj\n");
    write(
      dir,
      ".claude/skills/rca/SKILL.md",
      "---\nname: rca\ndescription: RCA with a helper script bundled beside it\n---\nRun `scripts/run.sh` first.\n",
    );
    write(dir, ".claude/skills/rca/scripts/run.sh", "#!/usr/bin/env bash\n");
    const r = scanPlugin(dir);
    assert.equal(
      r.skills[0].resourceIssues.length,
      0,
      "the bundled scripts/run.sh resolves against the real .claude dir",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("scanPlugin loads a single skill directory passed directly", () => {
  const dir = makeTmpDir("scan-oneskill");
  try {
    write(
      dir,
      "SKILL.md",
      "---\nname: solo\ndescription: A single skill pointed at directly here\n---\n# solo\n",
    );
    const r = scanPlugin(dir);
    assert.equal(r.skills.length, 1, "the sole SKILL.md is scanned as a skill");
    assert.equal(r.skills[0].name, "solo");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("sharedDirs resolve against sharedDirsRoot, not a scoped subdir (P1-4 + P0-2)", () => {
  // The skill lives in a subdir; the shared `scripts/` tree is at the REPO root.
  // A scoped scan (scanRoot = the subdir) must still resolve the shared ref
  // against the repo root, not the subdir — else the two features conflict.
  const repo = makeTmpDir("scan-shared-scoped");
  try {
    write(
      repo,
      "packages/foo/skills/rca/SKILL.md",
      "---\nname: rca\ndescription: uses a shared script tree\n---\nRun `scripts/leak.py`.\n",
    );
    write(repo, "scripts/leak.py", "# shared tree at the repo root\n");
    const sub = join(repo, "packages", "foo");
    // With sharedDirsRoot = repo root → the shared ref resolves, no false flag.
    const ok = scanPlugin(sub, undefined, undefined, {
      sharedDirs: ["scripts"],
      sharedDirsRoot: repo,
    });
    assert.equal(
      ok.skills[0].resourceIssues.length,
      0,
      "scripts/leak.py resolves against the repo root, not the scoped subdir",
    );
    // Without sharedDirsRoot the subdir scan can't see the top-level tree → flags.
    const bad = scanPlugin(sub, undefined, undefined, {
      sharedDirs: ["scripts"],
    });
    assert.equal(bad.skills[0].resourceIssues.length, 1);
  } finally {
    cleanupTmpDir(repo);
  }
});

test("subagent classification is layout-driven (ready for new harnesses)", () => {
  // A harness whose subagents live somewhere other than `agents/` — e.g.
  // OpenCode's `.opencode/agent`. Here: a flat `subagents/` dir, declared via
  // the layout. The classifier must find it there AND a default Claude Code scan
  // (agentDir "agents") must NOT — proving the dir is read from the layout, not
  // hard-coded.
  const dir = makeTmpDir("scan-layout-agentdir");
  write(
    dir,
    "subagents/reviewer.md",
    "---\nname: reviewer\ndescription: Reviews code for issues carefully\ntools: Reat\n---\nReview.\n",
  );

  const customLayout = {
    ...claudeCodeLayout,
    agentDir: "subagents",
    surfaceDirs: ["subagents"],
    materializeRoot: "",
  };
  const r = scanPlugin(dir, customLayout, claudeCodeDialect);
  const reviewer = r.agents.find((a) => a.name === "reviewer");
  assert.ok(reviewer, "subagent under the layout's agentDir is classified");
  assert.ok(
    reviewer.toolIssues.length > 0,
    "the typo'd tool (Reat→Read) is flagged via the same detector",
  );

  // Default Claude Code layout (agentDir "agents") must not classify it.
  assert.equal(scanPlugin(dir).agents.length, 0);
  cleanupTmpDir(dir);
});

test("scanPlugin reports skills with description + user-invoked flags", () => {
  const dir = fixture();
  const r = scanPlugin(dir);
  const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]));
  assert.equal(r.skills.length, 3);
  assert.equal(byName.good.hasDescription, true);
  assert.equal(byName.good.userInvoked, false);
  assert.equal(byName.nodesc.hasDescription, false);
  assert.equal(byName.cmd.userInvoked, true);
  cleanupTmpDir(dir);
});

test("scanPlugin reports the REAL on-disk surface path, not the phantom .claude/ key (dogfood E1)", () => {
  // A root-kind plugin materializes `agents/*.md` + `skills/*/SKILL.md` under a
  // synthetic `.claude/…` key (the layout's materializeRoot) that does NOT exist
  // on disk. The reported `.path` must be the real repo-relative path so a
  // diagnostic / GitHub annotation points at a file that actually exists.
  const dir = fixture();
  try {
    const r = scanPlugin(dir);
    for (const a of r.agents) {
      assert.ok(
        a.path.startsWith("agents/") && !a.path.startsWith(".claude/"),
        `agent path should be the real agents/… path, got "${a.path}"`,
      );
    }
    for (const s of r.skills) {
      assert.ok(
        s.path.startsWith("skills/") && !s.path.startsWith(".claude/"),
        `skill path should be the real skills/… path, got "${s.path}"`,
      );
    }
    // The frontmatter-family findings must ALSO carry the real path, in both the
    // path field and the embedded message (nodesc has no description → skillMeta).
    const allFindingPaths = [
      ...r.frontmatterIssues,
      ...r.frontmatterValueIssues,
      ...r.skillMetaIssues,
      ...r.malformedFrontmatter,
    ];
    assert.ok(allFindingPaths.length > 0, "the fixture produces such findings");
    for (const f of allFindingPaths) {
      assert.ok(
        !f.path.startsWith(".claude/"),
        `finding path should not be the phantom .claude/ key, got "${f.path}"`,
      );
      assert.ok(
        !("message" in f && f.message?.includes(".claude/")),
        `finding message should not embed the phantom .claude/ path: "${String((f as { message?: string }).message)}"`,
      );
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

test("scanPlugin reads a YAML block-scalar description (not just `>`)", () => {
  // Regression: wshobson/agents skills commonly write `description: >` / `>-`
  // folded blocks. The naive regex captured only the indicator, mislabeling a
  // richly-described skill as "no usable description".
  const dir = makeTmpDir("scan-blockscalar");
  write(
    dir,
    "skills/folded/SKILL.md",
    "---\nname: folded\ndescription: >\n  A folded multi-line description that is plenty long enough\n  to be a usable trigger surface for the model.\n---\n# folded\n",
  );
  write(
    dir,
    "skills/chomped/SKILL.md",
    "---\nname: chomped\ndescription: >-\n  Another folded description, chomped variant, also well over\n  the twenty character minimum.\n---\n# chomped\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.skills.length, 2);
  assert.ok(r.skills.every((s) => s.hasDescription));
  cleanupTmpDir(dir);
});

test("scanPlugin reads a multi-line QUOTED description (value on the next line)", () => {
  // trailofbits/react-pdf shape: `description:` then an indented quoted scalar.
  // Was mislabeled "no description" (can't trigger) — a false positive.
  const dir = makeTmpDir("scan-quoted-desc");
  write(
    dir,
    "skills/q/SKILL.md",
    '---\nname: q\ndescription:\n  "Generates PDF documents using React-PDF with TypeScript.\n  Use when creating reports, invoices, or resumes."\nallowed-tools: Read\n---\n# q\n',
  );
  const q = scanPlugin(dir).skills.find((s) => s.name === "q");
  assert.equal(q?.hasDescription, true);
  cleanupTmpDir(dir);
});

test("scanPlugin resolves a relative hook path against the plugin root, not cwd", () => {
  // ananddtyagi/cc-marketplace shape: `./hooks/x.sh` (the file IS present).
  // existsSync was cwd-relative → reported MISSING (false positive).
  const dir = makeTmpDir("scan-relhook");
  write(dir, "hooks/present.sh", "#!/usr/bin/env bash\n");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "x",
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "bash ./hooks/present.sh" }],
          },
        ],
      },
    }),
  );
  const h = scanPlugin(dir).hooks.find((x) => x.script.includes("present.sh"));
  assert.equal(h?.status, "ok");
  cleanupTmpDir(dir);
});

test("scanPlugin treats an existence-guarded hook command as optional, not missing", () => {
  // gmickel/flow-next shape: `[ ! -f x ] || x` — runs x only if present.
  const dir = makeTmpDir("scan-guardhook");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "x",
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "[ ! -f scripts/gen.py ] || scripts/gen.py",
              },
            ],
          },
        ],
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.ok(
    !r.hooks.some((h) => h.status === "missing"),
    "a guarded optional hook must not be flagged missing",
  );
  assert.equal(r.inlineHooks, 1, "counted as a conditional one-liner");
  cleanupTmpDir(dir);
});

test("scanPlugin does not flag a glob pattern in a hook command as a missing script (dogfood D1)", () => {
  // A hook command that MENTIONS a glob — `find . -name "*.js"` — must not have
  // `"*.js"` grabbed as a script path and reported missing. The real script
  // (present.sh) still resolves ok.
  const dir = makeTmpDir("scan-globhook");
  try {
    write(dir, "hooks/present.sh", "#!/usr/bin/env bash\n");
    write(
      dir,
      ".claude-plugin/plugin.json",
      JSON.stringify({
        name: "x",
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit",
              hooks: [
                {
                  type: "command",
                  command:
                    'bash ${CLAUDE_PLUGIN_ROOT}/hooks/present.sh && find . -name "*.js" -newer /tmp/x',
                },
              ],
            },
          ],
        },
      }),
    );
    const r = scanPlugin(dir);
    assert.ok(
      !r.hooks.some((h) => h.status === "missing"),
      "a glob pattern in the command must not be read as a missing script",
    );
    assert.ok(
      r.hooks.some((h) => h.script.includes("present.sh") && h.status === "ok"),
      "the real hook script still resolves ok",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("isManagedHookCommand: only a hook-runtime invocation is vigiles-managed", () => {
  assert.equal(
    isManagedHookCommand(
      "node dist/cli.js hook-runtime run-program .vigiles/hooks/guard.mjs",
    ),
    true,
  );
  assert.equal(isManagedHookCommand("npx vigiles hook-runtime refs"), true);
  assert.equal(isManagedHookCommand("bash ./hooks/guard.sh"), false);
  assert.equal(isManagedHookCommand("git status"), false);
});

test("scanPlugin counts hand-written hooks for prefer-compiled-hooks (managed ones excluded)", () => {
  const dir = makeTmpDir("scan-prefer-compiled");
  write(dir, "hooks/guard.sh", "#!/usr/bin/env bash\n");
  write(
    dir,
    ".claude/settings.json",
    JSON.stringify({
      hooks: {
        // two hand-written (a script + an inline one-liner)…
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh",
              },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "npm test" }] }],
        // …and one compiled, vigiles-managed hook (must NOT count)
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "node dist/cli.js hook-runtime run-program .vigiles/hooks/x.mjs",
              },
            ],
          },
        ],
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.equal(
    r.manualHookCount,
    2,
    "two hand-written, the compiled one excluded",
  );
  // The single nudge surfaces in the report, linking the guide.
  const out = formatScanReport(r);
  assert.match(out, /hand-written hook/);
  assert.match(out, /docs\/compiled-hooks\.md/);
  assert.match(preferCompiledHooksMessage(2), /docs\/compiled-hooks\.md/);
  cleanupTmpDir(dir);
});

test("scanPlugin reports manualHookCount 0 when there are no hand-written hooks", () => {
  const dir = makeTmpDir("scan-no-manual-hooks");
  write(dir, "CLAUDE.md", "# x\n");
  const r = scanPlugin(dir);
  assert.equal(r.manualHookCount, 0);
  assert.doesNotMatch(formatScanReport(r), /hand-written hook/);
  cleanupTmpDir(dir);
});

test("scanPlugin reports the instruction file on any repo (spec-managed vs hand-written)", () => {
  // A plain cc repo: just a CLAUDE.md, no plugin surface — scan must still
  // surface the instruction file, not look empty.
  const bare = makeTmpDir("scan-instr-bare");
  write(bare, "CLAUDE.md", "# Project\nRun the build.\n");
  const r1 = scanPlugin(bare);
  assert.deepEqual(r1.instructions, { file: "CLAUDE.md", hasSpec: false });
  assert.match(
    formatScanReport(r1),
    /Instructions: CLAUDE\.md \(hand-written, no spec\)/,
  );
  cleanupTmpDir(bare);

  // A spec-managed instruction file (a sibling CLAUDE.md.spec.ts).
  const managed = makeTmpDir("scan-instr-managed");
  write(managed, "CLAUDE.md", "# Project\n");
  write(managed, "CLAUDE.md.spec.ts", "export default {};\n");
  const r2 = scanPlugin(managed);
  assert.deepEqual(r2.instructions, { file: "CLAUDE.md", hasSpec: true });
  assert.match(
    formatScanReport(r2),
    /Instructions: CLAUDE\.md \(spec-managed\)/,
  );
  cleanupTmpDir(managed);

  // No instruction file → null, no Instructions line.
  const none = makeTmpDir("scan-instr-none");
  write(none, "skills/foo/SKILL.md", "---\nname: foo\ndescription: foo\n---\n");
  const r3 = scanPlugin(none);
  assert.equal(r3.instructions, null);
  assert.doesNotMatch(formatScanReport(r3), /Instructions:/);
  cleanupTmpDir(none);
});

test("scanPlugin flags a never-available agent tool, suppresses unrecognized plugin tools", () => {
  const dir = makeTmpDir("scan-toolcontract");
  // A real-world shape (wshobson agent-teams): an unconditionally-withheld tool
  // (AskUserQuestion) mixed with a plugin-provided tool (TeamCreate) vigiles
  // can't know, plus `Agent` and `TaskGet`, which ARE real and must not score —
  // `Agent` is the tool a lead exists to use.
  write(
    dir,
    "agents/lead.md",
    "---\nname: lead\ntools: Read, Bash, Agent, TeamCreate, TaskGet, AskUserQuestion\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((a) => a.name === "lead");
  assert.equal(agent?.toolIssues.length, 1, "only the withheld tool scores");
  assert.equal(agent?.toolIssues[0].kind, "never-available");
  assert.equal(agent?.toolIssues[0].tool, "AskUserQuestion");
  // the report leads with the ✗ + the actionable message
  assert.match(
    formatScanReport(scanPlugin(dir)),
    /never available to a subagent/,
  );
});

test("scanPlugin flags a typo'd agent tool with a did-you-mean", () => {
  const dir = makeTmpDir("scan-tooltypo");
  write(dir, "agents/t.md", "---\nname: t\ntools: Read, Edt\n---\nbody\n");
  const agent = scanPlugin(dir).agents.find((a) => a.name === "t");
  assert.equal(agent?.toolIssues.length, 1);
  assert.match(agent?.toolIssues[0].message ?? "", /Did you mean "Edit"\?/);
});

test("scanPlugin: an inline ARRAY tools form parses (no [Read / Bash] artifacts)", () => {
  const dir = makeTmpDir("scan-toolarray");
  write(
    dir,
    "agents/a.md",
    '---\nname: a\ntools: [Read, "Bash", Edit]\n---\nbody\n',
  );
  const agent = scanPlugin(dir).agents.find((a) => a.name === "a");
  assert.deepEqual(agent?.tools, ["Read", "Bash", "Edit"]);
  assert.deepEqual(agent?.toolIssues, []);
});

test("scanPlugin flags a typo'd hook event, suppresses a framework/custom event", () => {
  const dir = makeTmpDir("scan-hookevent");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "x",
      hooks: {
        // a typo of PreToolUse → scored; a custom/unknown event → advisory, so
        // it is reported but never costs a grade (`TeammateIdle` has since
        // become a REAL Claude Code event, which is the whole point)
        PreToolUSe: [
          { matcher: "Edit", hooks: [{ type: "command", command: "echo a" }] },
        ],
        TeammateIdle: [{ hooks: [{ type: "command", command: "echo b" }] }],
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.equal(r.hookEventIssues.length, 1);
  assert.equal(r.hookEventIssues[0].event, "PreToolUSe");
  assert.match(formatScanReport(r), /Hook events/);
  assert.match(formatScanReport(r), /Did you mean "PreToolUse"\?/);
  cleanupTmpDir(dir);
});

test("scanPlugin does NOT flag a hooks ARRAY (non-CC custom format)", () => {
  // ananddtyagi/sugar shape: hooks is a list of {event:"tool-use",…} objects.
  const dir = makeTmpDir("scan-hookarray");
  write(
    dir,
    "hooks/hooks.json",
    JSON.stringify([{ name: "h", event: "tool-use", action: {} }]),
  );
  assert.deepEqual(scanPlugin(dir).hookEventIssues, []);
  cleanupTmpDir(dir);
});

test("subagent-frontmatter flags a prose-only AGENT, but NOT a frontmatter-less skill", () => {
  const dir = makeTmpDir("scan-fm");
  // A skill with NO frontmatter still loads in CC (name←dir, description←first
  // body paragraph), so it must NOT be flagged — that was a false positive.
  write(
    dir,
    "skills/noname/SKILL.md",
    "# Crisis Advisor\n\nprose, no frontmatter\n",
  );
  // A subagent REQUIRES name+description (no fallback) → a prose-only one won't
  // register. This is the real bug class.
  write(
    dir,
    "agents/proseonly.md",
    "You are an expert. No frontmatter here.\n",
  );
  const r = scanPlugin(dir);
  assert.ok(
    !r.frontmatterIssues.some((i) => i.path.includes("noname")),
    "a frontmatter-less skill is NOT flagged (dir/body fallbacks)",
  );
  assert.ok(
    r.frontmatterIssues.some(
      (i) =>
        i.path.includes("proseonly") &&
        i.kind === "agent" &&
        i.missing.includes("name") &&
        i.missing.includes("description"),
    ),
    "a prose-only agent is missing both required fields",
  );
  assert.match(formatScanReport(r), /Frontmatter/);
  cleanupTmpDir(dir);
});

test("scanPlugin recommends explicit skill frontmatter (skillMetaIssues), but it's not a structural defect", () => {
  const dir = makeTmpDir("scan-skillmeta");
  // Has a description (so it loads + has a trigger surface) but NO explicit name
  // → recommendation only, NOT a structural defect.
  write(
    dir,
    "skills/foo/SKILL.md",
    "---\ndescription: A foo skill with a real explicit description for testing here\n---\n# Foo\n",
  );
  // Explicit name+description → no recommendation.
  write(
    dir,
    "skills/bar/SKILL.md",
    "---\nname: bar\ndescription: A bar skill with a proper explicit description here\n---\n# bar\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.skillMetaIssues.length, 1);
  assert.ok(r.skillMetaIssues[0].path.includes("foo"));
  assert.deepEqual(r.skillMetaIssues[0].missing, ["name"]);
  // It's a recommendation, NOT a structural issue — must not flip the verdict.
  assert.match(formatScanReport(r), /no structural issues found/);
  assert.match(formatScanReport(r), /lack an explicit frontmatter/);
  cleanupTmpDir(dir);
});

test("scanPlugin flags an MCP server that can't start (no command/url)", () => {
  const dir = makeTmpDir("scan-mcp");
  write(
    dir,
    ".mcp.json",
    JSON.stringify({
      mcpServers: {
        ok: { command: "node", args: ["s.js"] },
        remote: { url: "https://x/sse" },
        broken: { args: ["x"] }, // neither command nor url
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.equal(r.mcpIssues.length, 1);
  assert.equal(r.mcpIssues[0].server, "broken");
  assert.match(formatScanReport(r), /MCP config/);
  cleanupTmpDir(dir);
});

test("scanPlugin reads the Agent Plugins standard's root mcp.json", () => {
  // A plugin packaged to the vendor-neutral standard puts its MCP servers in a
  // root `mcp.json`, not the harness's `.mcp.json`. Before this was wired, every
  // MCP check silently passed over such a plugin (it looked like "no servers").
  const dir = makeTmpDir("scan-agent-plugins");
  write(
    dir,
    "plugin.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "demo-plugin",
    }),
  );
  write(
    dir,
    "mcp.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        ok: { type: "stdio", command: "node", args: ["s.js"] },
        broken: { type: "stdio" }, // no command — can't start
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.equal(r.mcpIssues.length, 1);
  assert.equal(r.mcpIssues[0].server, "broken");
  cleanupTmpDir(dir);
});

test("a root mcp.json is IGNORED without an Agent Plugins manifest", () => {
  // `mcp.json` is a generic name. With no manifest declaring the standard, the
  // file belongs to something else and must not be read as the plugin's config
  // (the don't-cry-wolf half of the same decision).
  const dir = makeTmpDir("scan-bare-mcp-json");
  write(
    dir,
    "mcp.json",
    JSON.stringify({ mcpServers: { broken: { args: ["x"] } } }),
  );
  const r = scanPlugin(dir);
  assert.equal(r.mcpIssues.length, 0);
  cleanupTmpDir(dir);
});

test("scanPlugin flags an mcp__server__tool whose server the plugin doesn't declare", () => {
  const dir = makeTmpDir("scan-mcptool");
  write(
    dir,
    ".mcp.json",
    JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
  );
  write(
    dir,
    "agents/a.md",
    "---\nname: a\ntools: Read, mcp__github__search, mcp__linear__create, mcp__ide__getDiagnostics\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((x) => x.name === "a");
  // github = declared (ok), ide = built-in (allowlisted), linear = undeclared (flagged)
  assert.equal(agent?.mcpToolIssues.length, 1);
  assert.equal(agent?.mcpToolIssues[0].server, "linear");
  assert.match(formatScanReport(scanPlugin(dir)), /can't resolve/);
  cleanupTmpDir(dir);
});

test("scanPlugin does NOT flag mcp tools when the plugin declares no servers", () => {
  // The high-precision gate: with no .mcp.json, the agent reaches global/project
  // servers (the ananddtyagi mcp__ide__* shape) — flagging would cry wolf.
  const dir = makeTmpDir("scan-mcptool-nogate");
  write(
    dir,
    "agents/a.md",
    "---\nname: a\ntools: Task, mcp__ide__getDiagnostics, mcp__anything__x\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((x) => x.name === "a");
  assert.deepEqual(agent?.mcpToolIssues, []);
  cleanupTmpDir(dir);
});

test("scanPlugin reports malformed-YAML frontmatter as an informational note, not a defect", () => {
  const dir = makeTmpDir("scan-malformed");
  // Unclosed flow array → invalid YAML; salvage still recovers a long description
  // (so the ONLY finding is the malformed note, not a no-description defect).
  write(
    dir,
    "skills/bad/SKILL.md",
    "---\nname: bad\ndescription: a perfectly long salvageable description here\nallowed-tools: [a, b, c\n---\n# bad\n",
  );
  // Valid frontmatter → not flagged.
  write(
    dir,
    "skills/good/SKILL.md",
    "---\nname: good\ndescription: a perfectly valid description here\n---\n# good\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.malformedFrontmatter.length, 1);
  assert.match(r.malformedFrontmatter[0].path, /bad\/SKILL\.md$/);
  // It's a soft note, NOT counted in the structural verdict.
  assert.match(formatScanReport(r), /isn't valid YAML/);
  assert.doesNotMatch(formatScanReport(r), /1 structural issue/);
  cleanupTmpDir(dir);
});

test("scanPlugin flags near-duplicate model-invocable skill descriptions, skips user-invoked", () => {
  const dir = makeTmpDir("scan-overlap");
  const dup =
    "Use this skill to review code for security issues and suggest concrete fixes before merging the change";
  write(
    dir,
    "skills/a/SKILL.md",
    `---\nname: a\ndescription: ${dup}\n---\n# a\n`,
  );
  write(
    dir,
    "skills/b/SKILL.md",
    `---\nname: b\ndescription: ${dup}\n---\n# b\n`,
  );
  // A user-invoked near-dup must NOT collide (picked by explicit command).
  write(
    dir,
    "skills/c/SKILL.md",
    `---\nname: c\ndescription: ${dup}\ndisable-model-invocation: true\n---\n# c\n`,
  );
  const r = scanPlugin(dir);
  assert.equal(r.descriptionOverlaps.length, 1);
  // The pair is labelled by name AND path: since the loader reads both discovery
  // levels, a name alone can name two different files (`skills/x` +
  // `.claude/skills/x`), and "x and x" identifies neither.
  assert.deepEqual(
    [r.descriptionOverlaps[0].a, r.descriptionOverlaps[0].b].sort(),
    ['"a" (skills/a/SKILL.md)', '"b" (skills/b/SKILL.md)'],
  );
  assert.match(formatScanReport(r), /near-identical/);
  cleanupTmpDir(dir);
});

test("scanPlugin flags an agent model/color typo, not a valid value or full model id", () => {
  const dir = makeTmpDir("scan-modelcolor");
  write(
    dir,
    "agents/typo.md",
    "---\nname: t\ndescription: d\nmodel: sonet\ncolor: yelow\n---\nbody\n",
  );
  write(
    dir,
    "agents/ok.md",
    "---\nname: o\ndescription: d\nmodel: claude-sonnet-4-5\ncolor: cyan\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  const fields = r.frontmatterValueIssues.map(
    (i) => `${i.field}:${i.suggestion}`,
  );
  // typo.md: sonet→sonnet, yelow→yellow. ok.md: full id (skipped) + valid color.
  assert.deepEqual(fields.sort(), ["color:yellow", "model:sonnet"]);
  assert.match(formatScanReport(r), /silently falls back/);
  cleanupTmpDir(dir);
});

test("scanPlugin flags a disallowedTools typo (blocks nothing), not a valid/unknown entry", () => {
  const dir = makeTmpDir("scan-disallowed");
  write(
    dir,
    "agents/a.md",
    "---\nname: a\ntools: Read\ndisallowedTools: Bsh, Bash, Agent, mcp__x__y\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((x) => x.name === "a");
  // Bsh = typo of Bash (flagged); Bash = legitimately blocked; Agent =
  // never-available (harmless to block); mcp__x__y = a real plugin tool to block.
  assert.equal(agent?.disallowedToolIssues.length, 1);
  assert.equal(agent?.disallowedToolIssues[0].tool, "Bsh");
  assert.match(agent?.disallowedToolIssues[0].message ?? "", /blocks nothing/);
  assert.match(formatScanReport(scanPlugin(dir)), /Did you mean "Bash"\?/);
  cleanupTmpDir(dir);
});

test("scanPlugin flags a mcp_tool hook targeting an undeclared server + an incomplete one", () => {
  const dir = makeTmpDir("scan-mcphook");
  write(
    dir,
    ".mcp.json",
    JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }),
  );
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "x",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "mcp_tool", server: "github", tool: "search" }, // ok
              { type: "mcp_tool", server: "linear", tool: "create" }, // undeclared
              { type: "mcp_tool", server: "github" }, // incomplete (no tool)
              { type: "command", command: "echo hi" }, // ignored
            ],
          },
        ],
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.equal(r.mcpHookIssues.length, 2);
  assert.ok(
    r.mcpHookIssues.some(
      (i) => i.kind === "undeclared-server" && i.server === "linear",
    ),
  );
  assert.ok(r.mcpHookIssues.some((i) => i.kind === "incomplete"));
  assert.match(formatScanReport(r), /MCP hook targets/);
  cleanupTmpDir(dir);
});

test("scanPlugin reports agent tool contracts incl. inherits-all", () => {
  const dir = fixture();
  const r = scanPlugin(dir);
  const byName = Object.fromEntries(r.agents.map((a) => [a.name, a]));
  assert.deepEqual(byName.withtools.tools, ["Read", "Grep"]);
  assert.equal(byName.notools.tools, null); // no tools: line → inherits all
  cleanupTmpDir(dir);
});

test("scanPlugin does not misclassify a '-agents' skill dir as an agent", () => {
  // Regression: obra/superpowers ships skills/dispatching-parallel-agents/SKILL.md.
  // The old unanchored /agents\/[^/]+\.md$/ matched the `-agents/SKILL.md`
  // substring and reported a phantom agent named "SKILL".
  const dir = makeTmpDir("scan-boundary");
  write(
    dir,
    "skills/dispatching-parallel-agents/SKILL.md",
    "---\nname: dispatching-parallel-agents\ndescription: Dispatch many subagents in parallel for fan-out work\n---\n# x\n",
  );
  write(
    dir,
    "skills/my-commands/SKILL.md",
    "---\nname: my-commands\ndescription: A skill whose directory ends in commands here\n---\n# y\n",
  );
  write(dir, "agents/real.md", "---\nname: real\ntools: Read\n---\nbody\n");
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["real"],
  );
  assert.equal(r.skills.length, 2);
  assert.equal(r.commands, 0); // the `my-commands` skill dir is not a command
  cleanupTmpDir(dir);
});

test("scanPlugin does not treat a skill-internal agents/ dir as subagents", () => {
  // Regression: Anthropic's official skill-creator ships skill-internal worker
  // docs at skills/skill-creator/agents/{analyzer,comparator,grader}.md with NO
  // frontmatter. Those are NOT dispatchable Claude Code subagents (CC loads
  // subagents only from the plugin's TOP-LEVEL agents/ — recursively WITHIN it,
  // never nested under a skill). The old classifier matched `agents/` anywhere in
  // the path, so it flagged them as subagents missing name/description + with no
  // tool contract → mis-graded a first-party plugin F. They must be ignored.
  const dir = makeTmpDir("scan-nested-agents");
  write(
    dir,
    "skills/skill-creator/SKILL.md",
    "---\nname: skill-creator\ndescription: Create new skills end to end\n---\n# x\n",
  );
  // No frontmatter — would be flagged if misclassified as a subagent.
  write(dir, "skills/skill-creator/agents/analyzer.md", "# Analyzer\nprose\n");
  write(
    dir,
    "skills/skill-creator/agents/comparator.md",
    "# Comparator\nprose\n",
  );
  write(dir, "skills/skill-creator/agents/grader.md", "# Grader\nprose\n");
  // A genuine TOP-LEVEL subagent must still be discovered AND checked.
  write(
    dir,
    "agents/reviewer.md",
    "---\nname: reviewer\ndescription: Review a diff for correctness\ntools: Read\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  // Only the real top-level subagent registers; the nested files are ignored.
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["reviewer"],
  );
  // No frontmatter penalty: the real agent is complete and the nested
  // skill-internal docs (no frontmatter) are not subagents at all.
  assert.equal(r.frontmatterIssues.length, 0);
  cleanupTmpDir(dir);
});

test("scanPlugin does not treat a commands/agents/ dir as subagents", () => {
  // Regression (found by the OSS sweep on ruvnet/claude-flow): a plugin ships
  // commands namespaced `/agents:…` at `.claude/commands/agents/{spawn,status,…}.md`
  // plus a `README.md`. CC loads subagents only from the TOP-LEVEL agents/ dir,
  // never under commands/ — so these are COMMANDS, not dispatchable subagents.
  // The old classifier matched `agents/` anywhere, so it flagged each command
  // (and the README) as a subagent missing name/description → mis-graded the
  // plugin F (Structure 0). They must be ignored.
  const dir = makeTmpDir("scan-command-agents");
  write(dir, "commands/agents/spawn.md", "# spawn\nSpawn an agent.\n");
  write(dir, "commands/agents/status.md", "# status\nShow agent status.\n");
  write(dir, "commands/agents/README.md", "# Agents Commands\nprose\n");
  // A genuine TOP-LEVEL subagent must still be discovered AND checked.
  write(
    dir,
    "agents/reviewer.md",
    "---\nname: reviewer\ndescription: Review a diff for correctness\ntools: Read\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  // Only the real top-level subagent registers; the commands are not subagents.
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["reviewer"],
  );
  // No frontmatter penalty: the commands (incl. README) are not subagents.
  assert.equal(r.frontmatterIssues.length, 0);
  cleanupTmpDir(dir);
});

test("scanPlugin reads agents/ SUBDIRECTORIES, scoping the name by subfolder", () => {
  // The vendor documents this and vigiles read only the top level. Verbatim from
  // https://code.claude.com/docs/en/sub-agents (re-fetched 2026-08-18):
  //   "Plugin `agents/` directories are also scanned recursively. Unlike project
  //    and user scopes, a subfolder inside a plugin's `agents/` directory becomes
  //    part of the scoped identifier: a file at `agents/review/security.md` in
  //    plugin `my-plugin` registers as `my-plugin:review:security`."
  // Measured on rsmdt/the-startup @ 88d447c7: 16 agent files on disk, 2 read —
  // and the plugin was still graded B (80/100) over that 12.5%.
  const dir = makeTmpDir("scan-recursive-agents");
  write(
    dir,
    "agents/top.md",
    "---\nname: top\ndescription: A top-level agent for the recursion probe.\ntools: Read\n---\nbody\n",
  );
  write(
    dir,
    "agents/review/security.md",
    "---\nname: security\ndescription: Reviews a diff for security defects.\ntools: Read\n---\nbody\n",
  );
  write(
    dir,
    "agents/review/deep/perf.md",
    "---\nname: perf\ndescription: Reviews a diff for performance defects.\ntools: Read\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["review:deep:perf", "review:security", "top"],
  );
  cleanupTmpDir(dir);
});

test("a nested agent's own defects are reported, not just its existence", () => {
  // The point of reading the subdirectory is the findings inside it: on
  // rsmdt/the-startup, 12 real malformed-frontmatter defects sat in the 87.5% of
  // the surface that was never opened.
  const dir = makeTmpDir("scan-recursive-agent-defects");
  write(dir, "agents/team/broken.md", "# Broken\nno frontmatter at all\n");
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["team:broken"],
  );
  assert.ok(
    r.frontmatterIssues.some((i) => i.path.endsWith("agents/team/broken.md")),
    "a nested agent missing name/description must be flagged",
  );
  cleanupTmpDir(dir);
});

test("recursion does not leak through the two nesting traps, even at depth", () => {
  // The silent half. Recursion widened the agent pattern, so re-prove that the
  // skill-internal and command-namespaced exclusions still hold — and hold when
  // the trap dir itself is nested, which the pre-recursion pattern never had to
  // survive.
  const dir = makeTmpDir("scan-recursive-agents-traps");
  write(dir, "skills/skill-creator/agents/analyzer.md", "# Analyzer\nprose\n");
  write(
    dir,
    "skills/skill-creator/agents/sub/comparator.md",
    "# Comparator\nprose\n",
  );
  write(dir, "commands/agents/spawn.md", "# spawn\nprose\n");
  write(dir, "commands/agents/sub/status.md", "# status\nprose\n");
  write(
    dir,
    "agents/reviewer.md",
    "---\nname: reviewer\ndescription: Review a diff for correctness\ntools: Read\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["reviewer"],
  );
  assert.equal(r.frontmatterIssues.length, 0);
  cleanupTmpDir(dir);
});

test("a SKILL.md nested under agents/ is counted ONCE, as an agent", () => {
  // Reading `agents/` recursively made this shape reachable for the first time:
  // the file matches the skill pattern (it always did) AND now the agent pattern,
  // so without the mirror exclusion it would be counted as both — two surfaces
  // from one file, graded twice. The harness reads skills from the plugin's own
  // `skills/` dir and every `.md` under `agents/` recursively, so it is an agent.
  const dir = makeTmpDir("scan-skill-under-agents");
  write(
    dir,
    "agents/team/skills/helper/SKILL.md",
    "---\nname: helper\ndescription: A skill nested underneath the agents dir.\n---\nbody\n",
  );
  write(
    dir,
    "agents/real.md",
    "---\nname: real\ndescription: A genuine top-level agent alongside it.\ntools: Read\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["real", "team:skills:helper:SKILL"],
  );
  assert.deepEqual(
    r.skills.map((s) => s.name),
    [],
    "must not ALSO be a skill",
  );
  cleanupTmpDir(dir);
});

test("a plugin's own skills/ is untouched by that mirror exclusion", () => {
  // The silent half: the exclusion is scoped to a skills dir sitting UNDER
  // agents/, so an ordinary plugin's skills must be entirely unaffected.
  const dir = makeTmpDir("scan-skill-normal");
  write(
    dir,
    "skills/deployer/SKILL.md",
    "---\nname: deployer\ndescription: Deploys the application to production safely.\n---\nbody\n",
  );
  // A skill that itself ships an `agents/` subdir — the shape the OTHER
  // exclusion exists for. It must stay a skill, and its worker doc must stay
  // neither a skill nor an agent.
  write(
    dir,
    "skills/skill-creator/SKILL.md",
    "---\nname: skill-creator\ndescription: Creates new skills end to end for this repo.\n---\nbody\n",
  );
  write(dir, "skills/skill-creator/agents/analyzer.md", "# Analyzer\nprose\n");
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["deployer", "skill-creator"],
  );
  assert.deepEqual(
    r.agents.map((a) => a.name),
    [],
  );
  cleanupTmpDir(dir);
});

test("the coverage discoverer sees exactly the agents the scan classifier does", () => {
  // 🔴 The reason AGENT_FILE_LEAF_RE exists. THREE places independently spelled
  // the agent-file depth rule: this classifier and the two coverage discoverers.
  // Fixing only the classifier would have made `audit` print a subagent count
  // and an untested-surface count computed over different sets of files — a new
  // internal disagreement, introduced by the fix for the old one.
  const dir = makeTmpDir("scan-recursive-agents-coverage");
  for (const p of [
    "agents/top.md",
    "agents/a/one.md",
    "agents/a/b/two.md",
    "agents/c/three.md",
  ]) {
    write(
      dir,
      p,
      "---\nname: x\ndescription: An agent for the coverage-agreement probe.\ntools: Read\n---\nbody\n",
    );
  }
  const r = scanPlugin(dir);
  assert.equal(r.agents.length, 4);
  // `untested` counts surfaces with no vigiles test; none of these has one, so
  // it must equal the agent count. If the discoverers disagree, so do these.
  assert.equal(r.untested, r.agents.length);
  cleanupTmpDir(dir);
});

test("scanPlugin still flags a real top-level subagent missing frontmatter", () => {
  // Guard the other direction: the nested-agents exclusion must NOT silence a
  // genuine top-level agents/ file that really is missing name/description.
  const dir = makeTmpDir("scan-real-agent-missing-fm");
  write(dir, "agents/broken.md", "# Broken\nno frontmatter at all\n");
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.agents.map((a) => a.name),
    ["broken"],
  );
  assert.ok(
    r.frontmatterIssues.some((i) => i.path.endsWith("agents/broken.md")),
  );
  cleanupTmpDir(dir);
});

test("scanPlugin resolves hook scripts: ok / missing / unresolved", () => {
  const dir = fixture();
  const r = scanPlugin(dir);
  const byBase = (suffix: string) =>
    r.hooks.find((h) => h.script.endsWith(suffix));
  assert.equal(byBase("hooks/present.sh")?.status, "ok"); // ${CLAUDE_PLUGIN_ROOT}
  assert.equal(byBase("hooks/absent.sh")?.status, "missing"); // $CLAUDE_PLUGIN_ROOT, no file
  // "$HOME"/weird.sh keeps an unexpanded var → can't be path-checked
  assert.ok(r.hooks.some((h) => h.status === "unresolved"));
  assert.equal(r.inlineHooks, 1); // `npm test`
  cleanupTmpDir(dir);
});

test("scanPlugin counts commands and detects MCP", () => {
  const dir = fixture();
  const r = scanPlugin(dir);
  assert.equal(r.commands, 1);
  assert.equal(r.mcp, true);
  cleanupTmpDir(dir);
});

test("formatScanReport flags the missing hook + the no-description skill", () => {
  const dir = fixture();
  const text = formatScanReport(scanPlugin(dir));
  assert.ok(text.includes("structural issue")); // absent.sh + nodesc
  assert.ok(/✗ .*hooks\/absent\.sh/.test(text));
  assert.ok(text.includes("inherits all")); // the notools agent footgun
  cleanupTmpDir(dir);
});

test("scanPlugin surfaces a dangling ref from a hook script, but ignores prose mentions", () => {
  const dir = makeTmpDir("scan-dangling");
  // A hook SCRIPT that reads a sibling skill file which doesn't exist — the
  // real partial-vendor / broken-path class (obra/superpowers' hooks/session-start
  // reads skills/using-superpowers/SKILL.md). Executable → a real file op.
  write(
    dir,
    "hooks/session-start.sh",
    "#!/usr/bin/env bash\ncat skills/missing-helper/SKILL.md\n",
  );
  // A SKILL.md that merely MENTIONS a missing path in prose is NOT a real ref
  // (it's an example / template) and must NOT be flagged — the doc-mention trap.
  write(
    dir,
    "skills/docs/SKILL.md",
    "---\nname: docs\ndescription: A skill mentioning skills/not-real/SKILL.md as an example here\n---\nSee skills/not-real/SKILL.md\n",
  );
  const r = scanPlugin(dir);
  assert.deepEqual(r.danglingRefs, ["skills/missing-helper/SKILL.md"]);
  const text = formatScanReport(r);
  assert.ok(text.includes("Broken references"));
  assert.ok(/✗ skills\/missing-helper\/SKILL\.md/.test(text));
  assert.ok(text.includes("structural issue")); // counted in the verdict
  // shown once (as a ✗), not duplicated in the free-text Warnings block
  assert.ok(!text.includes("intra-plugin file(s) that don't exist"));
  cleanupTmpDir(dir);
});

test("scanPlugin: the reference extractor does not accuse a file that is present", () => {
  // The disk half of the boundary + comment fixes (dogfood 2026-08-17). Three
  // planted false-accusation shapes and one control, in one plugin so the
  // control proves the detector is still on.
  const dir = makeTmpDir("scan-refs");
  write(dir, ".claude-plugin/plugin.json", '{"name":"p","version":"0.1.0"}');
  write(dir, "hooks/hooks.json", '{"hooks":{}}');
  // 1. `.json` truncated to `.js` — the file is right there.
  write(dir, "hooks/a.js", 'load("./hooks.json"); // see hooks/hooks.json\n');
  // 2. the surface dir matched inside a longer name.
  write(dir, "claude-agents/adv.md", "---\nname: adv\ndescription: adv\n---\n");
  write(
    dir,
    "hooks/b.js",
    'new URL("../claude-agents/adv.md", import.meta.url);\n',
  );
  // 3. a path named only in a full-line JSDoc comment.
  write(
    dir,
    "hooks/c.js",
    "/**\n * `git log -- hooks/never-existed.mjs` is refused.\n */\nrun();\n",
  );
  // 4. CONTROL — a genuinely missing ref on a real code line, reported under
  //    the name the author actually wrote.
  write(dir, "hooks/d.js", 'const p = "hooks/gone.json";\nload(p);\n');
  assert.deepEqual(scanPlugin(dir).danglingRefs, ["hooks/gone.json"]);
  cleanupTmpDir(dir);
});

test("scanPlugin: an inline `node -e` hook is not reported as a missing script", () => {
  // ayghri/i-have-adhd + microsoft/power-platform-skills: a character run cut
  // out of the JavaScript payload was reported as the hook's script name, and
  // rendered as that name in the report, while the real .mjs sat on disk. Nine
  // such findings across the 32-repo corpus.
  const dir = makeTmpDir("scan-node-e");
  write(dir, ".claude-plugin/plugin.json", '{"name":"p","version":"0.1.0"}');
  write(dir, "hooks/always-on.mjs", "console.log(1)\n");
  const inline =
    'node -e "(async()=>{const root=process.env.CLAUDE_PLUGIN_ROOT;' +
    "if(root)await import(require('node:url').pathToFileURL(" +
    "require('node:path').join(root,'hooks','always-on.mjs')).href)})()\"";
  write(
    dir,
    "hooks/hooks.json",
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: inline }] }],
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.deepEqual(r.hooks, []); // no script token at all…
  assert.equal(r.inlineHooks, 1); // …it is an inline one-liner, and says so
  cleanupTmpDir(dir);
});

test("scanPlugin: a hook script on the RIGHT of && is still existence-checked", () => {
  // The control for the extractor choice: `leafArgvSource` drops this leaf by
  // design, so reusing it here would have traded a false positive for a miss.
  const dir = makeTmpDir("scan-and-hook");
  write(dir, ".claude-plugin/plugin.json", '{"name":"p","version":"0.1.0"}');
  write(
    dir,
    "hooks/hooks.json",
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'cd "$CLAUDE_PLUGIN_ROOT" && node hooks/gone.mjs',
              },
            ],
          },
        ],
      },
    }),
  );
  const r = scanPlugin(dir);
  assert.deepEqual(
    r.hooks.map((h) => [h.script, h.status]),
    [["hooks/gone.mjs", "missing"]],
  );
  cleanupTmpDir(dir);
});

test("expandMarketplace expands a marketplace root into member plugin dirs", () => {
  const dir = makeTmpDir("scan-mp");
  write(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "mp",
      plugins: [
        { name: "a", source: "./plugins/a" },
        { name: "b", source: "./plugins/b" },
        { name: "gone", source: "./plugins/gone" }, // dir doesn't exist → skipped
        { name: "ext", source: { source: "github", repo: "x/y" } }, // not on disk → skipped
      ],
    }),
  );
  write(dir, "plugins/a/skills/sa/SKILL.md", "---\nname: sa\n---\n# sa\n");
  write(dir, "plugins/b/skills/sb/SKILL.md", "---\nname: sb\n---\n# sb\n");
  const members = expandMarketplace(dir);
  assert.ok(members);
  assert.equal(members.length, 2); // gone + ext skipped
  assert.ok(
    members.every((m) => m.endsWith("plugins/a") || m.endsWith("plugins/b")),
  );
  // a non-marketplace dir returns null
  assert.equal(expandMarketplace(join(dir, "plugins/a")), null);
  cleanupTmpDir(dir);
});

test("inspectMarketplace classifies on-disk vs external + dedupes aliased dirs", () => {
  const dir = makeTmpDir("scan-mp-inspect");
  write(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "mp",
      plugins: [
        { name: "a", source: "./plugins/a" },
        // two more NAMES aliasing the same dir — must count once (the han shape)
        { name: "a-alias", source: "./plugins/a" },
        { name: "a-again", source: "./plugins/a" },
        { name: "ext1", source: { source: "url", url: "https://x/y.git" } },
        { name: "ext2", source: { source: "github", repo: "p/q" } },
        { name: "gone", source: "./plugins/gone" }, // string path, absent → external
      ],
    }),
  );
  write(dir, "plugins/a/skills/sa/SKILL.md", "---\nname: sa\n---\n# sa\n");
  const mp = inspectMarketplace(dir);
  assert.ok(mp);
  assert.equal(mp.name, "mp");
  assert.equal(mp.total, 6);
  assert.equal(mp.onDisk.length, 1, "three aliases of plugins/a dedupe to one");
  assert.equal(mp.external, 3, "two url/github + one missing string path");
  // expandMarketplace delegates → also deduped
  assert.deepEqual(expandMarketplace(dir), [...mp.onDisk]);
  assert.equal(inspectMarketplace(join(dir, "plugins/a")), null); // not a marketplace
  cleanupTmpDir(dir);
});

test("inspectMarketplace reports a CURATED marketplace (all external, none on disk)", () => {
  // obra/superpowers-marketplace, anthropics/claude-plugins-community shape.
  const dir = makeTmpDir("scan-mp-curated");
  write(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "curated",
      plugins: [
        { name: "p1", source: { source: "url", url: "https://x/1.git" } },
        { name: "p2", source: { source: "url", url: "https://x/2.git" } },
      ],
    }),
  );
  const mp = inspectMarketplace(dir);
  assert.ok(mp);
  assert.equal(mp.onDisk.length, 0);
  assert.equal(mp.external, 2);
  assert.equal(mp.total, 2);
  assert.deepEqual(expandMarketplace(dir), []); // marketplace, but nothing on disk
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// Effect-surface column tests (deterministic, no model)
// ---------------------------------------------------------------------------

test("effect surface: agent with only read-only tools is pure", () => {
  const dir = makeTmpDir("scan-effect-pure");
  write(
    dir,
    "agents/reader.md",
    "---\nname: reader\ndescription: Reads files\ntools: Read, Grep, Glob\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((a) => a.name === "reader");
  assert.ok(agent, "agent found");
  assert.equal(agent.purity, "pure");
  assert.deepEqual(agent.effectBuckets.sideEffecting, []);
  assert.deepEqual(agent.effectBuckets.unknown, []);
  assert.ok(agent.effectBuckets.readOnly.length > 0, "has read-only tools");
  cleanupTmpDir(dir);
});

test("effect surface: agent with side-effecting tools (no Bash) is bounded", () => {
  const dir = makeTmpDir("scan-effect-bounded");
  write(
    dir,
    "agents/writer.md",
    "---\nname: writer\ndescription: Writes files\ntools: Read, Write, Edit\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((a) => a.name === "writer");
  assert.ok(agent, "agent found");
  assert.equal(agent.purity, "bounded");
  assert.ok(
    agent.effectBuckets.sideEffecting.length > 0,
    "has side-effecting tools",
  );
  assert.deepEqual(agent.effectBuckets.unknown, []);
  cleanupTmpDir(dir);
});

test("effect surface: agent with Bash is unrestricted", () => {
  const dir = makeTmpDir("scan-effect-bash");
  write(
    dir,
    "agents/runner.md",
    "---\nname: runner\ndescription: Runs commands\ntools: Read, Bash\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((a) => a.name === "runner");
  assert.ok(agent, "agent found");
  assert.equal(agent.purity, "unrestricted");
  assert.ok(
    agent.effectBuckets.sideEffecting.includes("Bash"),
    "Bash in side-effecting bucket",
  );
  cleanupTmpDir(dir);
});

test("effect surface: agent with no tools line (inherits-all) is unrestricted", () => {
  const dir = makeTmpDir("scan-effect-inheritsall");
  // An agent with no `tools:` line inherits all tools including side-effecting ones.
  write(
    dir,
    "agents/wildcard.md",
    "---\nname: wildcard\ndescription: Does anything\n---\nbody\n",
  );
  const agent = scanPlugin(dir).agents.find((a) => a.name === "wildcard");
  assert.ok(agent, "agent found");
  assert.equal(agent.tools, null, "no tools: line → inherits all");
  assert.equal(agent.purity, "unrestricted");
  cleanupTmpDir(dir);
});

test("effect surface: harness-level puritySummary aggregates correctly", () => {
  const dir = makeTmpDir("scan-effect-summary");
  // pure: only read-only tools
  write(
    dir,
    "agents/reader.md",
    "---\nname: reader\ndescription: Reads\ntools: Read, Grep\n---\nbody\n",
  );
  // bounded: side-effecting, no Bash, no unknown
  write(
    dir,
    "agents/writer.md",
    "---\nname: writer\ndescription: Writes\ntools: Read, Write\n---\nbody\n",
  );
  // unrestricted: Bash
  write(
    dir,
    "agents/runner.md",
    "---\nname: runner\ndescription: Runs\ntools: Bash\n---\nbody\n",
  );
  // unrestricted: inherits-all (no tools: line)
  write(
    dir,
    "agents/wild.md",
    "---\nname: wild\ndescription: Wild\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.puritySummary.pure, 1);
  assert.equal(r.puritySummary.bounded, 1);
  assert.equal(r.puritySummary.unrestricted, 2);
  cleanupTmpDir(dir);
});

test("effect surface: formatScanReport includes purity tags per agent and the summary line", () => {
  const dir = makeTmpDir("scan-effect-format");
  write(
    dir,
    "agents/reader.md",
    "---\nname: reader\ndescription: Reads files for analysis\ntools: Read, Grep\n---\nbody\n",
  );
  write(
    dir,
    "agents/writer.md",
    "---\nname: writer\ndescription: Writes output files here\ntools: Read, Write\n---\nbody\n",
  );
  write(
    dir,
    "agents/runner.md",
    "---\nname: runner\ndescription: Runs shell commands here\ntools: Bash\n---\nbody\n",
  );
  const text = formatScanReport(scanPlugin(dir));
  // Each agent line includes the purity tag in brackets.
  assert.match(text, /reader.*\[pure\]/);
  assert.match(text, /writer.*\[bounded\]/);
  assert.match(text, /runner.*\[unrestricted\]/);
  // Harness-level summary line is present.
  assert.match(text, /Effect surface: 1 pure · 1 bounded · 1 unrestricted/);
  cleanupTmpDir(dir);
});

test("effect surface: puritySummary is in the JSON shape (ScanReport)", () => {
  const dir = makeTmpDir("scan-effect-json");
  write(
    dir,
    "agents/a.md",
    "---\nname: a\ndescription: Does stuff\ntools: Read\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  // The puritySummary field is present on the report object (JSON shape).
  assert.ok("puritySummary" in r);
  assert.equal(typeof r.puritySummary.pure, "number");
  assert.equal(typeof r.puritySummary.bounded, "number");
  assert.equal(typeof r.puritySummary.unrestricted, "number");
  // effectBuckets is on each agent.
  assert.ok("effectBuckets" in r.agents[0]);
  assert.ok("purity" in r.agents[0]);
  cleanupTmpDir(dir);
});

// __dirname is dist/ at runtime; the fixture server lives at the repo root.
const FIXTURE = join(__dirname, "../examples/harness/fixture-mcp-server.mjs");

test("verifyLiveMcpTools: flags a tool absent from the live server (with a did-you-mean)", async () => {
  const dir = makeTmpDir("scan-verify-mcp");
  // Declare the fixture server (exposes echo, add) and an agent that references a
  // real tool (echo) plus a typo (ekho) — the static check passes the server, only
  // a live tools/list catches the missing tool.
  write(
    dir,
    ".mcp.json",
    JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } },
    }),
  );
  write(
    dir,
    "agents/probe.md",
    "---\nname: probe\ndescription: Probes the server\ntools: Read, mcp__fixture__echo, mcp__fixture__ekho\n---\nbody\n",
  );
  const report = scanPlugin(dir);
  const errs = await verifyLiveMcpTools(
    report,
    claudeCodeLayout,
    claudeCodeDialect,
  );
  assert.equal(errs.length, 1);
  assert.equal(errs[0].reason, "tool-missing");
  assert.equal(errs[0].toolName, "ekho");
  assert.ok(errs[0].suggestions.includes("echo"));
  // The human-readable report names the issue.
  assert.match(formatMcpContractReport(errs), /1 issue/);
  cleanupTmpDir(dir);
});

test("verifyLiveMcpTools: no declared servers → nothing started, no errors", async () => {
  const dir = makeTmpDir("scan-verify-mcp-none");
  // An agent references an undeclared server — the live check has no config to
  // start it, so it's the static verifyMcpToolServers' job, not this tier's.
  write(
    dir,
    "agents/probe.md",
    "---\nname: probe\ndescription: Probes a ghost\ntools: mcp__ghost__whatever\n---\nbody\n",
  );
  const report = scanPlugin(dir);
  const errs = await verifyLiveMcpTools(
    report,
    claudeCodeLayout,
    claudeCodeDialect,
  );
  assert.deepEqual(errs, []);
  assert.match(formatMcpContractReport(errs), /resolves/);
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// lethal-trifecta — surfaced through scanPlugin (the shared detector, no drift)
// ---------------------------------------------------------------------------

test("scanPlugin flags a HARD lethal trifecta on a subagent with all three legs", () => {
  const dir = makeTmpDir("scan-trifecta-hard");
  // Read (private) + WebFetch (untrusted in) + WebFetch (exfil out): all 3 legs.
  write(
    dir,
    "agents/exfil.md",
    "---\nname: exfil\ndescription: Reads code, fetches the web, and posts\ntools: Read, WebFetch\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  const agent = r.agents.find((a) => a.name === "exfil");
  assert.ok(agent?.trifecta, "the subagent carries a trifecta finding");
  assert.equal(agent.trifecta?.severity, "hard");
  // The aggregate report list carries the path-tagged finding for the lint rule.
  const flat = r.trifectaFindings.find((t) => t.name === "exfil");
  assert.ok(flat, "the finding lands on the report's flat list");
  assert.equal(flat.kind, "subagent");
  // …and it prints in the human report under the trifecta section.
  assert.match(formatScanReport(r), /Lethal trifecta/);
  assert.match(formatScanReport(r), /✗ subagent exfil/);
  cleanupTmpDir(dir);
});

test("scanPlugin reports an inherits-all subagent trifecta as ADVISORY", () => {
  const dir = makeTmpDir("scan-trifecta-advisory");
  write(
    dir,
    "agents/wide.md",
    "---\nname: wide\ndescription: No tools line\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  const agent = r.agents.find((a) => a.name === "wide");
  assert.equal(agent?.trifecta?.severity, "advisory");
  assert.match(formatScanReport(r), /⚠ subagent wide/);
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// A SKILL's trifecta is read off `disallowed-tools:`, NOT `allowed-tools:`
//
// 🔴 The defect these exist for (measured 2026-08-11). `allowed-tools:` is a
// PRE-APPROVAL — Claude Code's docs: "It does not restrict which tools are
// available: every tool remains callable" — confirmed by anthropics/claude-code
// #18837 and #37683 (both closed not-planned; #37683 reproduces it interactively
// on a live model). Reading it as a bound made the finding UNDERSTATE risk (18 of
// 38 units reported exposed on a corpus where all 38 were) and CREDIT a narrow
// list with a reduction it does not produce. `disallowed-tools:` WAS measured — 9
// runs — and does remove the tool, in subagents as well.
// ---------------------------------------------------------------------------

test("a skill with NO disallowed-tools fence holds all three legs; user-invoked excluded", () => {
  const dir = makeTmpDir("scan-trifecta-skill");
  write(
    dir,
    "skills/leaky/SKILL.md",
    "---\nname: leaky\ndescription: A model-invocable skill that does many things here\nallowed-tools: Read, WebFetch\n---\n# leaky\n",
  );
  // Same shape but user-invoked → cannot be hijacked by attacker content → excluded.
  write(
    dir,
    "skills/manual/SKILL.md",
    "---\nname: manual\ndescription: A user-invoked skill that also has all the legs here\ndisable-model-invocation: true\nallowed-tools: Read, WebFetch\n---\n# manual\n",
  );
  const r = scanPlugin(dir);
  const leaky = r.skills.find((s) => s.name === "leaky");
  const manual = r.skills.find((s) => s.name === "manual");
  assert.equal(leaky?.trifecta?.severity, "advisory");
  assert.equal(leaky?.trifecta?.fence, "none");
  assert.match(leaky?.trifecta?.message ?? "", /No `disallowed-tools:` line/);
  assert.equal(manual?.trifecta, null, "user-invoked skill is excluded");
  assert.ok(
    r.trifectaFindings.some((t) => t.name === "leaky" && t.kind === "skill"),
  );
  assert.ok(!r.trifectaFindings.some((t) => t.name === "manual"));
  cleanupTmpDir(dir);
});

test("🔴 a NARROW allowed-tools does not reduce the finding (pre-approval, not a fence)", () => {
  // The whole point of the retarget, pinned. `Read, Grep` names no untrusted-intake
  // and no exfil tool at all — under the old reading that scored CLEAN. It must not,
  // because the session still grants WebFetch/Bash and the skill can still call them.
  // If this ever goes back to `null`, the pre-approval misreading has returned.
  const dir = makeTmpDir("scan-trifecta-narrow-allowed");
  write(
    dir,
    "skills/narrow/SKILL.md",
    "---\nname: narrow\ndescription: A model-invocable skill declaring a very narrow tool list\nallowed-tools: Read, Grep\n---\n# narrow\n",
  );
  // …and the WIDEST possible `allowed-tools` scores identically, because the field
  // is not an input at all: same severity, same fence state, same legs.
  write(
    dir,
    "skills/wide/SKILL.md",
    "---\nname: wide\ndescription: A model-invocable skill declaring every tool it could ever want\nallowed-tools: Read, Grep, Glob, Bash, WebFetch, WebSearch\n---\n# wide\n",
  );
  const r = scanPlugin(dir);
  const narrow = r.skills.find((s) => s.name === "narrow")?.trifecta;
  const wide = r.skills.find((s) => s.name === "wide")?.trifecta;
  assert.notEqual(narrow, null, "a narrow allowed-tools is NOT a fence");
  assert.equal(narrow?.severity, wide?.severity);
  assert.equal(narrow?.fence, wide?.fence);
  assert.deepEqual(narrow?.legs, wide?.legs);
  assert.equal(r.trifectaFindings.filter((t) => t.kind === "skill").length, 2);
  cleanupTmpDir(dir);
});

test("a disallowed-tools that CLOSES a leg clears the finding", () => {
  const dir = makeTmpDir("scan-trifecta-fenced");
  // Denying every built-in supplier of untrusted-intake AND exfiltration leaves only
  // private-data read standing → Rule of Two holds → no finding.
  write(
    dir,
    "skills/fenced/SKILL.md",
    "---\nname: fenced\ndescription: A model-invocable skill that fences off the network entirely\ndisallowed-tools: WebFetch, WebSearch, Bash\n---\n# fenced\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.skills.find((s) => s.name === "fenced")?.trifecta, null);
  assert.equal(r.trifectaFindings.length, 0);
  cleanupTmpDir(dir);
});

test("the SPACE-separated spelling of that same fence also clears it (#217)", () => {
  const dir = makeTmpDir("scan-trifecta-fenced-spaces");
  // Byte-for-byte the fence above with the commas removed — the spelling Claude
  // Code documents and honours. It used to read as ONE token named
  // "WebFetch WebSearch Bash", matching no built-in, so every leg still counted as
  // supplied and the author was told their working fence closed nothing (#217).
  write(
    dir,
    "skills/fenced/SKILL.md",
    "---\nname: fenced\ndescription: A model-invocable skill that fences off the network entirely\ndisallowed-tools: WebFetch WebSearch Bash\n---\n# fenced\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.skills.find((s) => s.name === "fenced")?.trifecta, null);
  assert.equal(r.trifectaFindings.length, 0);
  cleanupTmpDir(dir);
});

test("a PARTIAL disallowed-tools closes no leg and names the suppliers still standing", () => {
  const dir = makeTmpDir("scan-trifecta-partial-fence");
  // Denying `Read` alone leaves Grep/Glob/Bash on the private-data leg — an author
  // who believed they had fenced and had not. Per-skill, keeps its own line.
  write(
    dir,
    "skills/half/SKILL.md",
    "---\nname: half\ndescription: A model-invocable skill that denies exactly one read tool\ndisallowed-tools: Read\n---\n# half\n",
  );
  const r = scanPlugin(dir);
  const f = r.skills.find((s) => s.name === "half")?.trifecta;
  assert.equal(f?.fence, "ineffective");
  assert.equal(f?.severity, "advisory", "never LOUDER than declaring no fence");
  assert.match(f?.message ?? "", /closes no lethal-trifecta leg/);
  assert.deepEqual(f?.legs.private, ["Grep", "Glob", "Bash"]);
  cleanupTmpDir(dir);
});

test("the report AGGREGATES unfenced skills into one line but still counts every unit", () => {
  // A per-skill line for the ecosystem DEFAULT would print on ~100% of harnesses,
  // and a section that always fires gets muted — taking the hard findings with it.
  const dir = makeTmpDir("scan-trifecta-aggregate");
  for (const n of ["alpha", "beta", "gamma"]) {
    write(
      dir,
      `skills/${n}/SKILL.md`,
      `---\nname: ${n}\ndescription: A model-invocable skill with no tool fence declared at all\n---\n# ${n}\n`,
    );
  }
  const r = scanPlugin(dir);
  const text = formatScanReport(r);
  assert.equal(r.trifectaFindings.length, 3, "every unit is still a finding");
  // The header counts UNITS (3), not the lines the aggregate collapsed them into.
  assert.match(text, /Lethal trifecta \(prompt-injection exfil risk\) \(3\)/);
  assert.match(text, /3 of 3 model-invocable skill\(s\) declare no/);
  assert.match(text, /alpha, beta, gamma/);
  // …and it says WHY narrowing `allowed-tools` is not the fix.
  assert.match(text, /`allowed-tools:` does NOT fence a skill/);
  cleanupTmpDir(dir);
});

test("scanPlugin: a two-leg subagent is NOT a trifecta (Rule of Two)", () => {
  const dir = makeTmpDir("scan-trifecta-two-legs");
  // Read (private) + WebSearch (untrusted) — no exfil leg → safe.
  write(
    dir,
    "agents/safe.md",
    "---\nname: safe\ndescription: Reads and searches but cannot exfiltrate\ntools: Read, WebSearch\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.agents.find((a) => a.name === "safe")?.trifecta, null);
  assert.equal(r.trifectaFindings.length, 0);
  cleanupTmpDir(dir);
});

test("trifecta detector is dialect-injected — works under a non-CC layout", () => {
  // The agnostic path: a custom (non-Claude-Code) subagent dir. No CC literal in
  // the detector call; the dialect is threaded through scanPlugin.
  const dir = makeTmpDir("scan-trifecta-agnostic");
  write(
    dir,
    "subagents/wide.md",
    "---\nname: wide\ndescription: A subagent with no tools line under a custom dir\n---\nbody\n",
  );
  const customLayout = {
    ...claudeCodeLayout,
    agentDir: "subagents",
    surfaceDirs: ["subagents"],
    materializeRoot: "",
  };
  const r = scanPlugin(dir, customLayout, claudeCodeDialect);
  assert.equal(
    r.agents.find((a) => a.name === "wide")?.trifecta?.severity,
    "advisory",
  );
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// A contract that does not parse is not a contract (dogfood 2026-08-08)
//
// 🔴 The defect these exist for. The shared frontmatter reader is deliberately
// lenient — on a block js-yaml rejects it regex-salvages the fields, so the live
// PreToolUse rail still has something to enforce. The SCORING path was reading
// that salvage. Measured: `readFrontmatter(bad).malformed` is `true` while
// `frontmatterList(bad, "allowed-tools")` returns the narrow list the author
// MEANT, so a unit whose contract a strict loader rejects was graded as though it
// had declared exactly that list — the Safety ring reading BETTER than the truth,
// in the tool whose thesis is that a declaration present is not a rule enforced.
// ---------------------------------------------------------------------------

// `allowed-tools: [Read, Bash` — an unclosed flow array, the unambiguous
// malformed case the frontmatter-valid docs cite. The salvage yields exactly
// ["Read","Bash"]: private + exfil, no untrusted leg, so it scores CLEAN. A
// strict loader yields nothing at all, which is inherits-all: all three legs.
const UNCLOSED_TOOLS = "[Read, Bash";

test("a skill whose FENCE is in a malformed block is not credited with it", () => {
  const dir = makeTmpDir("scan-malformed-contract-skill");
  // The same defect, retargeted: `disallowed-tools: [WebFetch, WebSearch, Bash` is
  // an unclosed flow array. The lenient salvage yields exactly those three names,
  // which would close two whole legs and score CLEAN — but a strict loader reads no
  // frontmatter at all, so the fence denies nothing. A fence that does not parse is
  // not a fence.
  write(
    dir,
    "skills/broken/SKILL.md",
    `---\nname: broken\ndescription: A model-invocable skill whose frontmatter does not parse\ndisallowed-tools: [WebFetch, WebSearch, Bash\n---\n# broken\n`,
  );
  const r = scanPlugin(dir);
  const skill = r.skills.find((s) => s.name === "broken");
  assert.equal(skill?.trifecta?.severity, "advisory");
  assert.equal(skill?.trifecta?.fence, "none", "a salvaged fence is no fence");
  // …and the finding SAYS why, so the author doesn't read "no disallowed-tools
  // line" on a file that plainly has one.
  assert.match(skill?.trifecta?.message ?? "", /not valid YAML/);
  assert.doesNotMatch(
    skill?.trifecta?.message ?? "",
    /No `disallowed-tools:` line/,
  );
  // The two paths agree: the same file is reported by frontmatter-valid.
  assert.ok(
    r.malformedFrontmatter.some((i) => i.path.includes("skills/broken")),
    "frontmatter-valid reports the same block the scorer refused to trust",
  );
  cleanupTmpDir(dir);
});

test("a subagent whose tools list is MALFORMED gets the same treatment", () => {
  const dir = makeTmpDir("scan-malformed-contract-agent");
  write(
    dir,
    "agents/broken.md",
    `---\nname: broken\ndescription: A subagent whose frontmatter does not parse\ntools: ${UNCLOSED_TOOLS}\n---\nbody\n`,
  );
  const r = scanPlugin(dir);
  const agent = r.agents.find((a) => a.name === "broken");
  assert.equal(agent?.trifecta?.severity, "advisory");
  assert.match(agent?.trifecta?.message ?? "", /not valid YAML/);
  cleanupTmpDir(dir);
});

test("a SALVAGED all-three contract still convicts — the refusal is one-directional", () => {
  // 🔴 The over-reach this pins, caught by the vendored corpus: madappgang's real
  // `tester.md` carries BOTH a malformed description and an explicit
  // all-three-legs tools list. Refusing the salvage outright demoted a genuine
  // hard exfil path to an advisory and deleted its never-available finding. A
  // salvage is too weak to earn a clean bill of health and plenty strong enough
  // to convict, so it may only ever make the verdict worse.
  const dir = makeTmpDir("scan-malformed-contract-hard");
  write(
    dir,
    "agents/leaky.md",
    "---\nname: leaky\ndescription: Broken YAML, and every leg declared: a colon\n  bad: indent\n" +
      "tools: Read, WebSearch, WebFetch, NotARealTool\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  const agent = r.agents.find((a) => a.name === "leaky");
  assert.ok(r.malformedFrontmatter.some((i) => i.path.includes("leaky.md")));
  assert.equal(agent?.trifecta?.severity, "hard", "not demoted to advisory");
  assert.match(agent?.trifecta?.message ?? "", /SALVAGED/);
  // …and the diagnostics built on the same salvage are NOT suppressed: dropping
  // them would delete findings, moving the grade the optimistic way.
  assert.ok(
    agent?.tools?.includes("Read"),
    "the salvaged list is still reported",
  );
  cleanupTmpDir(dir);
});

test("a VALID narrow contract is unaffected — the refusal is scoped to unparseable blocks", () => {
  // Control. The same declarations in a block that PARSES must score clean: for the
  // subagent, Read + Bash is private + exfil with no untrusted leg (Rule of Two);
  // for the skill, a fence that really denies the whole network leg.
  const dir = makeTmpDir("scan-valid-contract-control");
  write(
    dir,
    "skills/fine/SKILL.md",
    "---\nname: fine\ndescription: A model-invocable skill whose frontmatter parses cleanly\ndisallowed-tools: [WebFetch, WebSearch, Bash]\n---\n# fine\n",
  );
  write(
    dir,
    "agents/fine.md",
    "---\nname: fine\ndescription: A subagent whose frontmatter parses cleanly\ntools: [Read, Bash]\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.skills.find((s) => s.name === "fine")?.trifecta, null);
  assert.equal(r.agents.find((a) => a.name === "fine")?.trifecta, null);
  assert.deepEqual(r.agents.find((a) => a.name === "fine")?.tools, [
    "Read",
    "Bash",
  ]);
  assert.equal(r.malformedFrontmatter.length, 0);
  cleanupTmpDir(dir);
});

// ---------------------------------------------------------------------------
// skill-resource-resolves — surfaced through scanPlugin
// ---------------------------------------------------------------------------

test("scanPlugin flags a SKILL.md body referencing a missing bundled resource", () => {
  const dir = makeTmpDir("scan-skill-resource");
  write(
    dir,
    "skills/pdf/SKILL.md",
    "---\nname: pdf\ndescription: Extracts text from a PDF using a bundled script here\n---\n# pdf\n\nRun `scripts/extract.py` to extract the text.\n\nSee [the API](references/api.md) for details.\n",
  );
  // Only scripts/extract.py exists; references/api.md does NOT.
  write(dir, "skills/pdf/scripts/extract.py", "print('hi')\n");
  const r = scanPlugin(dir);
  const pdf = r.skills.find((s) => s.name === "pdf");
  assert.equal(
    pdf?.resourceIssues.length,
    1,
    "only the missing ref is flagged",
  );
  assert.equal(pdf.resourceIssues[0].ref, "references/api.md");
  // The aggregate list + the printed report both carry it.
  const flat = r.skillResourceIssues.find((s) => s.name === "pdf");
  assert.ok(flat);
  assert.equal(flat.finding.ref, "references/api.md");
  assert.match(formatScanReport(r), /Skill bundled resources/);
  assert.match(formatScanReport(r), /pdf: references\/api\.md/);
  cleanupTmpDir(dir);
});

// ─── the printed line must name a line of the FILE, not of the stripped body ──
//
// 🔴 `scanSkills` hands the detector a frontmatter-stripped body, and
// `markdownRefs` counts from one over whatever it is given — so the coordinate
// was short by exactly the frontmatter. Measured before the fix on this very
// fixture: the ref sits on file line 11 and the finding printed 6 (#206). An
// author who opens the printed line finds a blank line and concludes the finding
// is false. The frontmatter here is 5 lines ON PURPOSE, so a dropped offset is a
// 5-line miss, not an off-by-one that could pass unnoticed.
test("skill-resource line number is FILE-relative, not body-relative", () => {
  const dir = makeTmpDir("scan-skill-resource-line");
  const md = [
    "---", // 1
    "name: demo", // 2
    "description: A demo skill that reads a bundled reference before answering", // 3
    "allowed-tools: Read", // 4
    "---", // 5
    "# demo", // 6
    "", // 7
    "Some prose that mentions nothing in particular.", // 8
    "", // 9
    "## Procedure", // 10
    "Read [the API notes](references/api.md) before answering.", // 11
    "",
  ].join("\n");
  write(dir, "skills/demo/SKILL.md", md);

  // The fixture must actually put the ref where the assertion says it does,
  // or the test would pass against a wrong constant.
  assert.equal(
    md.split("\n").findIndex((l) => l.includes("references/api.md")) + 1,
    11,
    "fixture self-check: the broken ref is on file line 11",
  );

  const r = scanPlugin(dir);
  const found = r.skills.find((s) => s.name === "demo")?.resourceIssues ?? [];
  assert.equal(found.length, 1, "the missing bundled resource is flagged");
  assert.equal(found[0].ref, "references/api.md");
  assert.equal(
    found[0].line,
    11,
    "the coordinate names the line of the SKILL.md, not of the stripped body",
  );
  cleanupTmpDir(dir);
});

test("skill-resource is FP-safe: URLs and $VAR tokens are not flagged", () => {
  const dir = makeTmpDir("scan-skill-resource-fp");
  write(
    dir,
    "skills/web/SKILL.md",
    "---\nname: web\ndescription: A skill that links out to docs and runtime paths here\n---\n# web\n\nSee [docs](https://example.test/api.md) and `${CLAUDE_PLUGIN_ROOT}/x.sh` and `../sibling/y.sh`.\n",
  );
  const r = scanPlugin(dir);
  assert.equal(
    r.skills.find((s) => s.name === "web")?.resourceIssues.length,
    0,
  );
  assert.equal(r.skillResourceIssues.length, 0);
  cleanupTmpDir(dir);
});

// ─── the surface walk must not follow a directory symlink ─────────────────────
//
// 🔴 The walk `statSync`'d every entry, which FOLLOWS the link. A surface dir
// holding a link back to an ancestor is a CYCLE, and the recursion rides it until
// the path length or the fd limit stops it; a link to a big external tree makes an
// advisory scan crawl outside the checkout. Both are silent while they burn.
//
// Both halves: the cycle TERMINATES and reports the real file, and an ordinary
// nested dir under the same surface is still walked (a fix that simply stopped
// descending would pass the first assertion alone).
test("a directory symlink is not descended into, so a cycle cannot hang the scan", () => {
  const dir = makeTmpDir("scan-symlink-cycle");
  write(
    dir,
    ".claude/skills/loop/SKILL.md",
    "---\nname: loop\ndescription: A skill whose folder links back to its own parent\n---\n# loop\n",
  );
  // The file the walk MUST still find — a genuine finding, so the assertion below
  // proves the walk ran rather than bailed out.
  write(
    dir,
    ".claude/skills/loop/loop.test.mjs",
    'import { paid_runEval } from "vigiles/eval";\nawait paid_runEval({});\n',
  );
  // …and an ordinary nested dir, to pin that descent still happens at all.
  write(
    dir,
    ".claude/skills/loop/nested/deep.test.mjs",
    'import { paid_runEval } from "vigiles/eval";\nawait paid_runEval({});\n',
  );
  // `.claude/skills/loop/self` → `.claude/skills` : an ancestor, so following it
  // re-enters `loop/` forever.
  symlinkSync(
    join(dir, ".claude", "skills"),
    join(dir, ".claude", "skills", "loop", "self"),
    "dir",
  );

  const started = Date.now();
  // TWO walks used to cross this fixture and each rode the cycle on its own: the
  // loader's `readTree` (which THREW `ELOOP` out of the entire audit) and
  // `harnessSurfaceFilesOnDisk` (which multiplied every path by every lap). The
  // second walk was deleted 2026-08-12 with the foreign-runner warning it fed
  // (tombstone in `core/foreign-runner.ts`), so only the loader crosses it now —
  // and the loader's copy of the property is asserted directly at the bottom of
  // this test. The no-throw stays separate from the paths, so reverting the fix
  // fails on a named assertion rather than on a stray exception.
  let report: ReturnType<typeof scanPlugin> | null = null;
  let thrown = "";
  try {
    report = scanPlugin(dir);
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  assert.equal(
    thrown,
    "",
    "scanPlugin must not throw on a cyclic surface dir (the loader used to raise ELOOP)",
  );
  assert.ok(report);
  assert.ok(
    Date.now() - started < 20000,
    "the scan must terminate rather than ride the cycle",
  );
  // ⚠️ A "no path repeats through `self/`" assertion stood here, observed through
  // the foreign-runner warnings. Those are gone, and it is removed rather than
  // rewritten because the LOADER assertion below pins the identical property over
  // the identical three files — keeping a second copy against a deleted feature
  // would have meant asserting on an observable that can no longer change.
  //
  // …the LOADER's own walk. Catching the `ELOOP` would already
  // stop the throw while still reading the tree once per lap — measured on this
  // fixture: 82 file keys (40 laps of `self/loop/self/…`) instead of 3. That is
  // the input the whole report is computed from, so it is asserted directly
  // rather than through a symptom.
  assert.deepEqual(
    Object.keys(loadPlugin(dir).files).sort(),
    [
      ".claude/skills/loop/SKILL.md",
      ".claude/skills/loop/loop.test.mjs",
      ".claude/skills/loop/nested/deep.test.mjs",
    ],
    "the loader must read each real file once, not once per lap of the cycle",
  );
  cleanupTmpDir(dir);
});

// ─── …and the walk's ENTRY POINT is classified too ────────────────────────────
//
// 🔴 The policy above was applied to every entry INSIDE a walk and to no walk's
// root. Both walks hand a top-level surface dir straight to `readdirSync`, which
// FOLLOWS a link — so `.claude/skills -> <repo>` re-entered the whole checkout
// through a door the layout never opened, and the containment both walks promise
// ("only the surface dirs are walked, so the rest of the repo and any
// node_modules beside it is never entered") held everywhere except at the top.
//
// A root is judged by a DIFFERENT rule from an inner entry, on purpose: refusing
// every symlinked root would report zero skills for the ordinary layout in the
// second test below. See `walkableRoot` in src/fs-walk.ts.
test("a surface ROOT that links back over the repo is refused, so the walk stays inside", () => {
  const dir = makeTmpDir("scan-symlink-root");
  // The tree the walk must NOT swallow: a foreign-runner finding and a file the
  // loader would otherwise read into the map the whole report is computed from.
  write(
    dir,
    "node_modules/junk/planted.test.mjs",
    'import { paid_runEval } from "vigiles/eval";\nawait paid_runEval({});\n',
  );
  write(dir, "unrelated/notes.md", "# not a surface\n");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  // BOTH root shapes point back at the repo: the user form (`.claude/skills`) and
  // the plugin form (`skills`). Between them they are the entry point of every
  // walk in the codebase — `harnessSurfaceFilesOnDisk`, the loader's root-surface
  // pass, its user-surface pass, and `executableSources` (which feeds
  // `danglingRefs`) — and each was reached through `readdirSync` unclassified.
  symlinkSync(join(dir), join(dir, ".claude", "skills"), "dir");
  symlinkSync(join(dir), join(dir, "skills"), "dir");

  const r = scanPlugin(dir);
  assert.deepEqual(
    r.warnings.filter((w) => w.includes("planted.test.mjs")),
    [],
    "a file under node_modules is not harness surface, whatever a root link says",
  );
  assert.deepEqual(
    Object.keys(loadPlugin(dir).files).filter(
      (k) => k.includes("node_modules") || k.includes("unrelated"),
    ),
    [],
    "the loader must not read the whole checkout in through a symlinked root",
  );
  cleanupTmpDir(dir);
});

test("…but a shared skills directory linked in from OUTSIDE is still read", () => {
  // The QUIET half, and the reason the root rule is not the entry rule. One
  // skills folder linked into several checkouts is an ordinary setup; a blanket
  // refusal would pass the test above while silently reporting ZERO skills here,
  // which is a worse failure than the one being fixed.
  const dir = makeTmpDir("scan-symlink-root-ok");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  write(
    dir,
    "shared/linked/SKILL.md",
    "---\nname: linked\ndescription: A shared skill linked into several checkouts at once\n---\n# linked\n",
  );
  symlinkSync(join(dir, "shared"), join(repo, ".claude", "skills"), "dir");

  const r = scanPlugin(repo);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["linked"],
    "a symlinked surface root is the layout naming where the skills live",
  );
  cleanupTmpDir(dir);
});

test("…but a symlink to a FILE is still collected — it cannot recurse", () => {
  // The QUIET half of the same fix: refusing DESCENT must not quietly drop links
  // to files. A directory link can loop; a file link cannot, so it is read.
  //
  // ⚠️ THIS USED TO ASSERT ON THE FOREIGN-RUNNER WARNING, which was deleted
  // 2026-08-12 (tombstone in `core/foreign-runner.ts`). The property it pins is
  // NOT the warning though — it is `entryOf`'s rule in `fs-walk.ts`, which the
  // loader still uses to build the file map the whole report is computed from.
  // So the assertion moves to the loader rather than the test being dropped:
  // deleting a feature must not silently take a live invariant's only test with
  // it.
  const dir = makeTmpDir("scan-symlink-file");
  write(
    dir,
    "real/driver.test.mjs",
    'import { paid_runEval } from "vigiles/eval";\nawait paid_runEval({});\n',
  );
  mkdirSync(join(dir, ".claude", "skills", "s"), { recursive: true });
  write(
    dir,
    ".claude/skills/s/SKILL.md",
    "---\nname: s\ndescription: A skill whose harness test is a symlink to a real file\n---\n# s\n",
  );
  symlinkSync(
    join(dir, "real", "driver.test.mjs"),
    join(dir, ".claude", "skills", "s", "linked.test.mjs"),
    "file",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(
      loadPlugin(dir).files,
      ".claude/skills/s/linked.test.mjs",
    ),
    "a symlinked FILE under a surface dir is still read into the file map",
  );
  // And the skill beside it is still found, so the walk did not bail at the link.
  assert.deepEqual(
    scanPlugin(dir).skills.map((x) => x.name),
    ["s"],
  );
  cleanupTmpDir(dir);
});

// ─── a skill fence is only offered where the harness has one ──────────────────
//
// 🔴 End-to-end half of the `skillTrifectaIssue` dialect gate. The unit test pins
// the detector; this pins what the AUDIT does with it, which is where the cost
// was: a Codex repo's skills were reported, SCORED against Safety, and handed a
// `disallowed-tools:` remedy that Codex does not read — so the number could not be
// improved by doing the work.
/** The Safety ring's score, or `null` when the report has nothing to assess. */
function safetyScore(r: ReturnType<typeof scanPlugin>): number | null {
  const c = auditScore(r).categories.find((x) => x.key === "Safety");
  if (!c) throw new Error("no Safety ring");
  return c.score;
}

test("a Codex repo is not scored against a fence its harness has no key for", () => {
  const dir = makeTmpDir("scan-codex-fence");
  write(dir, "AGENTS.md", "# rules\n");
  write(dir, ".codex/config.toml", "[mcp_servers]\n");
  write(
    dir,
    "skills/deploy/SKILL.md",
    "---\nname: deploy\ndescription: Ships the built artifact to production for the team\n---\n# deploy\n",
  );
  const r = scanPlugin(dir, codexLayout, codexDialect);
  assert.equal(r.skills.length, 1, "precondition: the skill IS discovered");
  assert.equal(r.skills[0].trifecta, null);
  assert.deepEqual(
    r.trifectaFindings.filter((f) => f.kind === "skill"),
    [],
  );
  // With no finding left, this harness has no exposed unit — the ring is a clean
  // 100 rather than a floor the author cannot leave.
  assert.equal(
    safetyScore(r),
    100,
    "a remedy the harness cannot apply must not hold the score down",
  );
  cleanupTmpDir(dir);
});

test("…while the same skill under Claude Code is still reported and still scored", () => {
  // The QUIET half: the gate must not have deleted the headline Safety detector.
  const dir = makeTmpDir("scan-cc-fence");
  write(
    dir,
    "skills/deploy/SKILL.md",
    "---\nname: deploy\ndescription: Ships the built artifact to production for the team\n---\n# deploy\n",
  );
  const r = scanPlugin(dir);
  assert.equal(r.skills[0]?.trifecta?.fence, "none");
  assert.equal(r.trifectaFindings.filter((f) => f.kind === "skill").length, 1);
  assert.ok(
    (safetyScore(r) ?? 100) < 100,
    "an unfenced Claude Code skill still costs Safety",
  );
  cleanupTmpDir(dir);
});

test("advisory vocabulary notes REACH the report (computed-then-dropped guard)", () => {
  // The first cut of this feature classified names correctly and then threw the
  // advisory half away, because `scan` stored only the scored issues. The
  // detector tests all passed and `OnFileSave` was still silent in the output —
  // so this asserts the WIRING, not the classification.
  const dir = makeTmpDir("scan-vocab-notes");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "x",
      hooks: {
        OnFileSave: [{ hooks: [{ type: "command", command: "echo a" }] }],
      },
    }),
  );
  write(
    dir,
    "agents/p.md",
    "---\nname: p\ndescription: Probe agent\ntools: Agent, NotARealTool\n---\nbody\n",
  );
  const r = scanPlugin(dir);

  const notes = r.vocabularyNotes ?? [];
  assert.equal(
    notes.length,
    3,
    "one unknown event + one conditional + one unknown tool",
  );
  assert.ok(notes.some((n) => /OnFileSave/.test(n.message)));
  assert.ok(notes.some((n) => /^Agent is a real tool/.test(n.message)));
  assert.ok(notes.some((n) => /NotARealTool/.test(n.message)));

  // …and they must be visible in the rendered report, not just on the object.
  const text = formatScanReport(r);
  assert.match(text, /Vocabulary notes \(advisory, not graded\)/);
  assert.match(text, /OnFileSave/);
  assert.match(text, /vigiles is out of date — not your config/);

  // …while contributing NOTHING to the graded findings.
  assert.deepEqual(r.hookEventIssues, []);
  assert.deepEqual(r.agents.find((a) => a.name === "p")?.toolIssues, []);
  cleanupTmpDir(dir);
});

test("a clean plugin produces NO vocabulary notes (the silent half)", () => {
  const dir = makeTmpDir("scan-vocab-clean");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "x",
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo a" }] }],
      },
    }),
  );
  write(
    dir,
    "agents/p.md",
    "---\nname: p\ndescription: Probe agent\ntools: Read, Grep\n---\nbody\n",
  );
  const r = scanPlugin(dir);
  assert.deepEqual(r.vocabularyNotes, []);
  assert.doesNotMatch(formatScanReport(r), /Vocabulary notes/);
  cleanupTmpDir(dir);
});

test("conditional tool notes are GROUPED by condition, not repeated per tool", () => {
  // A delegating subagent legitimately declares many foreground-only tools.
  // Eight identical paragraphs is noise from a tool whose pitch is precision —
  // this is the Citadel shape, where ungrouped output was 8 lines per agent.
  const dir = makeTmpDir("scan-vocab-group");
  write(
    dir,
    "agents/orch.md",
    "---\nname: orch\ndescription: Orchestrator subagent\n" +
      "tools: Read, Agent, CronCreate, CronDelete, CronList, TaskCreate, TaskList\n---\nbody\n",
  );
  const notes = scanPlugin(dir).vocabularyNotes ?? [];
  // 6 conditional tools across 3 distinct conditions + Agent's own = 3 lines.
  assert.equal(notes.length, 3, notes.map((n) => n.message).join("\n"));
  assert.ok(
    notes.some((n) =>
      /CronCreate, CronDelete, CronList are real tools/.test(n.message),
    ),
  );
  assert.ok(notes.some((n) => /^Agent is a real tool/.test(n.message)));
  // every declared conditional tool is still named somewhere — grouping must
  // compress the prose, never drop a tool.
  const all = notes.map((n) => n.message).join(" ");
  for (const t of [
    "Agent",
    "CronCreate",
    "CronDelete",
    "CronList",
    "TaskCreate",
    "TaskList",
  ])
    assert.match(all, new RegExp(`\\b${t}\\b`));
  cleanupTmpDir(dir);
});
