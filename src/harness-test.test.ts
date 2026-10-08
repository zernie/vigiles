/**
 * Tests for the deterministic harness-test API: the real `claude` CLI runs the
 * real hooks/settings against a scripted mock model, so the outcome is
 * reproducible. Skipped cleanly when `claude` is not on PATH.
 *
 * Edit/Write tool-event hooks DO fire in this tier (`allowedTools` pre-approves
 * the edit tools past the permission prompt) — see the Edit/Write regression
 * tests below. An earlier claude version gated them headlessly; the tests lock in
 * that they work on current CLIs (verified on 2.1.169) and catch a re-gate.
 */
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";

test("parseSubagents recovers a subagent's nested tool calls by parent_tool_use_id", () => {
  // Verified against real claude output: the dispatch tool is named "Agent"
  // (not "Task"), its input carries subagent_type, and the subagent's events are
  // tagged with parent_tool_use_id = the dispatch id. (No claude needed — pure
  // parse.) The parser matches on subagent_type, not the tool name.
  const stream = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Agent", // the real subagent-dispatch tool name
            input: {
              description: "review",
              prompt: "review app.js",
              subagent_type: "reviewer",
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "t1",
      message: {
        content: [{ type: "tool_use", id: "s1", name: "Read", input: {} }],
      },
    }),
    JSON.stringify({
      type: "user",
      parent_tool_use_id: "t1",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "s1", content: "file body" },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "t1",
      message: {
        content: [{ type: "tool_use", id: "s2", name: "Bash", input: {} }],
      },
    }),
    JSON.stringify({ type: "result", num_turns: 2 }),
  ].join("\n");

  const subs = parseSubagents(stream);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, "reviewer");
  assert.deepEqual(
    subs[0].toolCalls.map((c) => c.name),
    ["Read", "Bash"],
  );
  assert.equal(subs[0].toolCalls[0].resultText, "file body");
  // No subagents in a plain stream.
  assert.deepEqual(parseSubagents('{"type":"result"}'), []);
});

/**
 * Prevention gate for the "`turns` means two things" regression, in the shape
 * the `cli-harness-resolution` gates use — because the buggy line is in the
 * SANDBOX branch, which needs bwrap and therefore never runs in this suite. A
 * behavioural test would have stayed green through the whole bug's life; the
 * boundary itself is pinned in `sandbox.test.ts`, and this pins the call site.
 *
 * The direct path reports `mock.count` (the agent's turns). The sandbox path had
 * `out.requests.length`, which counts the CLI's side-channel calls too — 27
 * requests for 9 turns, measured on Claude Code 2.1.228. Recovering the split
 * from the tags (`splitRequestCounts`) is the only allowed derivation here.
 *
 * Audited at the same time and deliberately NOT covered: `adapters/codex/driver.ts`
 * also returns `mock.requests.length` as its count, and that is correct there —
 * the Codex mock has no side-channel routing at all, so its script counter and
 * its request count are the same number by construction.
 */
test("harness-test.ts never derives turns from requests.length (both paths, one meaning)", () => {
  const src = readFileSync(join(__dirname, "harness-test.ts"), "utf-8");
  const code = src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .filter((l) => !l.trimStart().startsWith("*"))
    .join("\n");
  assert.ok(
    !/\.requests\.length/.test(code),
    "harness-test.ts must not count request-log lines as model turns — the CLI's side-channel calls are in that log. Use splitRequestCounts(out.requests).count, which matches mock.count on the direct path.",
  );
  assert.ok(
    /splitRequestCounts/.test(code),
    "the sandbox path must recover the main-loop/side-channel split from the tagged request log",
  );
});

test("runHarness steers a real-model run to measure() (no claude needed)", async () => {
  // The harness scope is deterministic (mock); a real-model run is
  // non-deterministic, so a single one can't be asserted — runHarness says so.
  await assert.rejects(
    runHarness({ model: [], prompt: "go" }, { model: "real" }),
    /measure\(\)/,
  );
});

import {
  runHarnessTest,
  runHarness,
  scriptModel,
  claudeAvailable,
  parseToolCalls,
  parseOutput,
  parseHooks,
  parseSubagents,
  buildClaudeArgs,
  toolAvailabilityList,
  unsupportedToolsFlag,
  unofferedScriptedTool,
  noSuchToolMessage,
  warnUnconsumed,
} from "./harness-test.js";
import {
  assertToolUsed,
  assertToolNotUsed,
  assertSkillResolved,
  assertToolUsedWith,
  assertToolSequence,
  assertToolCount,
  assertToolCalls,
} from "./harness-assert.js";

const maybe = claudeAvailable() ? test : test.skip;

