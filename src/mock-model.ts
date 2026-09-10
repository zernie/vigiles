/**
 * vigiles — a scripted, deterministic Anthropic Messages API mock.
 *
 * Point a Claude Code client at it with `ANTHROPIC_BASE_URL` (and any dummy
 * `ANTHROPIC_API_KEY`) and it serves a fixed *script* of model turns in order —
 * each `POST /v1/messages` returns the next. This is the seam that makes harness
 * testing deterministic: the real `claude` CLI runs your real hooks/settings,
 * but the model's turns are scripted, so the outcome is reproducible and free.
 *
 *   scriptModel([
 *     { tool: "Write", input: { file_path: "SKILL.md", content: "..." } },
 *     { text: "done" },
 *   ])
 *
 * Implements the parts a real client needs: SSE streaming (flushed per event),
 * `/v1/messages/count_tokens` (else Claude Code hangs), HEAD/health tolerance,
 * and echoing the requested model.
 */
import http from "node:http";
import type { ServerResponse } from "node:http";
// TYPES ONLY — erased at compile time, so this stays a devDependency and never
// enters a consumer's tree. MIT, unlike @anthropic-ai/claude-code. See the
// comment on `flattenBlock` for what it buys and what it does not.
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AddressInfo } from "node:net";

// The trace shapes are defined in core (`src/core/harness-driver.ts`) so the
// harness-agnostic runner + every adapter can reference them without a
// cross-adapter import. Re-exported here so `vigiles/claude-code` and the
// granular `vigiles/mock-model` path keep exporting `ModelTurn`/`ModelRequest`.
import type { ModelTurn, ModelRequest } from "./core/harness-driver.js";
export type { ModelTurn, ModelRequest } from "./core/harness-driver.js";

/** Build a scripted model from an ordered list of turns. */
export function scriptModel(turns: readonly ModelTurn[]): ModelTurn[] {
  return [...turns];
}

export interface TurnInfo {
  readonly n: number;
  readonly stream: boolean;
  readonly hasToolResult: boolean;
}

export interface MockHandle {
  readonly url: string;
  close(): void;
  /**
   * Number of SCRIPT turns served so far — MAIN-LOOP requests only. A
   * side-channel request is answered without touching the script and is not
   * counted here, so this is the agent's turn count rather than the CLI's
   * HTTP-call count. (Before 2026-08-12 it was the latter: a 3-entry script
   * against Claude Code 2.1.228 reported 27.)
   */
  readonly count: number;
  /** Side-channel requests answered so far — never script-consuming. */
  readonly sideChannelCount: number;
  /** Every `/v1/messages` request the mock received, in order. */
  readonly requests: readonly ModelRequest[];
}

function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const rid = (p: string): string =>
  `${p}${Math.random().toString(36).slice(2, 10)}`;

function streamTurn(res: ServerResponse, turn: ModelTurn, model: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: rid("msg_"),
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  if (turn.tool) {
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: rid("toolu_"),
        name: turn.tool,
        input: {},
      },
    });
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(turn.input ?? {}),
      },
    });
    writeEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    writeEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  } else {
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: turn.text ?? "" },
    });
    writeEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    writeEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  }
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function jsonTurn(res: ServerResponse, turn: ModelTurn, model: string): void {
  const content = turn.tool
    ? [
        {
          type: "tool_use",
          id: rid("toolu_"),
          name: turn.tool,
          input: turn.input ?? {},
        },
      ]
    : [{ type: "text", text: turn.text ?? "" }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: rid("msg_"),
      type: "message",
      role: "assistant",
      model,
      stop_reason: turn.tool ? "tool_use" : "end_turn",
      stop_sequence: null,
      content,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  );
}

interface ReqBody {
  stream?: boolean;
  model?: string;
  system?: unknown;
  messages?: { role?: unknown; content?: unknown }[];
  tools?: unknown;
}

