/**
 * Tests for the agent runtime (src/agent-runtime.ts) — the PreToolUse
 * tool-contract rail. A subagent's `tools:` frontmatter is documentation, not a
 * runtime boundary (Claude Code #4740/#21460, SDK #172); this hook turns it into enforcement by
 * blocking any tool outside the active agent's compiled allowlist. Model-free:
 * the decision logic is pure and the runtime ops are plain filesystem.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  experimental_agent,
  prose,
  experimental_effect,
  file,
} from "../../core/spec.js";
import { compileAgent } from "../../core/compile.js";
import { claudeCodeDialect } from "./dialect.js";
import {
  parseAgentTools,
  parseAgentPurity,
  decidePreToolUse,
  setActiveAgent,
  pushActiveAgent,
  popActiveAgent,
  readActiveStack,
  readActiveAgent,
  clearActiveAgent,
  evaluatePreToolUse,
  resolveDispatchedAgent,
  decideTaskDispatch,
} from "./agent-runtime.js";
import {
  setEffectActive,
  clearEffectActive,
  readEffectActive,
} from "./effect-region.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";
import { runHook } from "../../run-hook.js";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// parseAgentTools — read the contract back out of compiled markdown
// ---------------------------------------------------------------------------

test("parseAgentTools reads the tools list from compiled frontmatter", () => {
  const { markdown } = compileAgent(
    experimental_agent({
      name: "reviewer",
      description: "Review a diff.",
      tools: ["Read", "Grep", "Bash"],
      body: "b",
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(parseAgentTools(markdown), ["Read", "Grep", "Bash"]);
});

test("parseAgentTools returns null when no tools: line (inherit-all)", () => {
  const { markdown } = compileAgent(
    experimental_agent({ name: "a", description: "d", body: "b" }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.equal(parseAgentTools(markdown), null);
});

test("parseAgentTools returns [] for an empty tools list", () => {
  // Hand-built frontmatter: a `tools:` line with nothing after it.
  const md = [
    "---",
    "",
    "name: a",
    "description: d",
    "tools:",
    "",
    "---",
    "",
    "body",
  ].join("\n");
  assert.deepEqual(parseAgentTools(md), []);
});

test("parseAgentTools returns null when there is no frontmatter", () => {
  assert.equal(parseAgentTools("# just a heading\n\ntools: Read\n"), null);
});

test("parseAgentTools ignores a `tools:` line in the body, only reads frontmatter", () => {
  const md = [
    "---",
    "name: a",
    "description: d",
    "tools: Read",
    "---",
    "",
    "Here the prose mentions tools: Write, Edit which must be ignored.",
  ].join("\n");
  assert.deepEqual(parseAgentTools(md), ["Read"]);
});

// ---------------------------------------------------------------------------
// decidePreToolUse — the pure rail
// ---------------------------------------------------------------------------

test("decidePreToolUse allows a tool inside the contract", () => {
  const d = decidePreToolUse(["Read", "Grep"], "Read");
  assert.equal(d.allow, true);
  assert.equal(d.message, "");
});

test("decidePreToolUse blocks a tool outside the contract, naming the allowlist", () => {
  const d = decidePreToolUse(["Read", "Grep"], "Write");
  assert.equal(d.allow, false);
  assert.match(d.message, /"Write" is not in this subagent's allowed-tools/);
  assert.match(d.message, /Read, Grep/);
});

test("decidePreToolUse with null allowlist imposes no restriction (inherit-all)", () => {
  assert.equal(decidePreToolUse(null, "Bash").allow, true);
});

test("decidePreToolUse with an empty allowlist denies everything", () => {
  const d = decidePreToolUse([], "Read");
  assert.equal(d.allow, false);
  assert.match(d.message, /\(none\)/);
});

test("decidePreToolUse matches MCP tools exactly", () => {
  const allowed = ["Read", "mcp__github__issue_write"];
  assert.equal(
    decidePreToolUse(allowed, "mcp__github__issue_write").allow,
    true,
  );
  assert.equal(
    decidePreToolUse(allowed, "mcp__github__delete_file").allow,
    false,
  );
});

// ---------------------------------------------------------------------------
// active-agent tracking
// ---------------------------------------------------------------------------

test("setActiveAgent / readActiveAgent / clearActiveAgent round-trip", () => {
  const dir = makeTmpDir("agent-active");
  try {
    assert.equal(readActiveAgent(dir), null);
    setActiveAgent(dir, "agents/reviewer.md");
    assert.equal(readActiveAgent(dir), "agents/reviewer.md");
    clearActiveAgent(dir);
    assert.equal(readActiveAgent(dir), null);
    // clearing again is a no-op, not an error
    clearActiveAgent(dir);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("readActiveAgent tolerates a malformed marker file", () => {
  const dir = makeTmpDir("agent-active-bad");
  try {
    setActiveAgent(dir, "x"); // creates .vigiles/active-agent.json
    writeFileSync(join(dir, ".vigiles", "active-agent.json"), "{ not json");
    assert.equal(readActiveAgent(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("readActiveAgent returns null when the marker lacks a string agent field", () => {
  const dir = makeTmpDir("agent-active-shape");
  try {
    setActiveAgent(dir, "x");
    writeFileSync(
      join(dir, ".vigiles", "active-agent.json"),
      JSON.stringify({ agent: 42 }),
    );
    assert.equal(readActiveAgent(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Depth-aware STACK (the nesting-safety fix; AgentWindowStack.tla)
// ---------------------------------------------------------------------------

test("push/pop is a stack: readActiveAgent is the TOP, pop returns to the parent", () => {
  const dir = makeTmpDir("agent-stack");
  try {
    assert.deepEqual(readActiveStack(dir), []);
    pushActiveAgent(dir, "agents/outer.md");
    pushActiveAgent(dir, "agents/inner.md");
    assert.deepEqual(readActiveStack(dir), [
      "agents/outer.md",
      "agents/inner.md",
    ]);
    assert.equal(readActiveAgent(dir), "agents/inner.md"); // top
    popActiveAgent(dir); // inner returns
    assert.equal(readActiveAgent(dir), "agents/outer.md"); // back to parent, NOT cleared
    popActiveAgent(dir); // outer returns
    assert.equal(readActiveAgent(dir), null);
    popActiveAgent(dir); // popping empty is a no-op
    assert.equal(readActiveAgent(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("readActiveStack back-compat: a legacy { agent } marker reads as a one-frame stack", () => {
  const dir = makeTmpDir("agent-stack-legacy");
  try {
    mkdirSync(join(dir, ".vigiles"), { recursive: true });
    writeFileSync(
      join(dir, ".vigiles", "active-agent.json"),
      JSON.stringify({ agent: "agents/legacy.md" }),
    );
    assert.deepEqual(readActiveStack(dir), ["agents/legacy.md"]);
    assert.equal(readActiveAgent(dir), "agents/legacy.md");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("NESTING CONTRACT-ESCAPE regression (AgentWindowStack.tla counterexample): Open;Open;Stop;Call(Bash) is DENIED", () => {
  // The TLC-certified counterexample the FLAT single-slot model failed: a writer
  // agent (tools: Read/Write/Edit, no Bash) dispatches a nested writer; the inner
  // returns (Stop). With a flat slot, Stop cleared everything → the gate saw "no
  // active agent" → it ALLOWED Bash while still inside the outer writer = a
  // contract escape. With the stack, Stop pops back to the outer writer, so Bash
  // is correctly DENIED.
  const dir = makeTmpDir("agent-nesting-escape");
  try {
    mkdirSync(join(dir, "agents"), { recursive: true });
    const { markdown } = compileAgent(
      experimental_agent({
        name: "writer",
        description: "writes files",
        tools: ["Read", "Write", "Edit"],
        body: prose`Write the file.`,
      }),
      { dialect: claudeCodeDialect },
    );
    writeFileSync(join(dir, "agents", "writer.md"), markdown);

    pushActiveAgent(dir, "agents/writer.md"); // Open(writer)
    pushActiveAgent(dir, "agents/writer.md"); // Open(writer) — nested
    popActiveAgent(dir); // Stop — inner returns

    // Still inside the OUTER writer → Bash (not in its contract) must be blocked.
    const bash = evaluatePreToolUse(dir, "Bash", "echo hi");
    assert.equal(
      bash.allow,
      false,
      "Bash must be DENIED — outer writer forbids it",
    );
    // A tool the contract DOES list still passes.
    assert.equal(evaluatePreToolUse(dir, "Write").allow, true);

    popActiveAgent(dir); // outer returns → no active agent → unrestricted again
    assert.equal(evaluatePreToolUse(dir, "Bash", "echo hi").allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// evaluatePreToolUse — the wired hook decision against the compiled .md
// ---------------------------------------------------------------------------

test("evaluatePreToolUse blocks an out-of-contract tool for the active agent", () => {
  const dir = makeTmpDir("agent-eval");
  try {
    const { markdown } = compileAgent(
      experimental_agent({
        name: "reviewer",
        description: "Review a diff.",
        tools: ["Read", "Grep"], // no Write/Edit/Bash
        body: "b",
      }),
      {
        basePath: dir,
        specFile: "agents/reviewer.md.spec.ts",
        dialect: claudeCodeDialect,
      },
    );
    writeFileSync(join(dir, "reviewer.md"), markdown);
    setActiveAgent(dir, "reviewer.md");

    assert.equal(evaluatePreToolUse(dir, "Read").allow, true);
    const blocked = evaluatePreToolUse(dir, "Write");
    assert.equal(blocked.allow, false);
    assert.match(blocked.message, /allowed-tools contract/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("evaluatePreToolUse allows anything when no agent is active", () => {
  const dir = makeTmpDir("agent-eval-none");
  try {
    assert.equal(evaluatePreToolUse(dir, "Bash").allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("evaluatePreToolUse allows when the active agent's .md is missing", () => {
  const dir = makeTmpDir("agent-eval-missing");
  try {
    setActiveAgent(dir, "agents/ghost.md");
    assert.equal(evaluatePreToolUse(dir, "Write").allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("evaluatePreToolUse allows everything for an inherit-all agent", () => {
  const dir = makeTmpDir("agent-eval-inherit");
  try {
    const { markdown } = compileAgent(
      experimental_agent({ name: "open", description: "d", body: "b" }), // no tools: line
      {
        basePath: dir,
        specFile: "agents/open.md.spec.ts",
        dialect: claudeCodeDialect,
      },
    );
    writeFileSync(join(dir, "open.md"), markdown);
    setActiveAgent(dir, "open.md");
    assert.equal(evaluatePreToolUse(dir, "Bash").allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// parseAgentPurity + the runtime purity gate (command-refined Bash)
// ---------------------------------------------------------------------------

test("parseAgentPurity reads the vigiles:purity marker compile emits", () => {
  const { markdown } = compileAgent(
    experimental_agent({
      name: "editor",
      description: "Edits within a boundary.",
      purity: "bounded",
      tools: ["Read", "Write", "Bash"],
      body: "b",
    }),
    { specFile: "agents/editor.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.equal(parseAgentPurity(markdown), "bounded");
});

test("parseAgentPurity returns null when no marker is present", () => {
  const { markdown } = compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      tools: ["Read"],
      body: "b",
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.equal(parseAgentPurity(markdown), null);
});

test("evaluatePreToolUse applies the purity gate: a bounded agent's Bash is command-refined", () => {
  const dir = makeTmpDir("agent-purity");
  try {
    const { markdown } = compileAgent(
      experimental_agent({
        name: "editor",
        description: "Edits + observes via Bash.",
        purity: "bounded",
        tools: ["Read", "Write", "Bash"],
        body: "b",
      }),
      {
        basePath: dir,
        specFile: "agents/editor.md.spec.ts",
        dialect: claudeCodeDialect,
      },
    );
    writeFileSync(join(dir, "editor.md"), markdown);
    setActiveAgent(dir, "editor.md");

    // read-only Bash is an observation → allowed even outside any boundary.
    assert.equal(evaluatePreToolUse(dir, "Bash", "git status").allow, true);
    // mutating Bash → denied by the purity gate (the rail alone would allow it).
    const blocked = evaluatePreToolUse(dir, "Bash", "git push origin main");
    assert.equal(blocked.allow, false);
    assert.match(blocked.message, /read-only/);
    // Write is a decidable effect → allowed at the bounded floor.
    assert.equal(evaluatePreToolUse(dir, "Write").allow, true);
    assert.equal(evaluatePreToolUse(dir, "Read").allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("evaluatePreToolUse: the tool-contract rail still fires before the purity gate", () => {
  const dir = makeTmpDir("agent-purity-rail");
  try {
    // A pure agent: Read/Grep only. Write is out of contract → the RAIL denies
    // it (the purity gate never needs to), proving the two layers compose.
    const { markdown } = compileAgent(
      experimental_agent({
        name: "reviewer",
        description: "Reviews.",
        purity: "pure",
        tools: ["Read", "Grep"],
        body: "b",
      }),
      {
        basePath: dir,
        specFile: "agents/reviewer.md.spec.ts",
        dialect: claudeCodeDialect,
      },
    );
    writeFileSync(join(dir, "reviewer.md"), markdown);
    setActiveAgent(dir, "reviewer.md");
    const blocked = evaluatePreToolUse(dir, "Write");
    assert.equal(blocked.allow, false);
    assert.match(blocked.message, /allowed-tools contract/);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// The differentiator's invariant: hook ⇄ allowlist agree
// ---------------------------------------------------------------------------

test("the rail the hook enforces is exactly the declared contract (round-trip)", () => {
  // The whole point of #4740/#21460, SDK #172: the `tools:` field documents intent but doesn't
  // enforce it. vigiles compiles ONE source (spec.tools) into BOTH the
  // frontmatter (intent) AND the list the PreToolUse hook reads (enforcement),
  // so the two cannot drift. Prove it: compile → parse the frontmatter the hook
  // will read → it equals the declared tools, and the hook allows exactly those.
  const declared = ["Read", "Grep", "Glob", "Bash"];
  const { markdown } = compileAgent(
    experimental_agent({
      name: "ui-visual-validator",
      description: "Validate UI visually.",
      tools: declared,
      body: "b",
    }),
    {
      specFile: "agents/ui-visual-validator.md.spec.ts",
      dialect: claudeCodeDialect,
    },
  );

  const enforced = parseAgentTools(markdown);
  assert.deepEqual(enforced, declared); // hook reads exactly what was declared

  for (const t of declared) {
    assert.equal(decidePreToolUse(enforced, t).allow, true);
  }
  for (const t of ["Write", "Edit", "Task", "WebFetch"]) {
    assert.equal(decidePreToolUse(enforced, t).allow, false); // the least-privilege rail
  }
});

// ---------------------------------------------------------------------------
// agent-hook (CLI): the real PreToolUse rail process
//
// Tool-event hooks are best proven at the cheap unit tier (CLAUDE.md: runHook
// is "the only tier that reaches every event incl. ... PreToolUse"): pipe a
// real synthesized PreToolUse event to the BUILT CLI hook and assert the
// block/allow decision — deterministic, no model, no flaky live tool call.
// Requires the build (npm test / coverage build it first), like src/cli.test.ts.
// ---------------------------------------------------------------------------

const CLI = resolve(__dirname, "..", "..", "..", "dist", "cli.js");

/** Set up a temp project with a compiled agent and mark it active. */
function projectWithActiveAgent(tools: string[]): string {
  const dir = makeTmpDir("agent-hook-cli");
  const { markdown } = compileAgent(
    experimental_agent({
      name: "reader",
      description: "read-only worker",
      tools,
      body: "b",
    }),
    {
      basePath: dir,
      specFile: "agents/reader.md.spec.ts",
      dialect: claudeCodeDialect,
    },
  );
  writeFileSync(join(dir, "reader.md"), markdown);
  setActiveAgent(dir, "reader.md");
  return dir;
}

