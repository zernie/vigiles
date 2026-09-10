/**
 * codex mock-model — EXPERIMENTAL, internal-only. A scripted, deterministic
 * OpenAI **Responses API** mock that real `codex` completes a turn against.
 *
 * Codex speaks the Responses API: a turn-consuming request hits
 * `POST /v1/responses` with `Accept: text/event-stream`, and the mock answers
 * with the proven `response.created → … → response.completed` SSE sequence that
 * makes codex emit one assistant text message. There is no count-tokens
 * endpoint. This is the Codex-side analogue of the Anthropic Messages mock in
 * `src/mock-model.ts` (`startMock`).
 *
 * The wire format here is NOT guessed — it is PROVEN end-to-end against real
 * `codex` (codex-cli 0.139.0) via the `-c model_providers.mock.*` recipe in
 * `src/adapters/codex/runtime.ts` (`codexMockArgs`/`codexMockEnv`).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted assistant turn: the final text answer codex should emit. */
export interface CodexTurn {
  /** Final text answer for this turn. */
  readonly text: string;
}

/**
 * One `/v1/responses` request the mock received, parsed for assertions: the
 * user's prompt (last `input` item with `role:"user"`), the requested model,
 * and the declared function-tool names.
 */
export interface CodexRequest {
  readonly prompt: string;
  readonly model: string;
  readonly toolNames: readonly string[];
}

export interface CodexMockHandle {
  readonly url: string;
  readonly port: number;
  /** Every `/v1/responses` request the mock received, in order. */
  readonly requests: readonly CodexRequest[];
  close(): Promise<void>;
}

const MSG_ID = "msg_mock_1";
const RESP_ID = "resp_mock_1";

/**
 * Render the PROVEN OpenAI-Responses SSE event sequence for a single assistant
 * text message — `response.created` through `response.completed`. This exact
 * sequence is confirmed to make real `codex` complete a turn. Pure and exported
 * so the renderer is testable without the HTTP server.
 */
export function renderResponsesSSE(
  text: string,
  opts: { model?: string } = {},
): string {
  const model = opts.model ?? "gpt-5-codex";
  const response = (
    status: "in_progress" | "completed",
    output: unknown[],
  ): unknown => ({
    id: RESP_ID,
    object: "response",
    status,
    model,
    output,
    usage: null,
  });
  const completedItem = {
    type: "message",
    id: MSG_ID,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };

  const events: { type: string; data: Record<string, unknown> }[] = [
    {
      type: "response.created",
      data: { response: response("in_progress", []) },
    },
    {
      type: "response.in_progress",
      data: { response: response("in_progress", []) },
    },
    {
      type: "response.output_item.added",
      data: {
        output_index: 0,
        item: {
          type: "message",
          id: MSG_ID,
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      },
    },
    {
      type: "response.content_part.added",
      data: {
        item_id: MSG_ID,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
    },
    {
      type: "response.output_text.delta",
      data: { item_id: MSG_ID, output_index: 0, content_index: 0, delta: text },
    },
    {
      type: "response.output_text.done",
      data: { item_id: MSG_ID, output_index: 0, content_index: 0, text },
    },
    {
      type: "response.content_part.done",
      data: {
        item_id: MSG_ID,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text },
      },
    },
    {
      type: "response.output_item.done",
      data: { output_index: 0, item: completedItem },
    },
    {
      type: "response.completed",
      data: { response: response("completed", [completedItem]) },
    },
  ];

  return events
    .map(
      (e) =>
        `event: ${e.type}\n` +
        `data: ${JSON.stringify({ type: e.type, ...e.data })}\n\n`,
    )
    .join("");
}

interface ResponsesInputItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
}