// ---------------------------------------------------------------------------
// Side-channel requests — the CLI's own model calls, which must NOT eat the script
//
// 🔴 MEASURED 2026-08-12, Claude Code 2.1.228, one `runHarnessTest` with a
// THREE-entry script: the mock served 27 requests — 9 main-loop and 18
// side-channel, two per turn. The CLI runs a `post_turn_summary` classifier after
// each turn ("decide which of four states the agent is in, so the system knows
// whether to notify the user"), and it retries once because our text reply was
// not the JSON it wanted. The mock handed the NEXT SCRIPT ENTRY to whichever
// request arrived first, so entry #2 went to the notification classifier and the
// agent never saw it. Symptom: `a blocking Stop hook forces the agent to keep
// working` failed locally — the agent was never given the turn that creates DONE.
//
// This is not one flaky test. The same mock underpins the whole deterministic
// tier we advertise as "real harness, fake model", so ANY new side channel the
// CLI grows silently shifts every script by however many calls it makes.
//
// THE DISCRIMINATOR IS `tools`, AND IT IS STRUCTURAL, NOT TEXTUAL. Measured on
// all 27 requests: main-loop requests carry `tools` (40 definitions),
// `stream: true`, `max_tokens: 32000`; side-channel requests carry NO `tools`,
// no `stream`, `max_tokens: 1024`, and a completely different system prompt.
// Matching the system prompt's text would work today and rot on the next release.
// `tools` is the one that follows from what the request IS: only a request that
// declares tools can act on a scripted `tool_use`, so serving a script entry to a
// request without them cannot be what the script author meant.
//
// ⚠️ WHAT THIS DOES NOT PROVE, because the argument for `tools` is about
// SUFFICIENCY and the measurement only shows the current split: a future side
// channel that DOES declare tools would still consume a script entry, and a
// main-loop request with every tool disabled would stop consuming one. Neither
// occurs on 2.1.228. The mitigation is visibility rather than cleverness —
// `sideChannelCount` and `ModelRequest.sideChannel` put the split in the handle,
// so a drift shows up as a number instead of as a mysteriously shifted script.
// ---------------------------------------------------------------------------

/**
 * Is this request the AGENT LOOP asking for its next turn (as opposed to a
 * side-channel call the CLI makes for its own bookkeeping)?
 *
 * Pure and exported so the classification is unit-tested without HTTP. See the
 * block above for the measurement and for what the criterion does not settle.
 */
export function isMainLoopRequest(body: { tools?: unknown }): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * The reply a side-channel request gets: valid, tool-free JSON, from OUTSIDE the
 * script.
 *
 * JSON specifically, and measured: Claude Code's notification classifier asks for
 * a JSON object and RETRIES once with "Previous response was not valid JSON"
 * when it does not get one — which is why the 3-entry script drew two
 * side-channel calls per turn rather than one. Answering in JSON halves that
 * traffic. It is a courtesy, not the fix; the fix is that this text never comes
 * from the script.
 */
const SIDE_CHANNEL_REPLY = "{}";

/**
 * The stated residual risk of keying on `tools`, made LOUD instead of silent.
 *
 * If a future main-loop request ever arrives WITHOUT tool declarations it is
 * misrouted to the side channel, the script is never consumed, and the agent
 * loops on `{}` — a failure with no symptom except a test that mysteriously
 * asserts against an empty run. Every real run that reached the model at all
 * consumes at least one script turn, so "side-channel requests arrived and
 * script turns did not" cannot happen in the healthy case. Returns the warning
 * line, or `undefined` when there is nothing to say (including the run that
 * never reached the model at all — that has its own, visible, failure).
 */
export function scriptUnconsumedWarning(
  count: number,
  sideChannelCount: number,
): string | undefined {
  if (count > 0 || sideChannelCount === 0) return undefined;
  return (
    `vigiles: the scripted mock served ${String(sideChannelCount)} side-channel ` +
    `request(s) and ZERO script turns. Every request the agent CLI made declared ` +
    `no tools, so none of them looked like an agent turn (see isMainLoopRequest) ` +
    `— the script was never consumed and the run decided on nothing. If the CLI ` +
    `changed shape, that classifier is what needs updating.`
  );
}

/**
 * Recover the main-loop / side-channel split from a captured request LOG.
 *
 * 🔴 THIS EXISTS BECAUSE `Trace.turns` MEANT TWO DIFFERENT THINGS. The
 * in-process handle carries the split as `count` / `sideChannelCount`, and the
 * direct path reads `mock.count` — the agent's own turns. A SANDBOXED run has
 * the mock in another process, so all that crosses the boundary is the tagged
 * ndjson request log (`mock-entry.ts` → `parseRequestLog`); counting its lines
 * counted the CLI's bookkeeping calls as agent turns. MEASURED on Claude Code
 * 2.1.228, a 3-entry script: 27 requests for 9 turns — `assertTurnsAtLeast(10)`
 * would have passed on a 9-turn run, and only when sandboxed. One number with
 * two meanings depending on the execution path is worse than either meaning.
 *
 * The tag is what makes this recoverable at all: `sideChannel` survives
 * `JSON.stringify` into the log, so the counts here are equal by construction to
 * the ones the handle would have reported in-process.
 */
