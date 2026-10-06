/**
 * `replies` reaches the eval tier: a real-model run's checks can see every reply,
 * not only the `result` event's last one. Driven through `measureWith` with a
 * scripted runner returning Claude Code's stream-json, so no model is called.
 */
import { describe, expect, it } from "vitest";

import {
  experimental_eachReply,
  experimental_replyCount,
} from "../../check.js";
import { measureWith, parseClaudeRun } from "../../eval.js";

const line = (o: unknown): string => JSON.stringify(o);
/** Two replies in one turn: the second after a Stop hook blocked the first. */
const STREAM = [
  line({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "m1",
      content: [{ type: "text", text: "first\n**Status** A" }],
    },
  }),
  line({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "m2",
      content: [{ type: "text", text: "second\n**Status** B" }],
    },
  }),
  line({ type: "result", result: "second\n**Status** B", num_turns: 2 }),
].join("\n");

describe("replies in the eval tier", () => {
  it("are parsed from the stream", () => {
    expect(parseClaudeRun({ code: 0, stdout: STREAM }).replies).toEqual([
      "first\n**Status** A",
      "second\n**Status** B",
    ]);
  });

  it("reach the checks of a measured run", async () => {
    const report = await measureWith(
      {
        task: "hi",
        checks: [
          experimental_eachReply(/\*\*Status\*\*/),
          experimental_replyCount(/\*\*Status\*\*/, { max: 1 }),
        ],
        trials: 2,
        spacingSec: 0,
      },
      () => Promise.resolve({ code: 0, stdout: STREAM }),
    );
    expect(report.perCheck.map((c) => c.rate)).toEqual([1, 0]);
  });
});
