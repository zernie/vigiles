/**
 * Tests for the scripted Anthropic mock (src/mock-model.ts). The mock is an
 * in-process HTTP server, so its full behaviour — SSE vs JSON turns, tool vs
 * text turns, count_tokens / HEAD / health tolerance, the onTurn probe, and the
 * last-turn-repeat / empty-script defaults — is testable directly, no claude.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  startMock,
  scriptModel,
  extractRequest,
  isMainLoopRequest,
  scriptUnconsumedWarning,
  splitRequestCounts,
  type TurnInfo,
} from "./mock-model.js";

/**
 * POST an AGENT-LOOP request — one that declares tools, which is how the mock
 * tells the agent's own turn from the CLI's side-channel calls (see
 * `isMainLoopRequest`). MEASURED on Claude Code 2.1.228: every main-loop request
 * carries ~40 tool definitions and every side-channel one carries none, and
 * `--allowedTools` does not shrink that array (it is a permission allowlist, not
 * a tool-definition filter). A hand-built request with NO tools is not what the
 * agent sends — pretending otherwise is the fixture-realism gap that let the
 * side channel eat script entries unnoticed.
 */
const post = (url: string, body: object): Promise<Response> =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ tools: [{ name: "Bash" }], ...body }),
  });

/** POST a SIDE-CHANNEL request — the CLI's own bookkeeping call: no tools. */
const postSideChannel = (url: string, body: object): Promise<Response> =>
  fetch(`${url}/v1/messages`, { method: "POST", body: JSON.stringify(body) });

interface MsgBlock {
  type?: string;
  text?: string;
  input?: unknown;
}
interface MsgResponse {
  content?: MsgBlock[];
  stop_reason?: string;
  model?: string;
}
const readMsg = async (r: Response): Promise<MsgResponse> =>
  (await r.json()) as MsgResponse;

test("startMock: SSE and JSON turns, tool and text, count/HEAD/health, onTurn", async () => {
  const seen: TurnInfo[] = [];
  // Two mocks so all four (stream|json) × (tool|text) combinations are exercised.
  const streamMock = await startMock(
    scriptModel([
      { tool: "Bash", input: { command: "ls" } },
      { text: "all done" },
      { tool: "NoInput" }, // tool turn with no input → `turn.input ?? {}`
      {}, // turn with neither tool nor text → `turn.text ?? ""`
    ]),
    { onTurn: (info) => seen.push(info) },
  );
  try {
    // turn 0: streaming tool turn → streamTurn (tool branch)
    const sse = await (
      await post(streamMock.url, {
        stream: true,
        model: "m",
        messages: [{ content: "go" }],
      })
    ).text();
    assert.match(sse, /"type":"tool_use"/);
    assert.match(sse, /"name":"Bash"/);
    // turn 1: streaming text turn → streamTurn (text branch); a tool_result in
    // the request exercises the onTurn hasToolResult probe.
    const sse2 = await (
      await post(streamMock.url, {
        stream: true,
        messages: [{ content: [{ type: "tool_result", content: "x" }] }],
      })
    ).text();
    assert.match(sse2, /"text_delta"/);
    assert.match(sse2, /all done/);
    // turns 2 & 3: streaming tool turn with no input, then a no-text turn —
    // exercising the `turn.input ?? {}` / `turn.text ?? ""` defaults.
    assert.match(
      await (
        await post(streamMock.url, {
          stream: true,
          messages: [{ content: "x" }],
        })
      ).text(),
      /"name":"NoInput"/,
    );
    assert.match(
      await (
        await post(streamMock.url, {
          stream: true,
          messages: [{ content: "x" }],
        })
      ).text(),
      /message_stop/,
    );

    // count_tokens (else Claude Code hangs)
    const counted = (await (
      await fetch(`${streamMock.url}/v1/messages/count_tokens`, {
        method: "POST",
        body: "{}",
      })
    ).json()) as unknown;
    assert.deepEqual(counted, { input_tokens: 10 });

    // HEAD + a non-messages health GET both return {}
    assert.equal(
      (await fetch(`${streamMock.url}/v1/messages`, { method: "HEAD" })).status,
      200,
    );
    assert.deepEqual(
      (await (await fetch(`${streamMock.url}/health`)).json()) as unknown,
      {},
    );

    assert.equal(seen[0]?.stream, true);
    assert.equal(seen[1]?.hasToolResult, true);
    assert.ok(streamMock.count >= 2);
  } finally {
    streamMock.close();
  }

  const jsonMock = await startMock(
    scriptModel([
      { tool: "Bash", input: { command: "ls" } },
      { text: "ok" },
      { tool: "NoInput" }, // tool turn with no input → `turn.input ?? {}`
    ]),
  );
  try {
    // turn 0: non-streaming tool turn → jsonTurn (tool branch)
    const tool = await readMsg(
      await post(jsonMock.url, { messages: [{ content: "go" }] }),
    );
    assert.equal(tool.content?.[0]?.type, "tool_use");
    assert.equal(tool.stop_reason, "tool_use");
    // turn 1: non-streaming text turn (no model → default echo) → jsonTurn (text)
    const txt = await readMsg(
      await post(jsonMock.url, { messages: [{ content: "go" }] }),
    );
    assert.equal(txt.content?.[0]?.text, "ok");
    assert.equal(txt.model, "claude-mock");
    // turn 2: non-streaming tool turn with no input → `turn.input ?? {}`
    const noInput = await readMsg(
      await post(jsonMock.url, { messages: [{ content: "go" }] }),
    );
    assert.deepEqual(noInput.content?.[0]?.input, {});
  } finally {
    jsonMock.close();
  }
});

