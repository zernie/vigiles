/**
 * Tests for the codex OpenAI-Responses mock — EXPERIMENTAL, internal-only.
 *
 * Pure unit tests cover the proven SSE renderer + the Responses request parser.
 * A GATED integration test runs REAL `codex exec` against the mock (over the
 * proven `-c model_providers.mock.*` keyless recipe) and proves a turn
 * completes — it runs when `codex` is on PATH, skips cleanly otherwise.
 */
import { test, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderResponsesSSE,
  parseResponsesRequest,
  startCodexMock,
} from "./mock-model.js";
import { codexMockArgs, codexMockEnv, codexRuntime } from "./runtime.js";

const EVENT_ORDER = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.output_item.done",
  "response.completed",
] as const;

test("renderResponsesSSE: emits all 9 event types in the proven order", () => {
  const sse = renderResponsesSSE("HELLO", { model: "gpt-5-codex" });
  // Each event appears as both an `event:` line and a `"type":` field.
  let cursor = 0;
  for (const type of EVENT_ORDER) {
    const idx = sse.indexOf(`event: ${type}\n`, cursor);
    expect(idx, `event ${type} present and ordered`).toBeGreaterThanOrEqual(
      cursor,
    );
    cursor = idx + 1;
  }
  // Every data payload carries its own "type" field.
  for (const type of EVENT_ORDER) {
    expect(sse).toContain(`"type":"${type}"`);
  }
});

test("renderResponsesSSE: response.completed carries the assistant text", () => {
  const sse = renderResponsesSSE("MOCK_REPLY_OK");
  const blocks = sse.split("\n\n").filter((b) => b.trim().length > 0);
  const last = blocks[blocks.length - 1] ?? "";
  expect(last).toContain("event: response.completed");
  const dataLine = last.split("\n").find((l) => l.startsWith("data: "));
  expect(dataLine).toBeDefined();
  const data = JSON.parse((dataLine as string).slice("data: ".length)) as {
    type: string;
    response: {
      status: string;
      output: { content: { type: string; text: string }[] }[];
    };
  };
  expect(data.type).toBe("response.completed");
  expect(data.response.status).toBe("completed");
  expect(data.response.output[0].content[0].text).toBe("MOCK_REPLY_OK");
});

test("parseResponsesRequest: extracts last user prompt, model, tool names", () => {
  const body = JSON.stringify({
    model: "gpt-5-codex",
    instructions: "you are a tool",
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system stuff" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first question" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "an answer" }],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "final " },
          { type: "input_text", text: "prompt" },
        ],
      },
    ],
    tools: [
      { type: "function", name: "shell" },
      { type: "function", function: { name: "apply_patch" } },
    ],
    tool_choice: "auto",
    stream: true,
  });
  const r = parseResponsesRequest(body);
  expect(r.prompt).toBe("final prompt");
  expect(r.model).toBe("gpt-5-codex");
  expect(r.toolNames).toEqual(["shell", "apply_patch"]);
});

test("codexRuntime.wireMock surfaces the keyless flag recipe + dummy-key env", () => {
  const wired = codexRuntime.wireMock("http://127.0.0.1:7777");
  // args = the proven -c model_providers.mock.* flag array (not an env var).
  expect(wired.args).toEqual(codexMockArgs("http://127.0.0.1:7777"));
  expect(wired.args).toContain("model_provider=mock");
  expect(
    wired.args.some((a) => a.includes('base_url="http://127.0.0.1:7777/v1"')),
  ).toBe(true);
  // env = the dummy key codex reads model_providers.mock.env_key through.
  expect(wired.env).toEqual(codexMockEnv());
  expect(wired.env.MOCK_KEY).toBe("dummy-key");
});

test("codexRuntime.versionKey opts out of version partitioning (0.x churns weekly)", () => {
  // Codex's minor IS its patch cadence (~2 bumps/week), so keying major.minor
  // like Claude Code would churn the cache/lock weekly — it returns "" instead.
  expect(codexRuntime.versionKey("0.143.0")).toBe("");
  expect(codexRuntime.versionKey("0.139.0-alpha.31")).toBe("");
  expect(codexRuntime.versionKey("anything")).toBe("");
});

test("parseResponsesRequest: tolerates malformed JSON", () => {
  const r = parseResponsesRequest("{not valid json");
  expect(r).toEqual({ prompt: "", model: "", toolNames: [] });
});

test("startCodexMock: serves the rendered SSE and records the request", async () => {
  const mock = await startCodexMock([{ text: "SERVED_OK" }]);
  try {
    const res = await fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-codex",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ping" }],
          },
        ],
      }),
    });
    const text = await res.text();
    expect(text).toContain("event: response.completed");
    expect(text).toContain("SERVED_OK");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].prompt).toBe("ping");
  } finally {
    await mock.close();
  }
});

// #340: past the end of the script is an error, not a copy of the last turn.
test("startCodexMock: a request past the end of the script is an error, never a repeated turn", async () => {
  const mock = await startCodexMock([{ text: "only" }]);
  const ask = (text: string): Promise<Response> =>
    fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-codex",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ],
      }),
    });
  try {
    expect(await (await ask("go")).text()).toContain("only");
    const second = await ask("again");
    expect(second.status).toBe(400);
    const message = await second.text();
    expect(message).toMatch(/1 turn\(s\) scripted/);
    expect(message).toMatch(/request #2/);
    expect(mock.requests).toHaveLength(2);
  } finally {
    await mock.close();
  }
});

const codexAvailable = (): boolean => {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const maybe = codexAvailable() ? test : test.skip;

maybe(
  "real codex completes a turn against the mock",
  async () => {
    const prompt = "say exactly MOCK_REPLY_OK and nothing else";
    const mock = await startCodexMock([{ text: "MOCK_REPLY_OK" }]);
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    // The in-process mock serves on THIS node event loop, so codex MUST be
    // spawned ASYNC (spawn, not execFileSync) — a synchronous spawn would block
    // the loop and the mock could never accept codex's request. stdin is
    // redirected from /dev/null (codex hangs on an open stdin).
    const devnull = openSync("/dev/null", "r");
    try {
      const args = [
        "exec",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--ephemeral",
        "--dangerously-bypass-approvals-and-sandbox",
        ...codexMockArgs(mock.url),
        "-c",
        'model="gpt-5-codex"',
        prompt,
      ];
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn("codex", args, {
          stdio: [devnull, "pipe", "pipe"],
          env: { ...process.env, ...codexMockEnv(), CODEX_HOME: codexHome },
        });
        let out = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (d: string) => (out += d));
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("codex timed out"));
        }, 25_000);
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(out);
        });
      });
      expect(stdout).toContain("MOCK_REPLY_OK");
      expect(mock.requests.length).toBeGreaterThanOrEqual(1);
      const sent = mock.requests.map((r) => r.prompt).join("\n");
      expect(sent).toContain(prompt);
    } finally {
      closeSync(devnull);
      await mock.close();
      // codex may still be flushing its CODEX_HOME on exit; retry the rm to
      // tolerate the cleanup race (ENOTEMPTY).
      rmSync(codexHome, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  30_000,
);
