/**
 * Checks over every reply of a run, not only the last. A style rule ("end each
 * reply with a status block", "one block per user message") is a rule about
 * EACH reply; `output` sees only the final one.
 */
import { describe, expect, it } from "vitest";

import { eachReply, replyCount } from "./check.js";
import type { Trace } from "./harness-test.js";

const trace = (replies: readonly string[] | undefined): Trace => ({
  toolCalls: [],
  hooks: [],
  output: replies?.at(-1) ?? "",
  subagents: [],
  modelRequests: [],
  turns: 1,
  file: () => null,
  ...(replies === undefined ? {} : { replies }),
});

const FOOTER = /\*\*Status\*\*/;

describe("eachReply", () => {
  it("passes when every reply matches", () => {
    const r = eachReply(FOOTER).eval(
      trace(["a **Status** x", "b **Status** y"]),
    );
    expect(r.pass).toBe(true);
  });

  it("fails on the first reply that does not match, and says which", () => {
    const r = eachReply(FOOTER).eval(trace(["no footer", "b **Status** y"]));
    expect(r).toMatchObject({ pass: false });
    expect(r.message).toMatch(/reply 1 of 2/);
  });

  it("fails, not passes, when the run has no replies to check", () => {
    expect(eachReply(FOOTER).eval(trace([])).pass).toBe(false);
  });

  it("fails with a reason when the harness does not tell replies apart", () => {
    const r = eachReply(FOOTER).eval(trace(undefined));
    expect(r).toMatchObject({ pass: false });
    expect(r.message).toMatch(/no `replies`/);
  });
});

describe("replyCount", () => {
  it("counts the replies that match, against a bound", () => {
    const two = trace(["first **Status** A", "second **Status** B"]);
    expect(replyCount(FOOTER, { max: 1 }).eval(two)).toMatchObject({
      pass: false,
    });
    expect(replyCount(FOOTER, { min: 2, max: 2 }).eval(two).pass).toBe(true);
  });

  it("takes a substring as well as a RegExp", () => {
    expect(replyCount("Status", { min: 1 }).eval(trace(["Status"])).pass).toBe(
      true,
    );
  });

  it("fails with a reason when the harness does not tell replies apart", () => {
    const r = replyCount(FOOTER, { max: 1 }).eval(trace(undefined));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no `replies`/);
  });

  it("serialises its matcher and bounds for the report", () => {
    expect(replyCount(FOOTER, { max: 1 }).toJSON()).toEqual({
      kind: "replyCount",
      matcher: String(FOOTER),
      regex: true,
      min: undefined,
      max: 1,
    });
  });
});