// Pure: the shared claude argv (no model, no claude). Covers the transcript /
// pluginDir / settings / default-tools branches.
test("buildClaudeArgs: transcript, pluginDir, settings, and tool defaults", () => {
  const base = buildClaudeArgs({ model: scriptModel([]) }, false);
  assert.deepEqual(base.slice(0, 2), ["-p", "go"]); // default prompt
  assert.ok(base.includes("json") && !base.includes("stream-json"));
  assert.ok(!base.includes("--plugin-dir") && !base.includes("--settings"));
  // default allowed tools come last
  assert.deepEqual(base.slice(-5), [
    "--allowedTools",
    "Read",
    "Edit",
    "Write",
    "Bash",
  ]);

  const full = buildClaudeArgs(
    {
      model: scriptModel([]),
      prompt: "do it",
      transcript: true,
      pluginDir: "examples/harness/fixture-skill-plugin",
      allowedTools: ["Bash"],
    },
    true,
  );
  assert.deepEqual(full.slice(0, 2), ["-p", "do it"]);
  assert.ok(full.includes("stream-json") && full.includes("--verbose"));
  assert.ok(full.includes("--plugin-dir") && full.includes("--settings"));
  assert.deepEqual(full.slice(-2), ["--allowedTools", "Bash"]);
});

// #340: an agent that asks for more turns than the script has must fail the
// test, not be fed a copy of the last turn. A Stop hook that blocks once makes
// a one-turn script a two-turn run: before, the mock repeated "I'm done" and the
// run came back green with `turns: 2` against a one-turn script.
maybe(
  "a run that outlasts its script fails the test and says how",
  async () => {
    await assert.rejects(
      runHarnessTest({
        sandbox: false,
        settings: {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "test -f {cwd}/seen || { touch {cwd}/seen; echo 'not yet' >&2; exit 2; }",
                  },
                ],
              },
            ],
          },
        },
        model: [{ text: "I'm done" }],
        timeoutMs: 120000,
      }),
      /1 turn\(s\) scripted, and agent request #2 had none left/,
    );
  },
);

maybe(
  "a script that covers every turn the agent takes still passes",
  async () => {
    const r = await runHarnessTest({
      sandbox: false,
      settings: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "test -f {cwd}/seen || { touch {cwd}/seen; echo 'not yet' >&2; exit 2; }",
                },
              ],
            },
          ],
        },
      },
      model: [{ text: "I'm done" }, { text: "now really done" }],
      timeoutMs: 120000,
    });
    try {
      assert.equal(r.turns, 2);
    } finally {
      r.cleanup();
    }
  },
);

// `tools` (which tools EXIST, `--tools`) and `allowedTools` (which are
// PRE-APPROVED, `--allowedTools`) are two fields because they are two Claude Code
// flags. #341 folded them into one and broke "a tool that exists but is not
// approved is refused", the permission-containment case.
const flagValues = (args: readonly string[], flag: string): string[] => {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const next = rest.findIndex((a) => a.startsWith("--"));
  return next < 0 ? rest : rest.slice(0, next);
};

test("buildClaudeArgs: allowedTools alone pre-approves and never restricts", () => {
  const argsOf = (allowedTools?: readonly string[]) =>
    buildClaudeArgs({ model: scriptModel([]), allowedTools }, false);

  const narrowed = argsOf(["Read", "Write"]);
  assert.ok(
    !narrowed.includes("--tools"),
    "allowedTools must not emit --tools",
  );
  assert.deepEqual(flagValues(narrowed, "--allowedTools"), ["Read", "Write"]);

  // A permission rule keeps its specifier: it is an approval, not a name.
  assert.deepEqual(flagValues(argsOf(["Bash(git *)"]), "--allowedTools"), [
    "Bash(git *)",
  ]);

  // Nothing listed: the default four are pre-approved, nothing is withheld.
  assert.ok(!argsOf().includes("--tools"));
  assert.deepEqual(flagValues(argsOf(), "--allowedTools"), [
    "Read",
    "Edit",
    "Write",
    "Bash",
  ]);

  // `[]` = nothing pre-approved: the flag is left out (a bare `--allowedTools`
  // exits before any model turn) and nothing is withheld either.
  const none = argsOf([]);
  assert.ok(!none.includes("--allowedTools"));
  assert.ok(!none.includes("--tools"));
});

