/**
 * Tests for the plugin/repo harness loader (src/plugin-loader.ts) — loads the
 * real assembled machine (hooks + CLAUDE.md + skills) so a test/eval runs
 * against what ships, not a retyped subset. Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

import { loadPlugin, resolveHarness } from "./plugin-loader.js";
import { claudeCodeLayout } from "./layout.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

function makePlugin(): string {
  const root = makeTmpDir("plugin");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "demo",
      skills: "./skills/",
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
              },
            ],
          },
        ],
      },
    }),
  );
  writeFileSync(join(root, "CLAUDE.md"), "# demo project\n");
  mkdirSync(join(root, "skills", "foo"), { recursive: true });
  writeFileSync(join(root, "skills", "foo", "SKILL.md"), "# foo skill\n");
  return root;
}

test("loadPlugin resolves CLAUDE_PLUGIN_ROOT to the absolute plugin path", () => {
  const root = makePlugin();
  try {
    const loaded = loadPlugin(root);
    const json = JSON.stringify(loaded.settings);
    assert.ok(!json.includes("${CLAUDE_PLUGIN_ROOT}"), "token not expanded");
    assert.ok(
      json.includes(`${root}/hooks/session-start.sh`),
      "abs path present",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin warns on dangling intra-plugin file references", () => {
  const root = makeTmpDir("plugin-dangling");
  try {
    // a hook script that reads one skill that exists and one that doesn't
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks", "session-start"),
      // the missing ref appears twice → exercises the dedup (seen) path
      'cat "$ROOT/skills/present/SKILL.md"\ncat "$ROOT/skills/missing/SKILL.md"\necho "$ROOT/skills/missing/SKILL.md"\n',
    );
    mkdirSync(join(root, "skills", "present"), { recursive: true });
    writeFileSync(join(root, "skills", "present", "SKILL.md"), "# present\n");

    const { warnings } = loadPlugin(root);
    const dangling = warnings.find((w) => w.includes("intra-plugin"));
    assert.ok(dangling, "expected a dangling-ref warning");
    assert.ok(
      dangling.includes("skills/missing/SKILL.md"),
      "names the missing ref",
    );
    assert.ok(
      !dangling.includes("skills/present/SKILL.md"),
      "ignores the present ref",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin does NOT flag a project-rooted ref as dangling (only plugin-rooted)", () => {
  const root = makeTmpDir("plugin-projref");
  try {
    mkdirSync(join(root, "hooks"), { recursive: true });
    // A smoke-test script (gmickel/flow-next shape) referencing the PROJECT's
    // .claude/hooks and $CLAUDE_PROJECT_DIR — runtime paths, NOT plugin files —
    // plus a genuine plugin-rooted missing ref that MUST still be caught.
    writeFileSync(
      join(root, "hooks", "setup"),
      [
        'cat "$CLAUDE_PROJECT_DIR/.claude/hooks/ralph-guard.py"', // project var → skip
        "run .claude/hooks/other.py", // literal nested dir → skip
        'cat "$ROOT/skills/real-missing/SKILL.md"', // plugin-rooted → flag
      ].join("\n"),
    );
    const { warnings } = loadPlugin(root);
    const dangling = warnings.find((w) => w.includes("intra-plugin")) ?? "";
    assert.ok(
      !dangling.includes("ralph-guard.py") && !dangling.includes("other.py"),
      "project-rooted / literal-nested refs are not plugin files",
    );
    assert.ok(
      dangling.includes("skills/real-missing/SKILL.md"),
      "a genuine plugin-rooted missing ref is still flagged",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin does not read a `#`-comment usage example as a dangling ref (issue #110)", () => {
  const root = makeTmpDir("plugin-comment-echo");
  try {
    const name = basename(root);
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "setup.sh"), "echo installed\n");
    // A usage comment written as it would be invoked from the REPO CHECKOUT
    // root — echoes the plugin's own dir name ahead of the real plugin-relative
    // path. Full-line `#` comment (incl. shebang) — must be scanned as prose,
    // not code, in a .sh script.
    writeFileSync(
      join(root, "hooks", "print-usage.sh"),
      [
        "#!/usr/bin/env bash",
        `# Usage: bash skills/${name}/hooks/setup.sh`,
        "echo done",
      ].join("\n"),
    );
    const { warnings } = loadPlugin(root);
    assert.ok(
      !warnings.some((w) => w.includes("intra-plugin")),
      "a usage comment must not be read as a real dangling ref",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin resolves a repo-checkout-relative echo of the plugin's own dir name on a non-comment line (issue #110)", () => {
  const root = makeTmpDir("plugin-echo-path");
  try {
    const name = basename(root);
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "setup.sh"), "echo installed\n");
    // A REAL (non-comment) code line that names the ref using the
    // repo-checkout path — the plugin's own dir name echoed ahead of the
    // plugin-relative path, e.g. an install summary a script prints.
    writeFileSync(
      join(root, "hooks", "print-usage.sh"),
      `echo "run: bash skills/${name}/hooks/setup.sh"\n`,
    );
    const { warnings } = loadPlugin(root);
    assert.ok(
      !warnings.some((w) => w.includes("intra-plugin")),
      "the repo-root echo of the plugin's own dir name must resolve, not double-root",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin still flags a genuinely missing ref shaped like a repo-root echo (issue #110 — no under-detection)", () => {
  const root = makeTmpDir("plugin-echo-missing");
  try {
    const name = basename(root);
    mkdirSync(join(root, "hooks"), { recursive: true });
    // No `hooks/really-missing.sh` on disk — the echo fallback must NOT mask
    // a genuinely broken ref just because it echoes the plugin's own name.
    writeFileSync(
      join(root, "hooks", "print-usage.sh"),
      `echo "run: bash skills/${name}/hooks/really-missing.sh"\n`,
    );
    const { warnings } = loadPlugin(root);
    const dangling = warnings.find((w) => w.includes("intra-plugin"));
    assert.ok(
      dangling,
      "expected the genuinely missing ref to still be flagged",
    );
    assert.ok(
      dangling?.includes(`skills/${name}/hooks/really-missing.sh`),
      "names the missing ref",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin: comment-stripping in a .sh script still flags a genuine missing ref on a real code line (issue #110)", () => {
  const root = makeTmpDir("plugin-comment-mixed");
  try {
    const name = basename(root);
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks", "setup.sh"),
      [
        "#!/usr/bin/env bash",
        `# Usage: bash skills/${name}/hooks/setup.sh`, // comment — must be ignored
        'cat "skills/real-missing/SKILL.md"', // real code line — must still flag
      ].join("\n"),
    );
    const { warnings } = loadPlugin(root);
    const dangling = warnings.find((w) => w.includes("intra-plugin")) ?? "";
    assert.ok(
      dangling.includes("skills/real-missing/SKILL.md"),
      "a genuine broken ref on a real code line must still be caught",
    );
    assert.ok(
      !dangling.includes(`skills/${name}/hooks/setup.sh`),
      "the usage-comment example must not appear",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin: a complete plugin has no dangling-ref warning", () => {
  const root = makePlugin(); // skills/foo/SKILL.md exists, no broken refs
  try {
    const { warnings } = loadPlugin(root);
    assert.ok(!warnings.some((w) => w.includes("intra-plugin")));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin materializes CLAUDE.md and skills into the sandbox", () => {
  const root = makePlugin();
  try {
    const { files } = loadPlugin(root);
    assert.equal(files["CLAUDE.md"], "# demo project\n");
    assert.equal(
      files[join(".claude", "skills", "foo", "SKILL.md")],
      "# foo skill\n",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("resolveHarness layers inline settings/files over the plugin", () => {
  const root = makePlugin();
  try {
    const { settings, files } = resolveHarness({
      plugin: root,
      settings: {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo extra" }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: "exit 0" }] }],
        },
      },
      files: { "extra.txt": "x" },
    });
    const s = settings as { hooks: Record<string, unknown[]> };
    // plugin SessionStart + inline SessionStart are concatenated
    assert.equal(s.hooks.SessionStart.length, 2);
    // inline-only event is present
    assert.equal(s.hooks.Stop.length, 1);
    // plugin files + inline files both present
    assert.equal(files["CLAUDE.md"], "# demo project\n");
    assert.equal(files["extra.txt"], "x");
  } finally {
    cleanupTmpDir(root);
  }
});

test("resolveHarness with no plugin and no settings yields undefined settings", () => {
  const r = resolveHarness({});
  assert.equal(r.settings, undefined);
  assert.deepEqual(r.files, {});
});

test("resolveHarness passes inline settings through when no plugin", () => {
  const inline = { hooks: { Stop: [{ hooks: [] }] } };
  const r = resolveHarness({ settings: inline });
  assert.deepEqual(r.settings, inline);
});

test("loadPlugin reads a plain repo's .claude/settings.json (no plugin manifest)", () => {
  const root = makeTmpDir("repo");
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "exit 0" }],
            },
          ],
        },
      }),
    );
    const loaded = loadPlugin(root);
    const s = loaded.settings as { hooks?: Record<string, unknown[]> };
    assert.equal(s.hooks?.PreToolUse?.length, 1);
  } finally {
    cleanupTmpDir(root);
  }
});

test("the plugin manifest wins when both it and .claude/settings.json exist", () => {
  const root = makeTmpDir("both");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo manifest" }] }],
        },
      }),
    );
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo settings" }] }],
        },
      }),
    );
    const loaded = loadPlugin(root);
    assert.ok(JSON.stringify(loaded.settings).includes("manifest"));
    assert.ok(!JSON.stringify(loaded.settings).includes("settings"));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin reads the hooks/hooks.json convention (e.g. obra/superpowers)", () => {
  const root = makeTmpDir("conv");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    // plugin.json with NO inline hooks — hooks live in hooks/hooks.json
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "conv" }),
    );
    writeFileSync(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh",
                },
              ],
            },
          ],
        },
      }),
    );
    const loaded = loadPlugin(root);
    const s = loaded.settings as { hooks?: Record<string, unknown[]> };
    assert.equal(s.hooks?.SessionStart?.length, 1);
    assert.ok(JSON.stringify(s).includes(`${root}/hooks/run.sh`));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin follows a `hooks` string path in plugin.json", () => {
  const root = makeTmpDir("hookspath");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", hooks: "./hooks/custom.json" }),
    );
    writeFileSync(
      join(root, "hooks", "custom.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "exit 0" }] }] },
      }),
    );
    const loaded = loadPlugin(root);
    const s = loaded.settings as { hooks?: Record<string, unknown[]> };
    assert.equal(s.hooks?.Stop?.length, 1);
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin on a bare dir (CLAUDE.md only, no hooks) yields empty settings", () => {
  const root = makeTmpDir("bare");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# bare\n");
    const loaded = loadPlugin(root);
    assert.deepEqual(loaded.settings, {});
    assert.equal(loaded.files["CLAUDE.md"], "# bare\n");
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin materializes agents/ and commands/ and warns they need a model", () => {
  // The wshobson/agents shape: a plugin built from subagents + slash commands,
  // no hooks. Before this, the loader dropped both and could return an empty
  // machine; now they're materialized and flagged for the eval tier.
  const root = makeTmpDir("agentplugin");
  try {
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "agents", "reviewer.md"), "# reviewer agent\n");
    writeFileSync(join(root, "commands", "tdd.md"), "# /tdd command\n");
    const loaded = loadPlugin(root);
    assert.equal(
      loaded.files[join(".claude", "agents", "reviewer.md")],
      "# reviewer agent\n",
    );
    assert.equal(
      loaded.files[join(".claude", "commands", "tdd.md")],
      "# /tdd command\n",
    );
    const w = loaded.warnings.join("\n");
    assert.ok(w.includes("subagent"), "warns about subagents");
    assert.ok(w.includes("slash-command"), "warns about commands");
    // not the empty-machine warning — files were loaded
    assert.ok(!w.includes("nothing was loaded"));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin warns on an effectively empty plugin (no hooks, no files)", () => {
  const root = makeTmpDir("emptyplugin");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "empty" }),
    );
    const loaded = loadPlugin(root);
    assert.ok(loaded.warnings.some((w) => w.includes("nothing was loaded")));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin warns when a plugin declares MCP servers", () => {
  const root = makeTmpDir("mcpplugin");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# x\n");
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "x" } } }),
    );
    const loaded = loadPlugin(root);
    assert.ok(loaded.warnings.some((w) => w.includes("MCP")));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin warns when the manifest declares mcpServers (no .mcp.json)", () => {
  const root = makeTmpDir("mcpmanifest");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# x\n");
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "m", mcpServers: { demo: { command: "x" } } }),
    );
    assert.ok(loadPlugin(root).warnings.some((w) => w.includes("MCP")));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin tolerates a malformed plugin.json (does not crash)", () => {
  const root = makeTmpDir("badmanifest");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# x\n");
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), "{ not json");
    const loaded = loadPlugin(root);
    // malformed manifest → no hooks, no MCP warning; CLAUDE.md still loads.
    assert.deepEqual(loaded.settings, {});
    assert.ok(!loaded.warnings.some((w) => w.includes("MCP")));
    assert.equal(loaded.files["CLAUDE.md"], "# x\n");
  } finally {
    cleanupTmpDir(root);
  }
});

test("a fully-covered plugin (hooks + CLAUDE.md + skills) has no warnings", () => {
  const root = makePlugin();
  try {
    assert.deepEqual(loadPlugin(root).warnings, []);
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin loads an end-user repo's .claude/skills (no plugin.json)", () => {
  // The MAJORITY shape: a plain Claude Code user, skills under `.claude/skills/`,
  // not a published plugin. Before this the loader saw an empty machine here.
  const root = makeTmpDir("userrepo");
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# my project\n");
    mkdirSync(join(root, ".claude", "skills", "rca"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "rca", "SKILL.md"),
      "---\nname: rca\ndescription: Investigate an incident\n---\n# rca\n",
    );
    const loaded = loadPlugin(root);
    // materialized under the SAME canonical key as a repo-root skill would be
    const key = join(".claude", "skills", "rca", "SKILL.md");
    assert.ok(loaded.files[key], "the .claude/skills skill is loaded");
    // real on-disk source recorded (the file lives UNDER .claude/, not repo root)
    assert.equal(
      loaded.sources[key],
      join(root, ".claude", "skills", "rca", "SKILL.md"),
    );
    // not an empty machine
    assert.ok(!loaded.warnings.some((w) => w.includes("nothing was loaded")));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin reads BOTH a repo-root skills/ and .claude/skills when both exist", () => {
  // Claude Code loads both — the plugin copy as `/<plugin>:<name>`, the project
  // copy as `/<name>` (docs: "loads alongside"). The loader used to read one and
  // materialize it under the OTHER's canonical key, so a real file was never
  // opened and its name carried someone else's bytes.
  const root = makeTmpDir("bothshapes");
  try {
    mkdirSync(join(root, "skills", "lib-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "lib-skill", "SKILL.md"), "# lib\n");
    mkdirSync(join(root, ".claude", "skills", "user-skill"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".claude", "skills", "user-skill", "SKILL.md"),
      "# user\n",
    );
    const { files, sources } = loadPlugin(root);
    assert.equal(
      files["skills/lib-skill/SKILL.md"],
      "# lib\n",
      "the plugin-scope skill is loaded, keyed where it really lives",
    );
    assert.equal(
      files[join(".claude", "skills", "user-skill", "SKILL.md")],
      "# user\n",
      "the project-scope skill is loaded too — no longer shadowed",
    );
    assert.equal(
      sources["skills/lib-skill/SKILL.md"],
      join(root, "skills", "lib-skill", "SKILL.md"),
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin: a name in BOTH scopes yields two surfaces, neither overwritten", () => {
  // The measured case (nyldn/claude-octopus, 2026-08-18): 50 skill names live in
  // both `skills/` and `.claude/skills/`, and all 50 pairs DIFFER. Under the old
  // one-or-the-other rule the audit named all fifty and had opened none of them.
  const root = makeTmpDir("dupname");
  try {
    mkdirSync(join(root, "skills", "dup"), { recursive: true });
    writeFileSync(join(root, "skills", "dup", "SKILL.md"), "# plugin copy\n");
    mkdirSync(join(root, ".claude", "skills", "dup"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "dup", "SKILL.md"),
      "# project copy\n",
    );
    const { files, sources, warnings } = loadPlugin(root);
    assert.equal(files["skills/dup/SKILL.md"], "# plugin copy\n");
    assert.equal(
      files[join(".claude", "skills", "dup", "SKILL.md")],
      "# project copy\n",
    );
    // Every key names the file it was actually read from — the property whose
    // absence was the whole defect.
    for (const [key, onDisk] of Object.entries(sources)) {
      assert.equal(
        readFileSync(onDisk, "utf-8"),
        files[key],
        `sources[${key}] must be the file the content came from`,
      );
    }
    assert.ok(
      warnings.some((w) => w.includes("TWO discovery levels")),
      "a two-scope repo is called out, not silently merged",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin THROWS on a layout whose scopes would collide, rather than dropping one", () => {
  // The call-site half of `assertDistinctScopeKeys`: the unit test proves the
  // function fires, this proves the loader actually calls it. A layout with an
  // empty `materializeRoot` makes the project and plugin scopes mint the same
  // prefix — the exact silent overwrite this whole change removed. No shipped
  // layout can reach it, so without this the call could be deleted unnoticed.
  const root = makeTmpDir("collide-layout");
  try {
    mkdirSync(join(root, "skills", "a"), { recursive: true });
    writeFileSync(join(root, "skills", "a", "SKILL.md"), "# a\n");
    mkdirSync(join(root, ".claude", "skills", "b"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "b", "SKILL.md"), "# b\n");
    assert.throws(
      // Was `{ ...claudeCodeLayout, materializeRoot: "" }` — a layout whose
      // materialize root disagreed with its `userSurfaceRoot`. That state has
      // no field to live in any more; `userSurfaceRoot: ""` is the remaining
      // way to make both scopes mint the same prefix (present, so the project
      // scope exists; empty, so it does not relocate).
      () => loadPlugin(root, { ...claudeCodeLayout, userSurfaceRoot: "" }),
      /silently shadow/,
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin loads a single skill directory (SKILL.md at the target root)", () => {
  // Pointing `audit`/`test` at ONE skill dir — the natural thing to do — used to
  // yield "no loadable surface". Now it materializes as a skill named by the dir.
  const root = makeTmpDir("one-skill");
  try {
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: solo\ndescription: A solo skill\n---\n# solo\n",
    );
    const loaded = loadPlugin(root);
    const key = join(".claude", "skills", basename(root), "SKILL.md");
    assert.ok(
      loaded.files[key],
      "the sole SKILL.md is materialized as a skill",
    );
    assert.equal(loaded.sources[key], join(root, "SKILL.md"));
    assert.ok(!loaded.warnings.some((w) => w.includes("nothing was loaded")));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin reads the in-repo vigiles plugin (dogfood)", () => {
  // The repo's own .claude-plugin/plugin.json — proves the loader parses the
  // real shipped manifest, not just a fixture.
  const loaded = loadPlugin(process.cwd());
  const s = loaded.settings as { hooks?: Record<string, unknown[]> };
  assert.ok(s.hooks, "vigiles plugin has hooks");
  assert.ok(
    !JSON.stringify(s).includes("${CLAUDE_PLUGIN_ROOT}"),
    "token expanded",
  );
  assert.ok(typeof loaded.files["CLAUDE.md"] === "string", "CLAUDE.md loaded");
});

test("loadPlugin materializes a single skill dir's WHOLE subtree (bundled resources)", () => {
  // Pointing at one skill dir must ship its bundled resources too, not just
  // SKILL.md — else a single-skill harness test/eval runs against a harness
  // missing the skill's own scripts/references.
  const root = makeTmpDir("solo-skill");
  try {
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: solo\ndescription: a solo skill\n---\nRun scripts/run.sh\n",
    );
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "run.sh"), "#!/usr/bin/env bash\n");
    const { files, sources } = loadPlugin(root);
    const name = basename(root);
    const skillKey = join(".claude", "skills", name, "SKILL.md");
    const resKey = join(".claude", "skills", name, "scripts", "run.sh");
    assert.ok(files[skillKey], "SKILL.md materialized");
    assert.ok(files[resKey], "bundled script materialized (not just SKILL.md)");
    assert.equal(sources[resKey], join(root, "scripts", "run.sh"));
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin falls back to .claude/skills when the root skills/ is EMPTY", () => {
  // An empty (or unrelated) root `skills/` must NOT shadow real `.claude/skills`
  // — else a plain user repo is reported empty (the F/0 this change fixes).
  const root = makeTmpDir("empty-root-skills");
  try {
    mkdirSync(join(root, "skills"), { recursive: true }); // present but EMPTY
    mkdirSync(join(root, ".claude", "skills", "rca"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "rca", "SKILL.md"),
      "---\nname: rca\ndescription: a real user skill\n---\nbody\n",
    );
    const { files } = loadPlugin(root);
    assert.ok(
      files[join(".claude", "skills", "rca", "SKILL.md")],
      "the real .claude/skills skill is read despite an empty root skills/",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin materializes a plugin's project-local .claude/agents too", () => {
  // A repo with a shipped root `skills/` AND a local `.claude/agents` runs BOTH
  // in a real session: the subagent under `.claude/agents` is dispatchable by
  // name. Dropping it audited a machine the author never runs.
  const root = makeTmpDir("plugin-devagents");
  try {
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    writeFileSync(
      join(root, "skills", "foo", "SKILL.md"),
      "---\nname: foo\ndescription: a shipped skill\n---\nbody\n",
    );
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "agents", "dev.md"),
      "---\nname: dev\ndescription: a local dev agent\n---\nbody\n",
    );
    const { files } = loadPlugin(root);
    assert.ok(
      files["skills/foo/SKILL.md"],
      "the shipped root skill is loaded, keyed where it lives",
    );
    assert.ok(
      files[join(".claude", "agents", "dev.md")],
      "the project-local .claude/agents subagent is materialized too",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin reads .claude/skills for a manifest-backed (hook-only) plugin", () => {
  // A hook-only plugin has a manifest + hooks but no root surface dirs. Its
  // project-local `.claude/skills` is still a real project skill that loads in a
  // session, so it is read — and since the root scope contributes no surface
  // files, nothing competes for the canonical key.
  const root = makeTmpDir("hookonly-plugin");
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "hookonly",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "exit 0" }] }] },
      }),
    );
    mkdirSync(join(root, ".claude", "skills", "dev"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "dev", "SKILL.md"),
      "---\nname: dev\ndescription: a local dev skill\n---\nbody\n",
    );
    const { files } = loadPlugin(root);
    assert.ok(
      files[join(".claude", "skills", "dev", "SKILL.md")],
      "a manifest-backed plugin's project-local .claude/skills IS materialized",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin reads .claude/skills for a hooks/hooks.json convention plugin", () => {
  // A hook-only plugin via the `hooks/hooks.json` convention (no manifest, no root
  // surfaces) is still a plugin — and its project-local `.claude/skills` is still
  // a project skill the session loads.
  const root = makeTmpDir("hooksconv-plugin");
  try {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "exit 0" }] }] },
      }),
    );
    mkdirSync(join(root, ".claude", "skills", "dev"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "dev", "SKILL.md"),
      "---\nname: dev\ndescription: a local dev skill\n---\nbody\n",
    );
    const { files } = loadPlugin(root);
    assert.ok(
      files[join(".claude", "skills", "dev", "SKILL.md")],
      "a hooks-convention plugin's project-local .claude/skills IS materialized",
    );
  } finally {
    cleanupTmpDir(root);
  }
});

test("loadPlugin ignores a stray non-loadable file in root skills/ (falls back to .claude/skills)", () => {
  // A plain user repo may have a `skills/README.md` (or `.gitkeep`) but no real
  // root skill; that stray file must NOT mark the root populated and shadow the
  // real `.claude/skills` — only a `<name>/SKILL.md` counts as loadable.
  const root = makeTmpDir("stray-root-skills");
  try {
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "skills", "README.md"), "# not a skill\n");
    mkdirSync(join(root, ".claude", "skills", "rca"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "rca", "SKILL.md"),
      "---\nname: rca\ndescription: a real user skill\n---\nbody\n",
    );
    const { files } = loadPlugin(root);
    assert.ok(
      files[join(".claude", "skills", "rca", "SKILL.md")],
      "a stray skills/README.md must not shadow the real .claude/skills",
    );
  } finally {
    cleanupTmpDir(root);
  }
});