export function splitRequestCounts(requests: readonly ModelRequest[]): {
  count: number;
  sideChannelCount: number;
} {
  let sideChannelCount = 0;
  for (const r of requests) if (r.sideChannel === true) sideChannelCount++;
  return { count: requests.length - sideChannelCount, sideChannelCount };
}

/**
 * Flatten one Anthropic content block to the text the MODEL actually received.
 *
 * WHY THIS IS A TYPED, EXHAUSTIVE SWITCH AND NOT A `.text` LOOKUP — the whole
 * point of the file, and it was paid for. Until 2026-09-10 this read `b.text`
 * and returned `""` for anything else. Eight of the sixteen `ContentBlockParam`
 * variants carry their payload in `content`, not `text`, so half the union was
 * invisible to every instrument built on `extractRequest` — `requestContains`,
 * `refs-nudge.harness.mjs`, `injectable-events-delivery.harness.mjs`.
 *
 * WHAT THAT COST. Claude Code <= 2.1.227 delivered a `PostToolUse` hook's
 * `additionalContext` as its own `text` block. From 2.1.228 (a PATCH release,
 * 2026-08-11) it arrives appended to the `tool_result` block's `content`, inside
 * a `<system-reminder>`. Nothing broke: the model received the payload on both
 * versions. Our probe went blind, every test above reported "not delivered", and
 * that false reading was written up as zernie/vigiles#231 and very nearly filed
 * upstream as a regression in somebody else's product. MEASURED both ways on one
 * machine, claude 2.1.267, changing only this function: blind = "landed=false",
 * typed = "landed=true".
 *
 * WHAT THE TYPE BUYS, precisely — it is NOT a change detector:
 *   - it does NOT notice a payload moving between fields the type already allows
 *     (`ToolResultBlockParam.content` predates the relocation; nothing changed);
 *   - it DOES make a silently-unhandled variant impossible: the `never` binding
 *     below fails `tsc` until every case is written out, so the seventeenth
 *     block type Anthropic ships breaks the BUILD instead of quietly emptying a
 *     measurement.
 *
 * WHY THE DEFAULT SERIALISES INSTEAD OF RETURNING `""`. This is a measurement
 * instrument, and its proven failure mode is the FALSE NEGATIVE — a payload that
 * was there, reported missing. So an unrecognised block is over-included (its
 * JSON) rather than dropped: a stale pin then costs a noisy match, never a
 * silent hole. That asymmetry is deliberate; do not "tidy" it to `""`.
 *
 * The repo's `assertNever` is deliberately NOT used: it throws, and this parses
 * untrusted wire JSON where an unknown block must degrade, not crash.
 */
function flattenBlock(b: ContentBlockParam): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "thinking":
      return b.thinking;
    // The eight that carry `content` — the family this function was blind to.
    case "tool_result":
    case "search_result":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      return b.content === undefined ? "" : flattenContent(b.content);
    case "document":
      // Its readable text is spread across `title`, `context` AND `source`
      // (`PlainTextSource.data`, `ContentBlockSource.content`), so it is walked
      // rather than read field by field. A base64 source is skipped by
      // `flattenUnknown`: it is an opaque blob by construction.
      return flattenUnknown(b);
    // The model's own call, not context delivered TO it — kept out of
    // `requestContains` on purpose so a needle in a tool ARGUMENT is never read
    // as "the model was told this".
    case "tool_use":
    case "server_tool_use":
      return "";
    // Genuinely carry no text.
    case "image":
    case "redacted_thinking":
    case "container_upload":
      return "";
    default: {
      // Compile-time: unreachable, and that is the guard — a new variant makes
      // this assignment fail. Run-time: reachable via wire JSON from a newer
      // API than the pinned types, so it degrades loudly instead of throwing.
      const unhandled: never = b;
      return JSON.stringify(unhandled);
    }
  }
}

/**
 * Flatten an arbitrary wire payload to text by walking every string leaf.
 *
 * WHY A GENERIC WALK AND NOT ONE MORE NAMED FIELD. The first version of
 * `flattenBlock` grouped eight variants as "the ones that carry `content`" and
 * handed each to `flattenContent`, which accepts only a string or an array.
 * Six of those eight carry an OBJECT there — `web_fetch_tool_result`,
 * `web_search_tool_result`, `code_execution_tool_result`,
 * `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`,
 * `tool_search_tool_result` — so they still flattened to "". The grouping was
 * made on the field's NAME while the defect lives in its TYPE, which is the
 * same mistake, one level up, as the `.text`-only read it replaced. Found by
 * review on this PR, not by a run (zernie/vigiles#233).
 *
 * And no single field would have fixed it: the payload's text sits at a
 * different key in each shape — `stdout`/`stderr` on a bash result, a nested
 * `content` document on a fetch result, `data` on a plain-text source. Keying
 * on any one of them re-commits the shape assumption. Walking commits to none.
 */
