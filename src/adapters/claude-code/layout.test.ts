/**
 * Layout-port test suite (vitest): claudeCodeLayout is the loadPlugin default; an alternate Codex-shaped PluginLayout (AGENTS.md, prompts/ surface, .codex/ settings, ${CODEX_PLUGIN_ROOT}) loads through the SAME loadPlugin — and the default CC layout sees none of it (the swap seam a second harness plugs into)
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadPlugin } from "./plugin-loader.js";
import { claudeCodeLayout } from "./layout.js";
import type { PluginLayout } from "../../core/layout.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

// A hypothetical second harness's layout — different manifest, instruction file,
// surface dir, materialize root and plugin-root token. The point: the SAME
// loadPlugin reads it, so a Codex adapter is a PluginLayout value, not a fork.
const codexLayout: PluginLayout = {
  name: "codex-ish",
  manifestPath: ".codex/config.json",
  hooksConventionPath: "hooks/codex-hooks.json",
  settingsPath: ".codex/config.toml",
  settingsFormat: "toml",
  instructionFile: "AGENTS.md",
  surfaceDirs: ["prompts"],
  skillDir: "skills",
  agentDir: "",
  commandDir: "prompts",
  materializeRoot: ".codex",
  pluginRootToken: "${CODEX_PLUGIN_ROOT}",
  mcpConfigFile: ".codex-mcp.json",
  mcpManifestKey: "mcp",
  intraRefDirs: ["prompts", "hooks"],
};

test("claudeCodeLayout is the default loadPlugin uses", () => {
  assert.equal(claudeCodeLayout.instructionFile, "CLAUDE.md");
  assert.equal(claudeCodeLayout.pluginRootToken, "${CLAUDE_PLUGIN_ROOT}");
});

test("loadPlugin reads an alternate (Codex-shaped) layout through the same loader", () => {
  const dir = makeTmpDir("layout");
  try {
    // A Codex-shaped plugin: AGENTS.md, a prompts/ surface, and hooks in a
    // **TOML** config (the settings-format axis) referencing the Codex token.
    writeFileSync(join(dir, "AGENTS.md"), "# Agent rules\n");
    mkdirSync(join(dir, "prompts"));
    writeFileSync(join(dir, "prompts", "review.md"), "Review carefully.\n");
    mkdirSync(join(dir, ".codex"));
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[[hooks.PreToolUse]]\ncommand = "${CODEX_PLUGIN_ROOT}/hooks/gate.sh"\n',
    );

    const loaded = loadPlugin(dir, codexLayout);

    // instruction file picked up under its own name
    assert.ok(loaded.files["AGENTS.md"]);
    // surface materialized under the Codex materialize root
    assert.ok(loaded.files[join(".codex", "prompts", "review.md")]);
    // plugin-root token expanded to the absolute root
    const hooks = JSON.stringify(loaded.settings.hooks);
    assert.ok(hooks.includes(dir), "expected ${CODEX_PLUGIN_ROOT} expanded");
    assert.ok(!hooks.includes("CODEX_PLUGIN_ROOT"), "token should be gone");

    // The DEFAULT (Claude Code) layout sees none of it — AGENTS.md is not CC's
    // instruction file, .codex/config.toml is not CC's settings path.
    const asCc = loadPlugin(dir);
    assert.equal(asCc.files["CLAUDE.md"], undefined);
    assert.equal(asCc.settings.hooks, undefined);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("malformed TOML settings yields no hooks (no crash)", () => {
  const dir = makeTmpDir("layout-toml-bad");
  try {
    mkdirSync(join(dir, ".codex"));
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      "this is = not valid = toml",
    );
    const loaded = loadPlugin(dir, codexLayout);
    assert.equal(loaded.settings.hooks, undefined);
  } finally {
    cleanupTmpDir(dir);
  }
});