test("buildClaudeArgs: tools alone says which tools exist and approves no more than the default four", () => {
  const args = buildClaudeArgs(
    { model: scriptModel([]), tools: ["Read", "Write"] },
    false,
  );
  assert.deepEqual(flagValues(args, "--tools"), ["Read,Write"]);
  assert.deepEqual(flagValues(args, "--allowedTools"), [
    "Read",
    "Edit",
    "Write",
    "Bash",
  ]);

  // Both fields: independent flags, each its own list.
  const both = buildClaudeArgs(
    {
      model: scriptModel([]),
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
    },
    false,
  );
  assert.deepEqual(flagValues(both, "--tools"), ["Read,Bash"]);
  assert.deepEqual(flagValues(both, "--allowedTools"), ["Read"]);

  // The builder alone: `[]` is `--tools ""` = no tools. runHarnessTest refuses it.
  assert.deepEqual(
    flagValues(
      buildClaudeArgs({ model: scriptModel([]), tools: [] }, false),
      "--tools",
    ),
    [""],
  );
});

test("toolAvailabilityList: bare names are deduped, a permission rule is refused", () => {
  assert.deepEqual(toolAvailabilityList(["Read", "Bash", "Read", " Write "]), [
    "Read",
    "Bash",
    "Write",
  ]);
  assert.deepEqual(toolAvailabilityList([]), []);
  // `--tools "Bash(git *)"` makes the CLI offer nothing (measured on 2.1.292), and
  // quietly reducing it to `Bash` would offer more than the author wrote. The
  // rule belongs in allowedTools; tools takes names.
  assert.throws(
    () => toolAvailabilityList(["Read", "Bash(git *)"]),
    /tools takes bare tool names, and "Bash\(git \*\)" is a permission rule — put the rule in allowedTools and the name \("Bash"\) in tools/,
  );
});

test("runHarnessTest refuses a permission rule in tools", async () => {
  await assert.rejects(
    runHarnessTest({
      sandbox: false,
      tools: ["Bash(git *)"],
      model: [{ text: "done" }],
    }),
    /tools takes bare tool names/,
  );
});

test("warnUnconsumed: says so on stderr when the classifier swallowed the run, and only then", () => {
  const lines: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((m) => {
    lines.push(m);
  });
  try {
    warnUnconsumed(3, 2); // the normal case: turns were served
    assert.deepEqual(lines, []);
    warnUnconsumed(0, 4); // side-channel calls only: the script was never consumed
    assert.equal(lines.length, 1);
    assert.match(String(lines[0]), /side-channel/);
  } finally {
    spy.mockRestore();
  }
});

test("unsupportedToolsFlag: names the cause when claude predates --tools", () => {
  const message = unsupportedToolsFlag("error: unknown option '--tools'\n");
  assert.match(message ?? "", /2\.0\.31 or newer/);
  assert.match(message ?? "", /`tools`/);
  assert.equal(unsupportedToolsFlag("some other failure"), undefined);
  assert.equal(unsupportedToolsFlag(""), undefined);
});

test("tools of blank names is refused like tools: []", async () => {
  await assert.rejects(
    runHarnessTest({
      sandbox: false,
      tools: ["", "  "],
      model: [{ text: "done" }],
    }),
    /leaves the agent with no tools/,
  );
});

test("tools: [] is refused — a tool-less agent is never served a script turn", async () => {
  await assert.rejects(
    runHarnessTest({
      sandbox: false,
      tools: [],
      model: [{ text: "done" }],
    }),
    /tools: \[\] leaves the agent with no tools/,
  );
});

// A scripted call to a tool that does not EXIST in the run cannot pass silently:
// the CLI answers it "No such tool available" and the test would go on over a
// step that never happened.
test("unofferedScriptedTool: names the tool, the turn and what exists", () => {
  const model = [
    { tool: "Read", input: {} },
    { tool: "Skill", input: {} },
  ];
  assert.equal(
    unofferedScriptedTool(model, ["Read", "Bash"]),
    'scripted call to "Skill" on turn 2, but this run\'s tools are only: Read, Bash — add it to tools',
  );
  // MCP tools are not withheld by --tools, so the pre-flight skips them.
  assert.equal(
    unofferedScriptedTool([{ tool: "mcp__srv__t" }, { text: "x" }], ["Read"]),
    undefined,
  );
  // No `tools`: every tool exists, so nothing can be unoffered.
  assert.equal(unofferedScriptedTool(model, undefined), undefined);
});

test("runHarnessTest refuses a script that calls a tool the explicit `tools` leaves out", async () => {
  await assert.rejects(
    runHarnessTest({
      sandbox: false,
      tools: ["Read", "Bash"],
      model: [{ tool: "Skill", input: { skill: "demo" } }, { text: "done" }],
    }),
    /scripted call to "Skill" on turn 1, but this run's tools are only: Read, Bash — add it to tools/,
  );
});

