/**
 * Tool-intercept test suite (vitest): decideIntercept (unconditional/when-scoped/first-match-wins/default reason), interceptHookDecision (PreToolUse event parse + malformed tolerance), buildInterceptSettings (matcher = escaped union of tool names), serializeIntercepts/parseIntercepts round-trip incl.
 * RegExp survival + junk tolerance.
 * Pure, model-free
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  decideIntercept,
  interceptHookDecision,
  buildInterceptSettings,
  serializeIntercepts,
  parseIntercepts,
  DEFAULT_INTERCEPT_REASON,
  INTERCEPT_TOOLS_ENV,
  type ToolIntercept,
} from "./tool-intercept.js";
import { runHook } from "./run-hook.js";

test("decideIntercept(): unconditional intercept returns the deny reason (or default)", () => {
  const intercepts: ToolIntercept[] = [
    { tool: "WebFetch", denyReason: "<prevented>" },
  ];
  const d = decideIntercept("WebFetch", { url: "https://x" }, intercepts);
  assert.deepEqual(d, { intercept: true, denyReason: "<prevented>" });

  // no denyReason → the default marker
  const d2 = decideIntercept("WebFetch", {}, [{ tool: "WebFetch" }]);
  assert.deepEqual(d2, {
    intercept: true,
    denyReason: DEFAULT_INTERCEPT_REASON,
  });

  // unrelated tool → run for real
  assert.deepEqual(decideIntercept("Read", {}, intercepts), {
    intercept: false,
  });
});

test("decideIntercept(): `when` scopes the intercept to matching args", () => {
  // intercept only a push to main; other Bash runs for real
  const intercepts: ToolIntercept[] = [
    {
      tool: "Bash",
      when: { command: /push origin main\b/ },
      denyReason: "prevented (intercepted)",
    },
  ];
  assert.deepEqual(
    decideIntercept("Bash", { command: "git push origin main" }, intercepts),
    { intercept: true, denyReason: "prevented (intercepted)" },
  );
  assert.deepEqual(
    decideIntercept("Bash", { command: "git status" }, intercepts),
    {
      intercept: false,
    },
  );
});

test("decideIntercept(): first matching intercept wins", () => {
  const intercepts: ToolIntercept[] = [
    { tool: "Bash", when: { command: /rm -rf/ }, denyReason: "blocked-ish" },
    { tool: "Bash", denyReason: "generic" },
  ];
  assert.equal(
    decideIntercept("Bash", { command: "rm -rf /" }, intercepts).intercept &&
      true,
    true,
  );
  const d = decideIntercept("Bash", { command: "rm -rf /" }, intercepts);
  assert.equal(d.intercept ? d.denyReason : "", "blocked-ish");
  // a non-rm Bash falls through to the generic intercept
  const d2 = decideIntercept("Bash", { command: "ls" }, intercepts);
  assert.equal(d2.intercept ? d2.denyReason : "", "generic");
});

test("interceptHookDecision(): parses a PreToolUse event; tolerant of malformed input", () => {
  const intercepts: ToolIntercept[] = [
    { tool: "Bash", when: { command: /push/ } },
  ];
  const ev = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "git push" },
  });
  assert.equal(interceptHookDecision(ev, intercepts).intercept, true);

  // no tool_name → no-op (let it run)
  assert.deepEqual(interceptHookDecision(JSON.stringify({}), intercepts), {
    intercept: false,
  });
  // malformed JSON → no-op, never throws
  assert.deepEqual(interceptHookDecision("{not json", intercepts), {
    intercept: false,
  });
  // missing tool_input defaults to {} (no `when` match) → run
  assert.deepEqual(
    interceptHookDecision(JSON.stringify({ tool_name: "Bash" }), intercepts),
    { intercept: false },
  );
});

test("buildInterceptSettings(): a PreToolUse hook matching the union of intercepted tools", () => {
  const s = buildInterceptSettings([
    { tool: "Bash" },
    { tool: "WebFetch" },
    { tool: "Bash" }, // dup collapses
  ]);
  const entry = s.hooks.PreToolUse[0] as {
    matcher: string;
    hooks: { type: string; command: string }[];
  };
  assert.equal(entry.matcher, "Bash|WebFetch");
  assert.equal(
    entry.hooks[0].command,
    "npx vigiles hook-runtime intercept-tool",
  );
  assert.equal(entry.hooks[0].type, "command");

  // mcp tool names carry regex metachars → escaped so the matcher is literal
  const mcp = buildInterceptSettings([{ tool: "mcp__img__gen" }], {
    command: "node hook.js",
  });
  const mentry = mcp.hooks.PreToolUse[0] as { matcher: string };
  assert.equal(mentry.matcher, "mcp__img__gen");
});

test("serializeIntercepts/parseIntercepts(): round-trips, RegExp matchers survive", () => {
  const intercepts: ToolIntercept[] = [
    {
      tool: "Bash",
      when: { command: /push origin main\b/i },
      denyReason: "ok",
    },
    { tool: "WebFetch" },
  ];
  const round = parseIntercepts(serializeIntercepts(intercepts));
  assert.equal(round.length, 2);
  assert.equal(round[0].tool, "Bash");
  assert.equal(round[0].denyReason, "ok");
  // the RegExp came back as a working RegExp (not dropped to {})
  const when = round[0].when ?? {};
  const re = when.command;
  assert.ok(re instanceof RegExp);
  assert.equal(re.test("git push origin MAIN"), true); // i flag preserved
  assert.equal(re.test("git push origin feature"), false);
  // decideIntercept works over the parsed-back intercepts
  assert.equal(
    decideIntercept("Bash", { command: "git push origin main" }, round)
      .intercept,
    true,
  );

  // exact (non-regex) matchers survive too
  const exact = parseIntercepts(
    serializeIntercepts([{ tool: "Bash", when: { command: "ls" } }]),
  );
  assert.equal(exact[0].when?.command, "ls");
});

test("parseIntercepts(): tolerant of junk", () => {
  assert.deepEqual(parseIntercepts("not json"), []);
  assert.deepEqual(parseIntercepts(JSON.stringify({ not: "array" })), []);
  // entries without a string `tool` are skipped; valid ones kept
  const mixed = parseIntercepts(
    JSON.stringify([{ tool: 1 }, null, "x", { tool: "Bash" }]),
  );
  assert.deepEqual(mixed, [
    { tool: "Bash", denyReason: undefined, when: undefined },
  ]);
});

// End-to-end PREVENTION proof: the pure decision is covered above, but the rail's
// value is that the real `vigiles hook-runtime intercept-tool` CLI, wired as a PreToolUse
// hook, actually BLOCKS a matched call before it can run. Drive the real built CLI
// through runHook (no model) and assert the block/allow outcome — a regression in
// the subcommand's env-read or deny format (which the pure tests can't see) fails
// here. Runs when dist/ is built (npm test / CI); skips loudly otherwise.
const CLI = resolve("dist/cli.js");
const interceptHookTest = existsSync(CLI) ? test : test.skip;
interceptHookTest(
  "hook-runtime intercept-tool (real CLI): BLOCKS a matched call, ALLOWS the rest",
  () => {
    const env = {
      [INTERCEPT_TOOLS_ENV]: serializeIntercepts([
        {
          tool: "Bash",
          when: { command: /git push/ },
          denyReason: "no pushes",
        },
      ]),
    };
    const cmd = `node ${CLI} hook-runtime intercept-tool`;
    // A matched call (Bash `git push`) is PREVENTED — the hook blocks it.
    const blocked = runHook(
      cmd,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      },
      { env },
    );
    assert.equal(blocked.blocked, true, "a matched tool call must be blocked");
    // A non-matching Bash command is allowed (the `when` scopes the intercept).
    const allowedArgs = runHook(
      cmd,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      },
      { env },
    );
    assert.equal(allowedArgs.blocked, false, "a non-matching command runs");
    // A different tool entirely is allowed.
    const allowedTool = runHook(
      cmd,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "x" },
      },
      { env },
    );
    assert.equal(allowedTool.blocked, false, "an un-intercepted tool runs");
  },
);

test("INTERCEPT_TOOLS_ENV is the documented var name", () => {
  assert.equal(INTERCEPT_TOOLS_ENV, "VIGILES_INTERCEPT_TOOLS");
});