test("extractRequest: flattens system + messages, tolerates odd shapes", () => {
  // system as a string; message content as a string
  assert.deepEqual(
    extractRequest({
      system: "be brief",
      messages: [{ role: "user", content: "go" }],
    }),
    { system: "be brief", messages: [{ role: "user", text: "go" }] },
  );
  // system as a text-block array; content as a block array (text + non-text)
  assert.deepEqual(
    extractRequest({
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
      ],
      messages: [
        {
          role: "user",
          content: [
            "raw",
            { type: "text", text: "C" },
            // REGRESSION GUARD 2026-09-10. This line used to read
            // `content: "ignored"` with the comment "no `text` → \"\"", i.e. the
            // blind spot was asserted as INTENDED — which is why no run could
            // ever find it. A PostToolUse hook's additionalContext arrives here
            // from Claude Code >= 2.1.228; dropping it made every delivery test
            // report a false negative. See `flattenBlock` in mock-model.ts.
            { type: "tool_result", content: "SEEN" },
            // A block type the pinned SDK union does not know: over-included as
            // JSON, never silently dropped (the same asymmetry, asserted).
            { type: "future_block_from_a_newer_api", payload: "LOUD" },
          ],
        },
      ],
    }),
    {
      system: "AB",
      messages: [
        {
          role: "user",
          text: 'rawCSEEN{"type":"future_block_from_a_newer_api","payload":"LOUD"}',
        },
      ],
    },
  );
  // The REST of the union, so no branch of the exhaustive switch in
  // `flattenBlock` is one only tsc has ever seen. Coverage is the point: a case
  // that no run exercises is a case whose behaviour nobody has checked, and this
  // function's whole defect was a family of blocks silently flattening to "".
  //   - `thinking` IS context the model was given → its text counts;
  //   - `document` contributes its human-readable title/context, and one with
  //     neither contributes nothing (the filter's other branch);
  //   - `image` / `redacted_thinking` / `container_upload` carry no text;
  //   - `tool_use` is the model's OWN call, not context delivered TO it, so a
  //     needle in a tool ARGUMENT must never read as "the model was told this".
  //     That exclusion is deliberate and asserted here, not merely commented.
  assert.deepEqual(
    extractRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "THOUGHT" },
            { type: "document", title: "TITLE", context: "CTX" },
            // Its text lives under `source`, not beside it.
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: "BODY" },
            },
            // A base64 source is bytes: skipped, or every real match drowns.
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "BLOB" },
            },
            { type: "image" },
            { type: "redacted_thinking" },
            { type: "container_upload" },
            { type: "tool_use", input: { needle: "NOT-CONTEXT" } },
          ],
        },
      ],
    }),
    {
      system: "",
      messages: [{ role: "assistant", text: "THOUGHTTITLECTXBODY" }],
    },
  );
  // Six of the eight `*_tool_result` variants carry an OBJECT under `content`,
  // not a string or an array — the gap review found on this PR. Each shape puts
  // its text at a different key, so all of them are walked.
  assert.deepEqual(
    extractRequest({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "bash_code_execution_tool_result",
              content: {
                type: "bash_code_execution_result",
                stdout: "OUT",
                stderr: "ERR",
                return_code: 0,
                content: [],
              },
            },
            {
              type: "web_fetch_tool_result",
              content: {
                type: "web_fetch_result",
                url: "https://e.example/x",
                content: {
                  type: "document",
                  source: {
                    type: "text",
                    media_type: "text/plain",
                    data: "FETCHED",
                  },
                },
              },
            },
            // A number is neither text nor a container: contributes nothing.
            { type: "tool_result", content: 7 as unknown },
          ],
        },
      ],
    }),
    {
      system: "",
      messages: [
        // `return_code: 0` contributes nothing — a number is not text.
        { role: "user", text: "OUTERRhttps://e.example/xFETCHED" },
      ],
    },
  );
  // missing system → ""; missing role → ""; non-array messages → []
  assert.deepEqual(extractRequest({ messages: [{ content: "x" }] }), {
    system: "",
    messages: [{ role: "", text: "x" }],
  });
  assert.deepEqual(extractRequest({}), { system: "", messages: [] });
  assert.deepEqual(extractRequest({ messages: "nope" as unknown }), {
    system: "",
    messages: [],
  });
});