// A scripted call to a tool the CLI does not know comes back as an error result
// and the run exits 0, so a test that asserts "it errored and left no side effect"
// passes on a typo. The runner reads the answer off the requests the agent sent
// back to the model.
test("noSuchToolMessage: names the tool and the turn, suggests a typo, and only then", () => {
  const model = [
    { tool: "Read", input: {} },
    { tool: "Bsh", input: {} },
  ];
  const answered = (text: string, sideChannel?: boolean) => ({
    system: "",
    messages: [{ role: "user", text }],
    ...(sideChannel === true ? { sideChannel } : {}),
  });
  const typo =
    "<tool_use_error>Error: No such tool available: Bsh</tool_use_error>";
  const message = noSuchToolMessage(model, [
    answered("go"),
    answered("fine"),
    answered(typo),
  ]);
  assert.match(message ?? "", /scripted call to "Bsh" on turn 2/);
  assert.match(message ?? "", /No such tool available: Bsh/);
  assert.match(message ?? "", /typo/);
  // The mcp__ name is reported the same way, whatever `tools` says.
  assert.match(
    noSuchToolMessage(
      [{ tool: "mcp__nosuch__t" }],
      [
        answered(
          "<tool_use_error>Error: No such tool available: mcp__nosuch__t</tool_use_error>",
        ),
      ],
    ) ?? "",
    /scripted call to "mcp__nosuch__t" on turn 1/,
  );
  // Only the CLI's own error for a name the script calls counts: the agent here
  // calls tools only from the script, so the same words anywhere else (the prompt,
  // a hook's injected text, an unscripted name) are not a result of this run.
  assert.equal(noSuchToolMessage([], [answered(typo)]), undefined);
  assert.equal(
    noSuchToolMessage(model, [
      answered("why does it say No such tool available: Bsh"),
    ]),
    undefined,
  );
  // Nothing wrong: no message. A bookkeeping (side-channel) request that merely
  // quotes the text is not the agent's own result.
  assert.equal(
    noSuchToolMessage(model, [answered("ok"), answered("ok")]),
    undefined,
  );
  assert.equal(noSuchToolMessage(model, [answered(typo, true)]), undefined);
  assert.equal(noSuchToolMessage(model, []), undefined);
});

maybe(
  "a scripted call to a tool the CLI does not know fails the run, not just the call",
  async () => {
    await assert.rejects(
      runHarnessTest({
        sandbox: false,
        allowedTools: ["Read", "Write"],
        model: [
          { tool: "Bsh", input: { command: "touch DENIED-PROBE" } },
          { text: "done" },
        ],
        timeoutMs: 120000,
      }),
      /scripted call to "Bsh" on turn 1: .*No such tool available: Bsh.*typo/,
    );
  },
);

maybe(
  "an mcp__ tool that does not exist fails the run even with an explicit tools list",
  async () => {
    await assert.rejects(
      runHarnessTest({
        sandbox: false,
        tools: ["Read"],
        model: [{ tool: "mcp__nosuch__t", input: {} }, { text: "done" }],
        timeoutMs: 120000,
      }),
      /scripted call to "mcp__nosuch__t" on turn 1/,
    );
  },
);

// (a) The consumer's permission-containment case. `allowedTools` lists what is
// pre-approved; Bash EXISTS but is not approved, so the CLI refuses the call for
// permission. Asserted on the structure of the run: the call was dispatched
// (Bash is in the session's tool list and in the transcript), came back as an
// error that is not "No such tool", and its side effect never happened.
maybe(
  "allowedTools: a tool that exists but is not approved is refused for permission",
  async () => {
    const r = await runHarnessTest({
      sandbox: false,
      transcript: true,
      allowedTools: ["Read", "Write"], // Bash exists, but is not approved
      model: [
        { tool: "Bash", input: { command: "touch DENIED-PROBE" } },
        { text: "done" },
      ],
      timeoutMs: 120000,
    });
    try {
      const session = /"subtype":"init".*?"tools":\[([^\]]*)\]/.exec(
        r.stdout,
      )?.[1];
      assert.match(session ?? "", /"Bash"/, "Bash exists in the session");
      const bash = r.toolCalls.find((c) => c.name === "Bash");
      assert.ok(bash, "the Bash call reached the CLI");
      assert.equal(bash.isError, true, bash.resultText);
      assert.doesNotMatch(bash.resultText, /no such tool/i);
      // The refusal's wording differs by CLI version: 2.1.294 says "needs
      // approval", 2.1.187 (the CI pin) says "was blocked. For security …".
      // Either is a refusal; the structure above and below is what is asserted.
      assert.match(bash.resultText, /needs approval|permission|was blocked/i);
      assert.equal(
        r.file("DENIED-PROBE"),
        null,
        "the refused call left no file",
      );
    } finally {
      r.cleanup();
    }
  },
);

