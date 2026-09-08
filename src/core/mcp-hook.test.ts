/**
 * MCP-hook detector suite (vitest): complete action on a declared server passes, a command hook is ignored, missing tool → incomplete, undeclared server flagged (with a declared set), GATE (no declared set → quiet), built-in `ide` allowlisted, non-object/empty hooks → none
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { verifyMcpHookTargets } from "./mcp-hook.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";

const hooks = (action: Record<string, unknown>) => ({
  PreToolUse: [{ matcher: "Bash", hooks: [action] }],
});

test("a complete mcp_tool action on a declared server passes", () => {
  assert.deepEqual(
    verifyMcpHookTargets(
      hooks({ type: "mcp_tool", server: "github", tool: "search" }),
      ["github"],
      claudeCodeDialect,
    ),
    [],
  );
});

test("a command hook is ignored entirely", () => {
  assert.deepEqual(
    verifyMcpHookTargets(
      hooks({ type: "command", command: "echo hi" }),
      ["github"],
      claudeCodeDialect,
    ),
    [],
  );
});

test("an mcp_tool action missing tool is flagged incomplete (any declared set)", () => {
  const issues = verifyMcpHookTargets(
    hooks({ type: "mcp_tool", server: "github" }),
    [],
    claudeCodeDialect,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "incomplete");
  assert.match(issues[0].message, /missing a tool field/);
});

test("an undeclared server is flagged when the plugin declares a set", () => {
  const issues = verifyMcpHookTargets(
    hooks({ type: "mcp_tool", server: "linear", tool: "x" }),
    ["github"],
    claudeCodeDialect,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "undeclared-server");
  assert.equal(issues[0].server, "linear");
  assert.match(issues[0].message, /can't resolve/);
});

test("GATE: with no declared set, a complete action isn't flagged for its server", () => {
  assert.deepEqual(
    verifyMcpHookTargets(
      hooks({ type: "mcp_tool", server: "linear", tool: "x" }),
      [],
      claudeCodeDialect,
    ),
    [],
  );
});

test("a built-in server (ide) is allowlisted even when undeclared", () => {
  assert.deepEqual(
    verifyMcpHookTargets(
      hooks({ type: "mcp_tool", server: "ide", tool: "getDiagnostics" }),
      ["github"],
      claudeCodeDialect,
    ),
    [],
  );
});

test("non-object / empty hooks → no issues", () => {
  assert.deepEqual(
    verifyMcpHookTargets(undefined, ["a"], claudeCodeDialect),
    [],
  );
  assert.deepEqual(verifyMcpHookTargets({}, ["a"], claudeCodeDialect), []);
});
