/**
 * Codex adapter validation — proves the harness-adapter kit generalizes beyond
 * Claude Code. codexAdapter is SHIPPED (registered in the registry, exported as
 * `vigiles/codex`); this suite drives it through the conformance kit and the real
 * compiler + loader against Codex-shaped fixtures (AGENTS.md, TOML config.toml
 * `[hooks]`, `${PLUGIN_ROOT}`). Findings → research/codex-prototype-findings.md.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codexAdapter } from "./adapter.js";
import { codexDialect } from "./dialect.js";
import { codexLayout } from "./layout.js";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
} from "../../adapter-conformance.js";
import { ADAPTERS, getAdapter } from "../../adapter-registry.js";
import { compileAgent } from "../../core/compile.js";
import { experimental_agent } from "../../core/spec.js";
// The generic, layout-driven loader lives at the composition root; the Codex
// adapter reuses it with codexLayout (no cross-adapter import).
import { loadPlugin } from "../../plugin-loader.js";
import { scanPlugin } from "../../scan.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

test("codexAdapter passes the conformance kit (ports + cross-port invariants)", () => {
  assertAdapterConformance(codexAdapter);
});

test("codexAdapter passes behavioural settings-load conformance (TOML round-trip)", () => {
  // Proves the settings-format axis: a Codex config.toml [hooks] block loads.
  assertAdapterLoadsHooks(codexAdapter);
});

test("codex is SHIPPED — registered in the public adapter registry", () => {
  assert.equal(getAdapter("codex"), codexAdapter);
  assert.ok(ADAPTERS.some((a) => a.name === "codex"));
});

test("the compiler verifies a subagent tool contract under codexDialect", async () => {
  // A Codex built-in passes; a Claude Code tool (Read) is flagged — proving the
  // SAME compiler validates against the injected Codex catalog.
  const ok = await compileAgent(
    experimental_agent({
      name: "w",
      description: "x",
      tools: ["shell"],
      body: "b",
    }),
    { specFile: "w.md.spec.ts", dialect: codexDialect },
  );
  assert.equal(ok.errors.filter((e) => e.type === "unknown-tool").length, 0);

  const bad = await compileAgent(
    experimental_agent({
      name: "w",
      description: "x",
      tools: ["Read"],
      body: "b",
    }),
    { specFile: "w.md.spec.ts", dialect: codexDialect },
  );
  assert.ok(bad.errors.some((e) => e.type === "unknown-tool"));
});

test("the loader reads a real Codex-shaped plugin through codexLayout", () => {
  const dir = makeTmpDir("codex");
  try {
    // AGENTS.md + a skills surface + hooks in TOML config.toml referencing the
    // Codex plugin-root token. The skills surface sits at `.agents/skills`
    // because that is where Codex scans (vendor, learn.chatgpt.com/docs/build-skills);
    // this fixture used a root-level `skills/` until 2026-09-21, i.e. it proved
    // the loader reads a directory the harness never opens.
    writeFileSync(join(dir, "AGENTS.md"), "# Agent rules\n");
    mkdirSync(join(dir, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(
      join(dir, ".agents", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: review code\n---\nReview.\n",
    );
    mkdirSync(join(dir, ".codex"));
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[[hooks.PreToolUse]]\ncommand = "${PLUGIN_ROOT}/hooks/gate.sh"\n',
    );

    const loaded = loadPlugin(dir, codexLayout);

    // instruction file picked up under its own name
    assert.ok(loaded.files["AGENTS.md"]);
    // The key equals the REAL on-disk path: codexLayout carries the prefix in
    // `skillDir` and leaves `materializeRoot` empty, so nothing is relocated.
    assert.ok(
      loaded.files[join(".agents", "skills", "review", "SKILL.md")],
      "the skill must be keyed at the path Codex actually reads",
    );
    // hooks parsed from TOML, ${PLUGIN_ROOT} expanded to the absolute root
    const hooks = JSON.stringify(loaded.settings.hooks);
    assert.ok(hooks.includes(dir), "expected ${PLUGIN_ROOT} expanded");
    assert.ok(!hooks.includes("PLUGIN_ROOT"), "token should be gone");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the loader detects Codex MCP servers from the TOML [mcp_servers] table", () => {
  const dir = makeTmpDir("codex-mcp");
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
    mkdirSync(join(dir, ".codex"));
    // Codex MCP lives in config.toml as a [mcp_servers.<id>] TOML table — the
    // JSON-only manifest read used to miss this; the format-aware read finds it.
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[mcp_servers.docs]\ncommand = "docs-server"\nargs = ["--stdio"]\n',
    );
    const loaded = loadPlugin(dir, codexLayout);
    assert.ok(
      loaded.warnings.some((w) => w.includes("MCP server")),
      "expected an MCP warning from the TOML [mcp_servers] table",
    );
    assert.ok(
      loaded.warnings.some((w) => w.includes("mcp_servers")),
      "warning should name the Codex manifest key",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

/**
 * The layout's skills path, pinned in BOTH directions.
 *
 * Fixed 2026-09-21. `codexLayout` declared `materializeRoot: ".codex"` +
 * `skillDir: "skills"`, so the tool believed Codex skills lived under
 * `.codex/skills`. The vendor page (fetched 2026-09-21,
 * `https://learn.chatgpt.com/docs/build-skills`) says otherwise, verbatim:
 *
 * > Codex scans `.agents/skills` in every directory from your current working
 * > directory up to the repository root.
 *
 * Two measured consequences, both reproduced on a fixture before the fix:
 *  1. a real Codex repo's skills were read as ZERO (`r.skills` was `[]`);
 *  2. `pluginDirLayoutIssues` got `dirname(".codex/config.toml")` and emitted a
 *     Claude-Code-worded finding — "`skills/` lives inside the `.codex/`
 *     manifest directory … only `plugin.json` belongs there" — i.e. the tool
 *     DEDUCTED POINTS for skills sitting exactly where its own layout said they
 *     should. The fix removes it rather than suppressing it: nothing named in
 *     `surfaceDirs` is nested under `.codex/` any more.
 */