// `allowedTools: []` = nothing pre-approved (not "no tools"): every tool exists
// and any call that needs approval is refused. Legitimate, and 34.x allowed it.
maybe(
  "allowedTools: [] pre-approves nothing and the run still proceeds",
  async () => {
    const r = await runHarnessTest({
      sandbox: false,
      transcript: true,
      allowedTools: [],
      model: [
        { tool: "Bash", input: { command: "touch DENIED-PROBE" } },
        { text: "done" },
      ],
      timeoutMs: 120000,
    });
    try {
      const bash = r.toolCalls.find((c) => c.name === "Bash");
      assert.ok(bash, "the Bash call reached the CLI");
      assert.equal(bash.isError, true, bash.resultText);
      assert.equal(r.file("DENIED-PROBE"), null);
    } finally {
      r.cleanup();
    }
  },
);

maybe("allowedTools keeps a permission rule's tool usable", async () => {
  const r = await runHarnessTest({
    sandbox: false,
    transcript: true,
    allowedTools: ["Bash(touch *)"],
    model: [{ tool: "Bash", input: { command: "touch OK" } }, { text: "done" }],
    timeoutMs: 120000,
  });
  try {
    assert.ok(r.toolCalls.some((c) => c.name === "Bash"));
    assert.notEqual(r.file("OK"), null, "the approved Bash call ran");
  } finally {
    r.cleanup();
  }
});

// (c) `tools` is the availability list: a tool left out does not exist, and the
// real session's own tool list is the proof.
maybe("tools: the session offers exactly those tools", async () => {
  const r = await runHarnessTest({
    sandbox: false,
    transcript: true,
    tools: ["Read", "Write"], // Bash deliberately absent
    model: [{ text: "done" }],
    timeoutMs: 120000,
  });
  try {
    const tools = /"subtype":"init".*?"tools":\[([^\]]*)\]/.exec(r.stdout)?.[1];
    assert.equal(tools, '"Read","Write"');
  } finally {
    r.cleanup();
  }
});

// With neither field every tool exists: a scripted Skill call launches the skill
// instead of coming back as "No such tool available".
maybe("with no tools a scripted Skill call launches the skill", async () => {
  const r = await runHarnessTest({
    sandbox: false,
    transcript: true,
    pluginDir: join(__dirname, "../examples/harness/fixture-skill-plugin"),
    settings: { permissions: { allow: ["Skill"] } },
    model: [
      { tool: "Skill", input: { skill: "demo:greet" } },
      { text: "done" },
    ],
    timeoutMs: 120000,
  });
  try {
    const skill = r.toolCalls.find((c) => c.name === "Skill");
    assert.ok(skill, "the Skill call reached the CLI");
    assert.doesNotMatch(skill.resultText, /no such tool/i);
    assert.equal(skill.isError, false, skill.resultText);
  } finally {
    r.cleanup();
  }
});

// Regression: a PostToolUse hook fires on an Edit/Write tool use. This is the
// deterministic-tier capability a stale comment once said was impossible; the
// 2026-06-09 spike showed it firing 3/3, so we lock it in.
maybe("a PostToolUse hook fires on an Edit/Write tool use", async () => {
  const r = await runHarnessTest({
    settings: {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              {
                // `{cwd}` is substituted with the sandbox dir (hooks may run
                // elsewhere); the marker proves the hook fired.
                type: "command",
                command: "echo FIRED >> {cwd}/hook.log",
              },
            ],
          },
        ],
      },
    },
    transcript: true, // capture the stream so r.hooks records the firing
    model: scriptModel([
      { tool: "Write", input: { file_path: "hello.txt", content: "banana" } },
      { text: "done" },
    ]),
    // No custom `prompt`: a non-default prompt makes the mocked turn no-op here,
    // so the scripted Write never runs. The default ("go") is reliable (5/5).
    timeoutMs: 90000,
  });
  try {
    assert.equal(r.file("hello.txt"), "banana", "the Write tool ran");
    assert.match(
      r.file("hook.log") ?? "",
      /FIRED/,
      "the Write|Edit PostToolUse hook fired",
    );
    // The marker IS the verification here: the hook wrote it, so it ran. We do
    // NOT also assert via the stream (`assertHookFired`) because Claude Code does
    // not emit `hook_response` stream events for Edit/Write tool hooks in headless
    // mode — see CLAUDE.md ("NOT Edit/Write tool events (headless-gated)"). It
    // works headed (local) but not in CI, so the stream check is unreliable for
    // these tools; the marker (a real file the hook wrote) is the honest signal.
  } finally {
    r.cleanup();
  }
});

