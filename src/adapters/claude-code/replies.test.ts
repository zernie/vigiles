import { describe, expect, it } from "vitest";

import { parseReplies } from "./replies.js";

/** One stream line as Claude Code 2.1.291 prints it, ids shortened. */
const assistant = (
  id: string,
  content: readonly unknown[],
  parent: string | null = null,
): string =>
  JSON.stringify({
    type: "assistant",
    message: { id, type: "message", role: "assistant", content },
    parent_tool_use_id: parent,
  });
const text = (t: string) => ({ type: "text", text: t });
const result = (r: string) =>
  JSON.stringify({ type: "result", subtype: "success", result: r });

describe("parseReplies", () => {
  it("keeps both replies of a run a Stop hook continued (measured shape)", () => {
    const stream = [
      assistant("m1", [text("first reply\n---\nstatus A")]),
      assistant("m2", [text("second reply\n---\nstatus B")]),
      result("second reply\n---\nstatus B"),
    ].join("\n");
    expect(parseReplies(stream)).toEqual([
      "first reply\n---\nstatus A",
      "second reply\n---\nstatus B",
    ]);
  });

  it("joins one message streamed as several events", () => {
    const stream = [
      assistant("m1", [text("Hello ")]),
      assistant("m1", [text("world")]),
    ].join("\n");
    expect(parseReplies(stream)).toEqual(["Hello world"]);
  });

  it("leaves out a subagent's messages and tool-only messages", () => {
    const stream = [
      assistant("m1", [
        { type: "tool_use", id: "t", name: "Agent", input: {} },
      ]),
      assistant("s1", [text("subagent says")], "t"),
      assistant("m2", [text("done")]),
    ].join("\n");
    expect(parseReplies(stream)).toEqual(["done"]);
  });

  it("is undefined for the plain json output, which is not a stream", () => {
    expect(parseReplies(result("only the last"))).toBeUndefined();
  });

  it("skips lines that are not JSON", () => {
    expect(parseReplies(`noise\n${assistant("m1", [text("ok")])}`)).toEqual([
      "ok",
    ]);
  });
});

describe("what counts as a reply", () => {
  it("text the agent writes before a tool call is narration, not a reply", () => {
    // Measured on Claude Code 2.1.292: the narration and the tool call share one
    // message id, so the message is mid-turn, not where the agent stopped.
    const stream = [
      assistant("m1", [text("I will read the file now.")]),
      assistant("m1", [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
      ]),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
        },
      }),
      assistant("m2", [text("done STATUS")]),
      result("done STATUS"),
    ].join("\n");
    expect(parseReplies(stream)).toEqual(["done STATUS"]);
  });

  it("is not answered at all when the output is not a stream", () => {
    expect(parseReplies(result("STATUS one"))).toBeUndefined();
    expect(parseReplies("")).toBeUndefined();
  });
});