test("agent-hook CLI blocks (exit 2) an out-of-contract tool", () => {
  const dir = projectWithActiveAgent(["Read", "Grep"]);
  try {
    const r = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "x.ts" },
      },
      { cwd: dir },
    );
    assert.equal(r.blocked, true);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /allowed-tools contract/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI allows (exit 0) an in-contract tool", () => {
  const dir = projectWithActiveAgent(["Read", "Grep"]);
  try {
    const r = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "x.ts" },
      },
      { cwd: dir },
    );
    assert.equal(r.blocked, false);
    assert.equal(r.exitCode, 0);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI command-gates Bash for a bounded agent (read-only allowed, mutating blocked)", () => {
  const dir = makeTmpDir("agent-hook-purity");
  const { markdown } = compileAgent(
    experimental_agent({
      name: "editor",
      description: "Edits + observes.",
      purity: "bounded",
      tools: ["Read", "Write", "Bash"],
      body: "b",
    }),
    {
      basePath: dir,
      specFile: "agents/editor.md.spec.ts",
      dialect: claudeCodeDialect,
    },
  );
  writeFileSync(join(dir, "editor.md"), markdown);
  setActiveAgent(dir, "editor.md");
  try {
    const ok = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
      { cwd: dir },
    );
    assert.equal(ok.blocked, false);
    assert.equal(ok.exitCode, 0);

    const blocked = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      },
      { cwd: dir },
    );
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.stderr, /read-only/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI allows when no agent is active", () => {
  const dir = makeTmpDir("agent-hook-none");
  try {
    const r = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      },
      { cwd: dir },
    );
    assert.equal(r.blocked, false);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI allows on a malformed/empty event (no tool name)", () => {
  const dir = projectWithActiveAgent(["Read"]);
  try {
    const r = runHook(`node ${CLI} hook-runtime agent`, {}, { cwd: dir });
    assert.equal(r.blocked, false);
    assert.equal(r.exitCode, 0);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Grounded in a REAL vendored subagent (not a synthetic fixture)
//
// wshobson's ui-visual-validator is pinned under test/dogfood/. It
// is the documented footgun in the wild: a "rigorous visual validator" that
// "bases judgments solely on visual evidence" yet ships with NO `tools:` line —
// so it inherits EVERY tool, including Edit/Write it has no business holding.
// These assertions check the rail against that actual file, not a hand-built
// one. __dirname is src/ (unit run) or dist/ (built) — both one level under the
// repo root, so the relative vendor path resolves either way (matches
// src/vendor.test.ts).
// ---------------------------------------------------------------------------

const REAL_AGENT = join(
  __dirname,
  "../../../test/dogfood/wshobson-accessibility@cf6059d/agents/ui-visual-validator.md",
);

test("real vendored subagent ships no tools: line — the rail correctly reports it inherits all", () => {
  const md = readFileSync(REAL_AGENT, "utf-8");
  // The wild footgun: no contract at all → parseAgentTools returns null →
  // decidePreToolUse imposes no restriction. The rail honestly reports "there
  // is no rail here yet" rather than inventing one — which is exactly why the
  // omitted-tools authoring warning is the next roadmap item.
  assert.equal(parseAgentTools(md), null);
  assert.equal(decidePreToolUse(parseAgentTools(md), "Write").allow, true);
});

test("the spec form ADDS the rail the real subagent omits, and it parses + enforces", () => {
  // Reconstruct the real agent AS a spec with the least-privilege contract its
  // hand-written original lacks (read + run visual tests; never Edit/Write),
  // compile it, then prove the SAME PreToolUse rail the hook reads now blocks
  // the tools the original silently held. This is the differentiator on a real
  // subagent: compile turns the missing contract into an enforced one.
  const md = readFileSync(REAL_AGENT, "utf-8");
  const nameLine = /^name:\s*(.+)$/m.exec(md);
  const descLine = /^description:\s*(.+)$/m.exec(md);
  assert.ok(nameLine && descLine); // sanity: we're reading the real frontmatter

  const { markdown, errors } = compileAgent(
    experimental_agent({
      name: nameLine[1].trim(),
      description: descLine[1].trim(),
      model: "sonnet",
      tools: ["Read", "Grep", "Glob", "Bash"], // the rail the original omits
      body: "You are an experienced UI visual validation expert.",
    }),
    {
      specFile: "agents/ui-visual-validator.md.spec.ts",
      dialect: claudeCodeDialect,
    },
  );
  assert.deepEqual(errors, []);

  const enforced = parseAgentTools(markdown);
  assert.deepEqual(enforced, ["Read", "Grep", "Glob", "Bash"]);
  assert.equal(decidePreToolUse(enforced, "Bash").allow, true);
  // the tools the wild original inherited but a visual validator must not hold:
  assert.equal(decidePreToolUse(enforced, "Write").allow, false);
  assert.equal(decidePreToolUse(enforced, "Edit").allow, false);
});

// ---------------------------------------------------------------------------
// Effect boundary gate — evaluatePreToolUse + runHook
// ---------------------------------------------------------------------------

test("evaluatePreToolUse: effect boundary outside blocks side-effecting tools", () => {
  const dir = makeTmpDir("agent-effect-boundary");
  try {
    const { markdown } = compileAgent(
      experimental_agent({
        name: "release",
        description: "Cut a release.",
        tools: ["Read", "Write", "Bash"],
        body: prose`
          ## Prepare
          Read ${file("package.json")}.

          ## Apply
          ${experimental_effect`
            Side effects allowed ONLY here.
          `}
        `,
      }),
      {
        basePath: dir,
        specFile: "agents/release.md.spec.ts",
        dialect: claudeCodeDialect,
      },
    );
    writeFileSync(join(dir, "release.md"), markdown);
    setActiveAgent(dir, "release.md");
    // ensure no effect-active marker → outside the boundary

    // Write is side-effecting → denied when outside the effect boundary
    const blocked = evaluatePreToolUse(dir, "Write");
    assert.equal(blocked.allow, false);
    assert.match(blocked.message, /pure unit may only observe/);

    // Read is always read-only → allowed even outside the boundary
    const allowed = evaluatePreToolUse(dir, "Read");
    assert.equal(allowed.allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("evaluatePreToolUse: effect boundary inside allows side-effecting tools", () => {
  const dir = makeTmpDir("agent-effect-inside");
  try {
    const { markdown } = compileAgent(
      experimental_agent({
        name: "release",
        description: "Cut a release.",
        tools: ["Read", "Write"],
        body: prose`
          ## Apply
          ${experimental_effect`Write ${file("package.json")}.`}
        `,
      }),
      {
        basePath: dir,
        specFile: "agents/release.md.spec.ts",
        dialect: claudeCodeDialect,
      },
    );
    writeFileSync(join(dir, "release.md"), markdown);
    setActiveAgent(dir, "release.md");
    setEffectActive(dir); // enter the boundary

    // Write is now inside the boundary → allowed
    const allowed = evaluatePreToolUse(dir, "Write");
    assert.equal(allowed.allow, true);
  } finally {
    clearEffectActive(dir);
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI: effect-enter allows Write; effect-exit blocks Write again", () => {
  const dir = makeTmpDir("agent-hook-effect");
  const { markdown } = compileAgent(
    experimental_agent({
      name: "release",
      description: "Cut a release.",
      tools: ["Read", "Write"],
      body: prose`
        ## Apply
        ${experimental_effect`Write the changelog.`}
      `,
    }),
    {
      basePath: dir,
      specFile: "agents/release.md.spec.ts",
      dialect: claudeCodeDialect,
    },
  );
  writeFileSync(join(dir, "release.md"), markdown);
  setActiveAgent(dir, "release.md");
  try {
    // Outside the boundary → Write blocked
    const outsideBlocked = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "CHANGELOG.md", content: "..." },
      },
      { cwd: dir },
    );
    assert.equal(outsideBlocked.blocked, true);

    // Enter the boundary
    setEffectActive(dir);

    // Inside the boundary → Write allowed
    const insideAllowed = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "CHANGELOG.md", content: "..." },
      },
      { cwd: dir },
    );
    assert.equal(insideAllowed.blocked, false);

    // Exit the boundary
    clearEffectActive(dir);

    // Outside again → Write blocked
    const afterExit = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "CHANGELOG.md", content: "..." },
      },
      { cwd: dir },
    );
    assert.equal(afterExit.blocked, true);
  } finally {
    clearEffectActive(dir);
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Deterministic subagent window — PreToolUse(Task) opens, SubagentStop closes
// (replaces the model-invoked agent-start / effect-enter; harness-bracketed)
// ---------------------------------------------------------------------------

test("resolveDispatchedAgent resolves agents/<name>.md under cwd (relative)", () => {
  const dir = makeTmpDir("dispatch-cwd");
  try {
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "reviewer.md"), "x");
    assert.equal(
      resolveDispatchedAgent("reviewer", dir),
      join("agents", "reviewer.md"),
    );
    // namespaced "plugin:name" → last segment
    assert.equal(
      resolveDispatchedAgent("my-plugin:reviewer", dir),
      join("agents", "reviewer.md"),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveDispatchedAgent falls back to the plugin root (absolute)", () => {
  const cwd = makeTmpDir("dispatch-cwd2");
  const pluginRoot = makeTmpDir("dispatch-plugin");
  try {
    mkdirSync(join(pluginRoot, "agents"), { recursive: true });
    writeFileSync(join(pluginRoot, "agents", "worker.md"), "x");
    assert.equal(
      resolveDispatchedAgent("worker", cwd, pluginRoot),
      resolve(pluginRoot, "agents", "worker.md"),
    );
  } finally {
    cleanupTmpDir(cwd);
    cleanupTmpDir(pluginRoot);
  }
});

test("resolveDispatchedAgent / decideTaskDispatch return null when unresolved", () => {
  const dir = makeTmpDir("dispatch-miss");
  try {
    assert.equal(resolveDispatchedAgent("nope", dir), null);
    assert.equal(decideTaskDispatch({ subagent_type: "nope" }, dir), null);
    // missing / non-string subagent_type → null
    assert.equal(decideTaskDispatch({}, dir), null);
    assert.equal(decideTaskDispatch({ subagent_type: 3 }, dir), null);
    assert.equal(decideTaskDispatch(null, dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI: PreToolUse(Task) opens the window; SubagentStop closes it", () => {
  const dir = makeTmpDir("dispatch-hook");
  try {
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "reviewer.md"), "x");

    // Parent dispatches a subagent → PreToolUse(Task) sets the active agent +
    // effect window deterministically (no model agent-start), and is itself
    // allowed (exit 0 — the Task dispatch is the parent's action).
    const open = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "reviewer", prompt: "review it" },
      },
      { cwd: dir },
    );
    assert.equal(open.blocked, false);
    assert.equal(readActiveAgent(dir), join("agents", "reviewer.md"));
    assert.equal(readEffectActive(dir), true);

    // Subagent returns → SubagentStop clears both (no model agent-done).
    const close = runHook(
      `node ${CLI} hook-runtime agent`,
      { hook_event_name: "SubagentStop" },
      { cwd: dir },
    );
    assert.equal(close.blocked, false);
    assert.equal(readActiveAgent(dir), null);
    assert.equal(readEffectActive(dir), false);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI: NESTED dispatch — SubagentStop POPS to the parent, doesn't clear (nesting-safe)", () => {
  const dir = makeTmpDir("dispatch-nested");
  try {
    mkdirSync(join(dir, "agents"), { recursive: true });
    // Two real agents so the open signal resolves each by name.
    writeFileSync(join(dir, "agents", "outer.md"), "x");
    writeFileSync(join(dir, "agents", "inner.md"), "x");

    const dispatch = (name: string) =>
      runHook(
        `node ${CLI} hook-runtime agent`,
        {
          hook_event_name: "PreToolUse",
          tool_name: "Task",
          tool_input: { subagent_type: name, prompt: "go" },
        },
        { cwd: dir },
      );
    const stop = () =>
      runHook(
        `node ${CLI} hook-runtime agent`,
        { hook_event_name: "SubagentStop" },
        { cwd: dir },
      );

    dispatch("outer");
    dispatch("inner"); // nested
    assert.equal(readActiveAgent(dir), join("agents", "inner.md")); // top
    stop(); // inner returns → POP back to outer, NOT a full clear
    assert.equal(readActiveAgent(dir), join("agents", "outer.md"));
    stop(); // outer returns → now empty
    assert.equal(readActiveAgent(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("agent-hook CLI: PreToolUse(Task) with an unknown subagent activates nothing (fail-open)", () => {
  const dir = makeTmpDir("dispatch-unknown");
  try {
    const r = runHook(
      `node ${CLI} hook-runtime agent`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "does-not-exist" },
      },
      { cwd: dir },
    );
    assert.equal(r.blocked, false);
    assert.equal(readActiveAgent(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a SPACE-separated tools: contract grants those tools at the rail (#217)", () => {
  // The second, worse half of #217, on the surface where the contract is
  // ENFORCED rather than reported. A skill's `allowed-tools:` only pre-approves,
  // so a mis-split there misleads an audit; a SUBAGENT's `tools:` is the
  // allowlist this rail denies against — so when the space-separated spelling
  // arrived as the single token "Read Grep Glob", `includes(tool)` matched
  // nothing and the agent was denied EVERY tool, including the three it was
  // explicitly granted. Measured before the fix: Read DENY, Grep DENY, Bash DENY.
  const md =
    "---\nname: reader\ndescription: reads\ntools: Read Grep Glob\n---\nbody\n";
  const allowed = parseAgentTools(md);
  assert.deepEqual(allowed, ["Read", "Grep", "Glob"]);
  assert.equal(decidePreToolUse(allowed, "Read").allow, true);
  assert.equal(decidePreToolUse(allowed, "Grep").allow, true);
  // …and the fence still holds for what was NOT granted.
  assert.equal(decidePreToolUse(allowed, "Bash").allow, false);
});