// Regression: a PreToolUse hook can BLOCK an Edit (exit 2) so the edit never
// applies — the governance shape, on the edit tools, in the deterministic tier.
// The mock must Read the file before editing (Claude Code requires a prior read,
// else the Edit never attempts and the hook never fires); the marker proves the
// hook actually ran, so "file unchanged" can't pass trivially via a no-op.
maybe("a PreToolUse hook blocks an Edit tool use", async () => {
  const r = await runHarnessTest({
    files: { "note.txt": "old" },
    settings: {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "echo BLOCKED >> {cwd}/pre.log; exit 2",
              },
            ],
          },
        ],
      },
    },
    transcript: true, // capture the stream so r.hooks records the block decision
    model: scriptModel([
      { tool: "Read", input: { file_path: "note.txt" } },
      {
        tool: "Edit",
        input: { file_path: "note.txt", old_string: "old", new_string: "new" },
      },
      { text: "done" },
    ]),
    timeoutMs: 90000,
  });
  try {
    assert.match(
      r.file("pre.log") ?? "",
      /BLOCKED/,
      "the PreToolUse Edit hook actually fired",
    );
    assert.equal(
      r.file("note.txt"),
      "old",
      "the PreToolUse hook blocked the edit (file unchanged)",
    );
    // Verification = the marker (BLOCKED was written, so the hook ran) + the
    // effect (file unchanged, so it actually blocked). We do NOT also assert via
    // the stream (`assertHookFired`): Claude Code doesn't emit `hook_response`
    // stream events for Edit tool hooks headless (CLAUDE.md: "Edit/Write …
    // headless-gated"), so it's reliable headed/local but empty in CI. The marker
    // proves firing without depending on the headless-gated stream.
  } finally {
    r.cleanup();
  }
});

maybe("a blocking Stop hook forces the agent to keep working", async () => {
  // The Stop hook blocks completion until a DONE file exists; the scripted
  // agent creates it on the second turn, so the run must take >1 turn.
  const r = await runHarnessTest({
    settings: {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "test -f DONE || { echo 'not done yet' >&2; exit 2; }",
              },
            ],
          },
        ],
      },
    },
    model: scriptModel([
      { text: "I think I'm done" }, // tries to stop → blocked (no DONE)
      { tool: "Bash", input: { command: "touch DONE" } }, // then creates DONE
      { text: "now actually done" },
    ]),
    prompt: "finish the task",
    timeoutMs: 90000,
  });
  try {
    let numTurns = 0;
    try {
      numTurns =
        (JSON.parse(r.stdout) as { num_turns?: number }).num_turns ?? 0;
    } catch {
      /* ignore */
    }
    assert.ok(r.file("DONE") !== null, "agent eventually created DONE");
    assert.ok(
      numTurns > 1,
      `Stop hook should force >1 turn, got ${String(numTurns)}`,
    );
  } finally {
    r.cleanup();
  }
});

// Skill-wiring: a plugin installed natively via `--plugin-dir` registers its
// skills, so a scripted `Skill` tool_use RESOLVES (the skill body is injected) —
// deterministic, no real model. This is the wiring tier for skills; whether the
// model *chooses* a skill is the eval tier. (File-materialization does NOT
// register skills — only --plugin-dir does — see research/harness-testing-coverage-matrix.md.)
maybe(
  "a plugin skill installed via --plugin-dir resolves through the Skill tool",
  async () => {
    // __dirname is dist/ at runtime; the fixture lives at the repo root.
    const pluginDir = join(
      __dirname,
      "../examples/harness/fixture-skill-plugin",
    );
    const r = await runHarnessTest({
      pluginDir,
      sandbox: false, // in-repo fixture we authored → trusted, run direct
      allowedTools: ["Read", "Edit", "Write", "Bash", "Skill"],
      transcript: true, // populate r.toolCalls
      model: scriptModel([
        { tool: "Skill", input: { skill: "demo:greet" } },
        { text: "ok" },
      ]),
      timeoutMs: 90000,
    });
    try {
      // The action invariant — vs the brittle `r.stdout.includes(MARKER)` this
      // replaces. assertSkillResolved checks a non-error Skill tool_use by name.
      assertToolUsed(r, "Skill");
      assertSkillResolved(r, "demo:greet");
      assertToolNotUsed(r, /^mcp__/); // safety negative: no MCP tool was used
    } finally {
      r.cleanup();
    }
  },
);