test("codexLayout reads skills from `.agents/skills`, and grades that as clean", () => {
  const dir = makeTmpDir("codex-agents-skills");
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), "[mcp_servers]\n");
    mkdirSync(join(dir, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(
      join(dir, ".agents", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: a demo skill used by the layout regression\n---\n\nBody.\n",
    );

    const r = scanPlugin(dir, codexLayout, codexDialect);
    assert.deepEqual(
      r.skills.map((s) => s.name),
      ["demo"],
      "a skill at the vendor's path must be READ (it measured [] before the fix)",
    );
    // The QUIET half of consequence 2: no layout finding on a correct repo.
    assert.deepEqual(
      r.pluginLayoutIssues.map((i) => i.message),
      [],
      "a correctly laid-out Codex repo must not be docked for its own layout",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("codexLayout does NOT read skills from the old `.codex/skills` path", () => {
  // The FIRING half: the same repo with the skill at the path the layout used to
  // name. Nothing is read from it — which is the fact the fix asserts, and the
  // thing that would silently come back if `skillDir`/`materializeRoot` were
  // reverted (this test would then find a skill here and fail).
  const dir = makeTmpDir("codex-dot-codex-skills");
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
    mkdirSync(join(dir, ".codex", "skills", "demo"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), "[mcp_servers]\n");
    writeFileSync(
      join(dir, ".codex", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: a demo skill at the path Codex does not scan\n---\n\nBody.\n",
    );

    const r = scanPlugin(dir, codexLayout, codexDialect);
    assert.deepEqual(
      r.skills.map((s) => s.name),
      [],
      "`.codex/skills` is not a Codex discovery path — reading it is the old bug",
    );
    // And the false finding that used to accompany it is gone: it fired because
    // `skills` was in `surfaceDirs` AND nested under the manifest dir. It is no
    // longer in `surfaceDirs` under that spelling, so there is nothing to emit.
    assert.deepEqual(
      r.pluginLayoutIssues.map((i) => i.message),
      [],
      "the Claude-Code-worded `move skills/ to the plugin root` finding must be gone",
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