/**
 * 🔴 KNOWN BLIND SPOT — NARROW ON PURPOSE, AND THAT IS NOT THE SAME AS COMPLETE.
 * Roadmapped P1 2026-09-10; do not read a `requestContains` miss on a Codex trace
 * as "not delivered" until this is closed.
 *
 * This reads `.text` and nothing else, and its caller takes only the LAST input
 * item with `role:"user", type:"message"`. Measured against openai@7.13.0:
 * `ResponseInputItem` has THIRTY-TWO variants and we look at one. The ignored
 * ones include `FunctionCallOutput`, `ShellCallOutput` and `LocalShellCallOutput`
 * — the Responses-API analogues of an Anthropic `tool_result`, i.e. exactly where
 * Claude Code relocated a hook's additionalContext in 2.1.228 and where the same
 * payload would land here.
 *
 * WHY THIS IS A COMMENT AND NOT A FIX. `driver.ts` adapts this into a
 * `ModelRequest`, so it feeds `requestContains` — the same predicate whose
 * `.text`-only twin in src/mock-model.ts produced a false "not delivered", a
 * false issue (zernie/vigiles#231) and a near-miss upstream report. The trap is
 * armed; nobody has stepped on it only because both delivery harnesses are
 * Claude-Code-only today. Closing it properly means deciding what `prompt` MEANS
 * across 32 item types — a semantic change, not a bug fix, and too large to ride
 * along with the mock-model repair.
 *
 * The Claude Code side now takes `ContentBlockParam` from @anthropic-ai/sdk and
 * fails the BUILD on an unhandled variant (see `flattenBlock` in
 * src/mock-model.ts). openai ships the matching union under Apache-2.0; applying
 * the same construction here is the fix, and it is the roadmapped work.
 */
function joinInputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const t = (c as { text?: unknown }).text;
      return typeof t === "string" ? t : "";
    })
    .join("");
}

/**
 * Parse a Responses request body — the user's prompt (the LAST `input` item
 * with `role:"user"`, joining its `content[].text`), the requested `model`, and
 * the declared function-tool names. Tolerates malformed JSON (returns an empty
 * prompt). Pure and exported so request capture is testable without the server.
 */
export function parseResponsesRequest(body: string): {
  prompt: string;
  model: string;
  toolNames: string[];
} {
  let parsed: {
    model?: unknown;
    input?: unknown;
    tools?: unknown;
  } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { prompt: "", model: "", toolNames: [] };
  }

  const input = Array.isArray(parsed.input)
    ? (parsed.input as ResponsesInputItem[])
    : [];
  const lastUser = [...input]
    .reverse()
    .find((item) => item.role === "user" && item.type === "message");
  const prompt = lastUser ? joinInputText(lastUser.content) : "";

  const model = typeof parsed.model === "string" ? parsed.model : "";

  const toolNames = Array.isArray(parsed.tools)
    ? parsed.tools
        .map((t) => {
          const tool = t as { name?: unknown; function?: { name?: unknown } };
          if (typeof tool.name === "string") return tool.name;
          const fnName = tool.function?.name;
          return typeof fnName === "string" ? fnName : "";
        })
        .filter((n) => n.length > 0)
    : [];

  return { prompt, model, toolNames };
}

/**
 * Start the scripted Codex Responses mock on a free port. Each
 * `POST /v1/responses` consumes the next scripted turn (the last turn repeats if
 * codex asks for more); HEAD and any other path get `{}`. Resolves to a handle
 * with the base `url`, the `port`, the recorded `requests`, and `close()`.
 */
export function startCodexMock(
  script: readonly CodexTurn[],
  opts: { onRequest?: (req: CodexRequest) => void } = {},
): Promise<CodexMockHandle> {
  let i = 0;
  const requests: CodexRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c as string));
    req.on("end", () => {
      const url = req.url ?? "";
      const isResponses =
        req.method === "POST" && url.includes("/v1/responses");
      if (!isResponses) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const parsed = parseResponsesRequest(body);
      requests.push(parsed);
      opts.onRequest?.(parsed);
      const turn = script[Math.min(i, script.length - 1)] ?? { text: "" };
      i++;
      const model = parsed.model || "gpt-5-codex";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(renderResponsesSSE(turn.text, { model }));
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        port,
        get requests() {
          return requests;
        },
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              r();
            });
          }),
      });
    });
  });
}