// Grounded in REAL vendored plugins — the payoff of toolCalls: you can assert a
// real plugin's skill activates with NO marker injected into it (marker-grep only
// works on fixtures you control). Both skills resolve via --plugin-dir.
for (const [label, dir, skill] of [
  [
    "obra/superpowers",
    "../test/dogfood/superpowers@6fd4507",
    "superpowers:test-driven-development",
  ],
  [
    "wshobson/agents",
    "../test/dogfood/wshobson-accessibility@cf6059d",
    "accessibility-compliance:wcag-audit-patterns",
  ],
] as const) {
  maybe(`a real ${label} skill resolves via --plugin-dir`, async () => {
    const r = await runHarnessTest({
      pluginDir: join(__dirname, dir),
      sandbox: false, // pinned vendored plugin we audited → trusted, run direct
      allowedTools: ["Read", "Edit", "Write", "Bash", "Skill"],
      transcript: true,
      model: scriptModel([{ tool: "Skill", input: { skill } }, { text: "ok" }]),
      timeoutMs: 120000,
    });
    try {
      assertSkillResolved(r, skill); // no marker needed — it's a real plugin
    } finally {
      r.cleanup();
    }
  });
}

// Sequence / budget invariants over a REAL run: the agent reads then edits, and
// we assert the workflow — ordering ("Read before Edit", the rule Claude enforces),
// a budget ("≤ 1 Edit, 0 Writes"), and a custom invariant.
maybe("tool-call sequence + budget invariants hold on a real run", async () => {
  const r = await runHarnessTest({
    files: { "note.txt": "old" },
    allowedTools: ["Read", "Edit", "Write", "Bash"],
    transcript: true,
    model: scriptModel([
      { tool: "Read", input: { file_path: "note.txt" } },
      {
        tool: "Edit",
        input: { file_path: "note.txt", old_string: "old", new_string: "new" },
      },
      { text: "done" },
    ]),
    timeoutMs: 90000,
  });
  try {
    assertToolSequence(r, ["Read", "Edit"]); // ordering
    assertToolCount(r, "Edit", { max: 1 }); // budget
    assertToolCount(r, "Write", { exactly: 0 });
    // tool-ARGUMENT invariant: the Edit targeted the right file (not just "an Edit ran")
    assertToolUsedWith(
      r,
      "Edit",
      (i) => (i as { file_path?: string }).file_path === "note.txt",
    );
    assert.equal(typeof r.output, "string"); // unified Trace: final answer captured
    assertToolCalls(
      r,
      (calls) => {
        // every Edit was preceded by a Read
        let read = false;
        for (const c of calls) {
          if (c.name === "Read") read = true;
          if (c.name === "Edit" && !read) return false;
        }
        return true;
      },
      "an Edit happened before any Read",
    );
  } finally {
    r.cleanup();
  }
});

test("parseToolCalls: pairs tool_use with tool_result from a stream-json transcript", () => {
  const stream = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Skill",
            input: { skill: "x:y" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ran" }],
      },
    }),
    "not json — ignored",
    JSON.stringify({ type: "result", result: "done" }),
  ].join("\n");
  const calls = parseToolCalls(stream);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "Skill");
  assert.equal(calls[0]?.resultText, "ran");
  assert.equal(calls[0]?.isError, false);
  assert.equal(parseToolCalls("{not stream json}").length, 0);
});

test("parseToolCalls: covers id / content-shape / error / no-result branches", () => {
  const stream = [
    "", // blank line skipped
    "not json — ignored", // parse error skipped
    JSON.stringify({ type: "x", message: { content: "notarray" } }), // content not an array
    JSON.stringify({
      type: "a",
      message: {
        content: [
          { type: "text", text: "prose" }, // neither tool_use nor tool_result
          { type: "tool_use", id: "u1", name: "A", input: {} },
          { type: "tool_use", input: {} }, // tool_use with no name → skipped
          { type: "tool_use", name: "NoId", input: {} }, // tool_use with no id
          { type: "tool_use", id: "u3", name: "C", input: {} },
        ],
      },
    }),
    JSON.stringify({
      type: "u",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "u1",
            content: "plain",
            is_error: true,
          },
          { type: "tool_result", content: ["x", { text: "y" }, { z: 1 }] }, // no id; array w/ string + text + no-text
          { type: "tool_result", tool_use_id: "u3", content: 42 }, // non-string, non-array content
        ],
      },
    }),
  ].join("\n");
  const calls = parseToolCalls(stream);
  assert.equal(calls.length, 3); // A, NoId, C (the no-name tool_use is skipped)
  const a = calls.find((c) => c.name === "A");
  assert.equal(a?.resultText, "plain"); // string content
  assert.equal(a?.isError, true);
  // The no-id tool_use and the no-id tool_result both key on "" and so pair up;
  // the array content ["x", {text:"y"}, {no text}] joins to "xy".
  const noid = calls.find((c) => c.name === "NoId");
  assert.equal(noid?.resultText, "xy");
  assert.equal(noid?.isError, false);
  const c = calls.find((c) => c.name === "C");
  assert.equal(c?.resultText, ""); // non-string/array content (42) → ""
});