test("startMock: captures each request via handle.requests", async () => {
  const mock = await startMock(scriptModel([{ text: "ok" }]));
  try {
    await post(mock.url, {
      system: "You have superpowers",
      messages: [{ role: "user", content: "go" }],
    });
    // count_tokens / HEAD must NOT be recorded as model requests
    await fetch(`${mock.url}/v1/messages/count_tokens`, {
      method: "POST",
      body: "{}",
    });
    await fetch(`${mock.url}/v1/messages`, { method: "HEAD" });
    await post(mock.url, { messages: [{ role: "user", content: "again" }] });

    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0]?.system, "You have superpowers");
    assert.equal(mock.requests[0]?.messages[0]?.text, "go");
    assert.equal(mock.requests[1]?.messages[0]?.text, "again");
  } finally {
    mock.close();
  }
});

test("startMock: repeats the last turn and defaults an empty script", async () => {
  const repeat = await startMock(scriptModel([{ text: "only" }]));
  try {
    for (let i = 0; i < 2; i++) {
      const j = await readMsg(
        await post(repeat.url, { messages: [{ content: "x" }] }),
      );
      assert.equal(j.content?.[0]?.text, "only"); // 2nd call repeats the last turn
    }
  } finally {
    repeat.close();
  }

  const empty = await startMock(scriptModel([]));
  try {
    // empty script + no messages field → default { text: "" }
    const j = await readMsg(await post(empty.url, {}));
    assert.equal(j.content?.[0]?.text, "");
  } finally {
    empty.close();
  }
});

