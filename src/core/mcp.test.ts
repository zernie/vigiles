/**
 * Tests for the MCP tool-reference verifier (src/mcp.ts), exercised against a
 * REAL minimal MCP server (examples/harness/fixture-mcp-server.mjs) — it speaks
 * the actual stdio JSON-RPC protocol, so these are deterministic and offline.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  listMcpTools,
  verifyMcpTool,
  parseMcpRefs,
  verifyMcpRefs,
  verifyMcpContractTools,
  mcpContractToolMessage,
  type McpServerConfig,
} from "./mcp.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";

// __dirname is dist/ at runtime; the fixture server lives at the repo root.
const server: McpServerConfig = {
  command: process.execPath, // node
  args: [
    join(import.meta.dirname, "../../examples/harness/fixture-mcp-server.mjs"),
  ],
};

test("listMcpTools: handshakes a real stdio MCP server and lists its tools", async () => {
  const tools = await listMcpTools(server);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["add", "echo"]);
  assert.equal(
    tools.find((t) => t.name === "echo")?.description,
    "Echo back the input.",
  );
});

test("verifyMcpTool: an existing tool resolves", async () => {
  const r = await verifyMcpTool(server, "echo");
  assert.equal(r.exists, true);
  assert.deepEqual(r.suggestions, []);
});

test("verifyMcpTool: a typo'd tool fails with a closest-match suggestion", async () => {
  const r = await verifyMcpTool(server, "ekho");
  assert.equal(r.exists, false);
  assert.ok(
    r.suggestions.includes("echo"),
    `expected "echo" suggested for "ekho", got ${JSON.stringify(r.suggestions)}`,
  );
});

test("verifyMcpTool: reports the available tools for a renamed reference", async () => {
  // The real-world case: a skill cites a tool the server no longer exposes.
  const r = await verifyMcpTool(server, "create_thing");
  assert.equal(r.exists, false);
  assert.deepEqual(r.available.sort(), ["add", "echo"]);
});

test("listMcpTools: throws cleanly when the server command does not exist", async () => {
  await assert.rejects(
    listMcpTools({ command: "definitely-not-a-real-binary-xyz" }, 3000),
  );
});

test("parseMcpRefs: extracts vigiles:mcp marks, skipping fenced blocks", () => {
  const md = [
    "Use `vigiles:mcp fixture#echo` and `vigiles:mcp fixture#add`.",
    "```",
    "`vigiles:mcp fixture#ignored`",
    "```",
  ].join("\n");
  assert.deepEqual(
    parseMcpRefs(md).map((r) => r.tool),
    ["echo", "add"],
  );
});

test("verifyMcpRefs: ok passes, typo errors+suggests, undeclared server flagged", async () => {
  const md =
    "`vigiles:mcp fixture#echo` `vigiles:mcp fixture#ekho` `vigiles:mcp ghost#whatever`";
  const errs = await verifyMcpRefs(md, { fixture: server });
  assert.equal(errs.length, 2); // echo is fine
  const ekho = errs.find((e) => e.tool === "ekho");
  assert.equal(ekho?.reason, "tool-missing");
  assert.ok(ekho?.suggestions.includes("echo"));
  assert.equal(
    errs.find((e) => e.server === "ghost")?.reason,
    "server-undeclared",
  );
});

// --- verifyMcpContractTools: live resolution of real mcp__server__tool refs ---

const dialect = claudeCodeDialect;

test("verifyMcpContractTools: existing tools on a declared server resolve (no errors)", async () => {
  const errs = await verifyMcpContractTools(
    ["mcp__fixture__echo", "mcp__fixture__add", "Read"],
    { fixture: server },
    dialect,
  );
  assert.deepEqual(errs, []);
});

test("verifyMcpContractTools: a renamed/missing tool is flagged with a suggestion", async () => {
  const errs = await verifyMcpContractTools(
    ["mcp__fixture__ekho"],
    { fixture: server },
    dialect,
  );
  assert.equal(errs.length, 1);
  assert.equal(errs[0].reason, "tool-missing");
  assert.equal(errs[0].server, "fixture");
  assert.equal(errs[0].toolName, "ekho");
  assert.ok(errs[0].suggestions.includes("echo"));
  assert.match(
    mcpContractToolMessage(errs[0]),
    /not found.*did you mean.*echo/,
  );
});

test("verifyMcpContractTools: a ref to an UNDECLARED server is skipped (static check's job)", async () => {
  const errs = await verifyMcpContractTools(
    ["mcp__ghost__whatever"],
    { fixture: server },
    dialect,
  );
  assert.deepEqual(errs, []);
});

test("verifyMcpContractTools: plugin-namespaced + non-MCP tools are skipped", async () => {
  const errs = await verifyMcpContractTools(
    ["mcp__plugin_foo_bar__baz", "Bash", "Grep"],
    { fixture: server },
    dialect,
  );
  assert.deepEqual(errs, []);
});

test("verifyMcpContractTools: a declared server that won't start is server-unreachable", async () => {
  const errs = await verifyMcpContractTools(
    ["mcp__bad__x"],
    { bad: { command: "definitely-not-a-real-binary-xyz" } },
    dialect,
    3000,
  );
  assert.equal(errs.length, 1);
  assert.equal(errs[0].reason, "server-unreachable");
  assert.match(mcpContractToolMessage(errs[0]), /failed to start/);
});