test("parseOutput: returns the final answer from the terminal result event", () => {
  const stream = [
    "", // blank line → skipped
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    "not json — ignored",
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "the answer",
    }),
  ].join("\n");
  assert.equal(parseOutput(stream), "the answer");
  // a result event whose `result` is non-string → ""
  assert.equal(parseOutput(JSON.stringify({ type: "result", result: 42 })), "");
  // single-object `--output-format json` carries the same {type:"result"} shape
  assert.equal(
    parseOutput(JSON.stringify({ type: "result", result: "x" })),
    "x",
  );
  assert.equal(parseOutput("no result event here"), "");
});

test("parseHooks: records hook firing + block decision from stream events", () => {
  const stream = [
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "PostToolUse:Bash",
      hook_event: "PostToolUse",
      exit_code: 0,
      outcome: "success",
      output: "POST_OK\n",
    }),
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "PreToolUse:Edit",
      hook_event: "PreToolUse",
      exit_code: 2,
      outcome: "error",
      output: "BLOCKED\n",
    }),
    JSON.stringify({ type: "assistant", message: { content: [] } }), // ignored
  ].join("\n");
  const hooks = parseHooks(stream);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0]?.name, "PostToolUse:Bash");
  assert.equal(hooks[0]?.blocked, false);
  assert.equal(hooks[1]?.event, "PreToolUse");
  assert.equal(hooks[1]?.exitCode, 2);
  assert.equal(hooks[1]?.blocked, true);
  assert.equal(parseHooks("{not stream json}").length, 0);
});

test("parseHooks: defensive field coercion + the block decision branches", () => {
  const stream = [
    // outcome success but a non-zero exit → blocked via the exit-code arm
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "Stop",
      hook_event: "Stop",
      exit_code: 1,
      outcome: "success",
      output: "x",
    }),
    // malformed: non-number exit_code, missing name/event/output → coerced
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      exit_code: "nope",
    }),
    // a non-hook_response system event → skipped
    JSON.stringify({ type: "system", subtype: "init" }),
  ].join("\n");
  const hooks = parseHooks(stream);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0]?.blocked, true); // success + exit 1 → blocked
  assert.equal(hooks[1]?.exitCode, undefined); // non-number → undefined
  assert.equal(hooks[1]?.name, ""); // missing → ""
  assert.equal(hooks[1]?.event, ""); // missing → ""
  assert.equal(hooks[1]?.output, ""); // missing → ""
  assert.equal(hooks[1]?.blocked, false); // not error, no numeric exit
});

// --- the spawn env of a harness-tier run ------------------------------------
// A made-up harness on purpose: the runner applies whatever identity and auth
// the runtime declares, and knows no harness by name.

import { harnessSpawnEnv } from "./harness-test.js";
import type { HarnessRuntime } from "./core/runtime.js";

const acmeRuntime: HarnessRuntime = {
  name: "acme",
  agentBinary: "acme",
  modelBaseUrlEnv: "ACME_BASE_URL",
  modelApiKeyEnv: "ACME_KEY",
  mockApiKey: "dummy",
  wireMock: (url) => ({
    args: [],
    env: { ACME_BASE_URL: url, ACME_KEY: "dummy" },
  }),
  versionKey: () => "",
  runEnv: {
    keep: ["ACME_TOKEN"],
    keepHomeFiles: [],
    sessionIdentity: ["ACME_SESSION_ID"],
  },
};
const callerEnv = {
  HOME: "/home/real",
  PATH: "/bin",
  GH_TOKEN: "ghp_x",
  ACME_TOKEN: "real-auth",
  ACME_SESSION_ID: "parent-session",
};
const wired = acmeRuntime.wireMock("http://127.0.0.1:1");

test("harnessSpawnEnv (inherited): the caller's env minus the runtime's session identity, plus the mock wiring", () => {
  const env = harnessSpawnEnv(
    acmeRuntime,
    wired.env,
    { home: "inherit" },
    callerEnv,
  );
  assert.equal(env.ACME_SESSION_ID, undefined);
  assert.equal(env.HOME, "/home/real");
  assert.equal(env.GH_TOKEN, "ghp_x");
  assert.equal(env.ACME_BASE_URL, "http://127.0.0.1:1");
});

test("harnessSpawnEnv (throwaway HOME): OS essentials + mock wiring only — no harness auth, no identity, no secrets", () => {
  const env = harnessSpawnEnv(
    acmeRuntime,
    wired.env,
    { home: "throwaway", dir: "/tmp/fresh" },
    callerEnv,
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/tmp/fresh",
    TMPDIR: "/tmp/fresh",
    ACME_BASE_URL: "http://127.0.0.1:1",
    ACME_KEY: "dummy",
  });
});