// ---------------------------------------------------------------------------
// The side channel must NOT eat the script.
//
// 🔴 MEASURED 2026-08-12, Claude Code 2.1.228, one `runHarnessTest` with a
// THREE-entry script: the mock served 27 requests — 9 main-loop and 18
// side-channel (two per turn, the second a retry because our text answer was not
// the JSON the CLI's notification classifier wanted). The mock handed the next
// script entry to whichever request arrived first, so entry #2 went to the
// classifier and the agent never saw it. `a blocking Stop hook forces the agent
// to keep working` failed locally as a direct result: the agent was never given
// the turn that creates DONE. After routing: 5 requests, 3 main-loop + 2
// side-channel, `turns` 27 → 3, and the test passes.
//
// This test is the pin. It fails if a side-channel request ever consumes a
// script entry again — the entries are ordered, so a stolen one shifts every
// answer after it.
// ---------------------------------------------------------------------------
test("startMock: a side-channel request never consumes a script entry", async () => {
  const mock = await startMock(scriptModel([{ text: "A" }, { text: "B" }]));
  try {
    // The side channel arrives FIRST — the ordering that stole entry #1.
    const side1 = await readMsg(
      await postSideChannel(mock.url, { messages: [{ content: "classify" }] }),
    );
    assert.notEqual(side1.content?.[0]?.text, "A", "the script was raided");
    assert.equal(side1.content?.[0]?.text, "{}"); // valid JSON, from outside the script

    // The agent's first turn still gets the FIRST entry.
    const main1 = await readMsg(
      await post(mock.url, { messages: [{ content: "go" }] }),
    );
    assert.equal(main1.content?.[0]?.text, "A");

    await postSideChannel(mock.url, { messages: [{ content: "classify" }] });

    // …and its second turn gets the SECOND, not a shifted one.
    const main2 = await readMsg(
      await post(mock.url, { messages: [{ content: "go on" }] }),
    );
    assert.equal(main2.content?.[0]?.text, "B");

    // `count` is the agent's turn count, not the CLI's HTTP-call count.
    assert.equal(mock.count, 2);
    assert.equal(mock.sideChannelCount, 2);
    // Every request is still RECORDED — routed, not hidden — and tagged, so a
    // future side channel shows up as a number instead of a shifted script.
    assert.equal(mock.requests.length, 4);
    assert.deepEqual(
      mock.requests.map((r) => r.sideChannel === true),
      [true, false, true, false],
    );
  } finally {
    mock.close();
  }
});

test("isMainLoopRequest: keys on the tool declarations, not on prompt text", () => {
  // Structural, so a reworded system prompt cannot silently reclassify a turn.
  assert.equal(isMainLoopRequest({ tools: [{ name: "Bash" }] }), true);
  assert.equal(isMainLoopRequest({}), false);
  assert.equal(isMainLoopRequest({ tools: [] }), false);
  assert.equal(isMainLoopRequest({ tools: "Bash" }), false);
});

test("scriptUnconsumedWarning: says so when the classifier swallowed the run", () => {
  // The stated residual risk of keying on `tools`: if a future main-loop request
  // ever arrives WITHOUT tool declarations, it is misrouted and the script is
  // never consumed — the agent would loop on `{}` forever. That failure is
  // otherwise silent, so it gets a line on stderr rather than a guess.
  assert.match(scriptUnconsumedWarning(0, 4) ?? "", /side-channel/);
  assert.equal(scriptUnconsumedWarning(3, 2), undefined); // the normal case
  assert.equal(scriptUnconsumedWarning(0, 0), undefined); // nothing ran at all
});

test("splitRequestCounts: recovers the handle's split from the tags alone", () => {
  // A sandboxed run leaves the mock in another process, so `count` /
  // `sideChannelCount` have to be rebuilt from the tagged request log. Same
  // numbers, or `Trace.turns` means one thing direct and another sandboxed.
  const main = { system: "", messages: [] };
  const side = { ...main, sideChannel: true };
  assert.deepEqual(splitRequestCounts([]), { count: 0, sideChannelCount: 0 });
  assert.deepEqual(splitRequestCounts([side, main, side, main]), {
    count: 2,
    sideChannelCount: 2,
  });
  // Nothing BUT side channel — the shape `scriptUnconsumedWarning` names, which
  // the sandbox path can only reach through this split.
  assert.deepEqual(splitRequestCounts([side, side]), {
    count: 0,
    sideChannelCount: 2,
  });
});