function flattenUnknown(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flattenUnknown).join("");
  if (typeof v !== "object" || v === null) return "";
  const o = v as Record<string, unknown>;
  // A base64 source is bytes, not text. Including it would bury every real
  // match under megabytes of encoding — the one over-inclusion that costs more
  // than the false negative it avoids.
  if (o.type === "base64") return "";
  return Object.entries(o)
    .filter(([k]) => k !== "type" && k !== "media_type") // discriminators
    .map(([, val]) => flattenUnknown(val))
    .join("");
}

/**
 * Flatten Anthropic content to text: a string, an array of blocks, or the
 * OBJECT a server-tool result carries (see `flattenUnknown`).
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return flattenUnknown(content);
  return content
    .map((b) =>
      typeof b === "string" ? b : flattenBlock(b as ContentBlockParam),
    )
    .join("");
}

/**
 * Extract a {@link ModelRequest} from a request body — the `system` prompt and
 * `messages`, each flattened to text. Pure and exported so the capture logic is
 * testable without the HTTP server.
 */
export function extractRequest(body: {
  system?: unknown;
  messages?: unknown;
}): ModelRequest {
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => {
        const msg = m as { role?: unknown; content?: unknown };
        return {
          role: typeof msg.role === "string" ? msg.role : "",
          text: flattenContent(msg.content),
        };
      })
    : [];
  return { system: flattenContent(body.system), messages };
}

/**
 * Start the scripted mock on a free port. Each MAIN-LOOP `/v1/messages` POST
 * consumes the next turn (the last turn repeats if the client asks for more);
 * a SIDE-CHANNEL POST — the CLI's own bookkeeping calls, see
 * {@link isMainLoopRequest} — is answered from outside the script and consumes
 * nothing. Resolves to a handle with the base `url` and a `close()`.
 */
export function startMock(
  script: readonly ModelTurn[],
  opts: {
    onTurn?: (info: TurnInfo) => void;
    /** Called with each `/v1/messages` request as it arrives — used by the
     * in-sandbox mock entry to stream requests to a file for the parent. */
    onRequest?: (req: ModelRequest) => void;
  } = {},
): Promise<MockHandle> {
  let i = 0;
  let sideChannelCount = 0;
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c as string));
    req.on("end", () => {
      const url = req.url ?? "";
      const isCount = url.includes("count_tokens");
      const isMessages = url.includes("/v1/messages") && !isCount;
      let reqBody: ReqBody = {};
      try {
        reqBody = JSON.parse(body) as ReqBody;
      } catch {
        /* HEAD / health checks have no JSON body */
      }
      if (req.method === "HEAD" || (!isMessages && !isCount)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (isCount) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const isMainLoop = isMainLoopRequest(reqBody);
      const request: ModelRequest = isMainLoop
        ? extractRequest(reqBody)
        : { ...extractRequest(reqBody), sideChannel: true };
      // EVERY request is still recorded — the side channel is routed, not
      // hidden. `requests` is what harness tests assert against, and a request
      // the mock silently dropped from the record would be the next invisible
      // failure rather than a fix for this one.
      requests.push(request);
      opts.onRequest?.(request);
      const model = reqBody.model ?? "claude-mock";
      if (!isMainLoop) {
        // Answered from OUTSIDE the script, and `i` is untouched: the CLI's own
        // bookkeeping call cannot shift the agent's turns.
        sideChannelCount++;
        const reply = { text: SIDE_CHANNEL_REPLY };
        if (reqBody.stream === true) streamTurn(res, reply, model);
        else jsonTurn(res, reply, model);
        return;
      }
      const last = JSON.stringify(reqBody.messages?.at(-1)?.content ?? "");
      opts.onTurn?.({
        n: i,
        stream: reqBody.stream === true,
        hasToolResult: last.includes('"tool_result"'),
      });
      const turn = script[Math.min(i, script.length - 1)] ?? { text: "" };
      i++;
      if (reqBody.stream === true) streamTurn(res, turn, model);
      else jsonTurn(res, turn, model);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () => server.close(),
        get count() {
          return i;
        },
        get sideChannelCount() {
          return sideChannelCount;
        },
        get requests() {
          return requests;
        },
      });
    });
  });
}
