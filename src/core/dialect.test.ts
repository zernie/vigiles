/**
 * Dialect-port test suite (vitest): the Claude Code dialect has the expected shape, compileAgent verifies the tool contract against the injected CC dialect (built-in ok, typo → did-you-mean), and an INJECTED alt dialect swaps the catalog (the Codex-prep seam — a tool valid under the alt dialect is flagged under CC)
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { compileAgent } from "./compile.js";
import { experimental_agent } from "./spec.js";
import type { HarnessDialect } from "./dialect.js";
// The concrete Claude Code dialect lives in its adapter (the core defines only
// the interface). Test files are exempt from the import boundary, so this test
// of the injection seam reaches for the reference dialect directly.
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";

test("the Claude Code dialect has the expected shape", () => {
  assert.equal(claudeCodeDialect.name, "claude-code");
  assert.ok(claudeCodeDialect.builtinAgentTools.includes("Bash"));
  // `ExitPlanMode` is NOT here: the vendor removes it only when the subagent's
  // permissionMode isn't `plan`, so it is a `conditional` term, not a dead one.
  assert.ok(claudeCodeDialect.neverAvailableTools.includes("AskUserQuestion"));
  // The rename the old dialect had backwards: `Agent` is current and declarable,
  // `Task` is its still-honoured alias. Neither is never-available.
  assert.ok(claudeCodeDialect.builtinAgentTools.includes("Agent"));
  assert.ok(!claudeCodeDialect.neverAvailableTools.includes("Agent"));
  // All 31 documented hook events, not the 9 this held until 2026-08-17.
  assert.equal(claudeCodeDialect.hookEvents.length, 31);
  assert.ok(claudeCodeDialect.hookEvents.includes("Setup"));
  assert.ok(claudeCodeDialect.mcpToolPattern.test("mcp__server__do_thing"));
});

test("compileAgent verifies the tool contract against the injected CC dialect", () => {
  const okAgent = experimental_agent({
    name: "reviewer",
    description: "Reviews code",
    tools: ["Read", "Grep"],
    body: "Review the diff.",
  });
  const ok = compileAgent(okAgent, {
    specFile: "reviewer.md.spec.ts",
    dialect: claudeCodeDialect,
  });
  assert.equal(ok.errors.filter((e) => e.type === "unknown-tool").length, 0);

  const badAgent = experimental_agent({
    name: "reviewer",
    description: "Reviews code",
    tools: ["Reed"], // typo
    body: "Review the diff.",
  });
  const bad = compileAgent(badAgent, {
    specFile: "reviewer.md.spec.ts",
    dialect: claudeCodeDialect,
  });
  const unknown = bad.errors.find((e) => e.type === "unknown-tool");
  assert.ok(unknown, "expected an unknown-tool error");
  assert.match(unknown.message, /Did you mean "Read"\?/);
});

test("an injected dialect swaps the catalog — Codex-prep seam", () => {
  // A hypothetical second harness: a different built-in tool set. The compiler
  // verifies against THIS dialect, proving the catalog is no longer hard-coded.
  const codexish: HarnessDialect = {
    name: "codexish",
    builtinAgentTools: ["Shell", "Apply", "Search"],
    neverAvailableTools: [],
    mcpToolPattern: /^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i,
    hookEvents: [],
    instructionTargets: ["AGENTS.md"],
    pluginRootToken: "${CODEX_PLUGIN_ROOT}",
    skillFrontmatter: "minimal",
  };
  const a = experimental_agent({
    name: "worker",
    description: "Does work",
    tools: ["Shell"], // valid in codexish, NOT in Claude Code
    body: "Work.",
  });
  // Under the codex-ish dialect: Shell is a built-in → no error.
  const withCodex = compileAgent(a, {
    specFile: "worker.md.spec.ts",
    dialect: codexish,
  });
  assert.equal(
    withCodex.errors.filter((e) => e.type === "unknown-tool").length,
    0,
  );
  // Under the Claude Code dialect: Shell is unknown → flagged.
  const withCc = compileAgent(a, {
    specFile: "worker.md.spec.ts",
    dialect: claudeCodeDialect,
  });
  assert.ok(withCc.errors.some((e) => e.type === "unknown-tool"));
});
