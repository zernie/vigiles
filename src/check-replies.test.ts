/**
 * Checks over every reply of a run, not only the last. A style rule ("end each
 * reply with a status block", "one block per user message") is a rule about
 * EACH reply; `output` sees only the final one.
 */
import { describe, expect, it } from "vitest";

import {
  experimental_eachReply,
  experimental_replyCount,
  output,
  received,
} from "./check.js";
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

describe("experimental_eachReply", () => {
  it("passes when every reply matches", () => {
    const r = experimental_eachReply(FOOTER).eval(
      trace(["a **Status** x", "b **Status** y"]),
    );
    expect(r.pass).toBe(true);
  });

  it("fails on the first reply that does not match, and says which", () => {
    const r = experimental_eachReply(FOOTER).eval(
      trace(["no footer", "b **Status** y"]),
    );
    expect(r).toMatchObject({ pass: false });
    expect(r.message).toMatch(/reply 1 of 2/);
  });

  it("fails, not passes, when the run has no replies to check", () => {
    expect(experimental_eachReply(FOOTER).eval(trace([])).pass).toBe(false);
  });

  it("fails with a reason when the harness does not tell replies apart", () => {
    const r = experimental_eachReply(FOOTER).eval(trace(undefined));
    expect(r).toMatchObject({ pass: false });
    expect(r.message).toMatch(/no `replies`/);
  });
});

describe("experimental_replyCount", () => {
  it("counts the replies that match, against a bound", () => {
    const two = trace(["first **Status** A", "second **Status** B"]);
    expect(experimental_replyCount(FOOTER, { max: 1 }).eval(two)).toMatchObject(
      {
        pass: false,
      },
    );
    expect(
      experimental_replyCount(FOOTER, { min: 2, max: 2 }).eval(two).pass,
    ).toBe(true);
  });

  it("takes a substring as well as a RegExp", () => {
    expect(
      experimental_replyCount("Status", { min: 1 }).eval(trace(["Status"]))
        .pass,
    ).toBe(true);
  });

  it("fails with a reason when the harness does not tell replies apart", () => {
    const r = experimental_replyCount(FOOTER, { max: 1 }).eval(
      trace(undefined),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no `replies`/);
  });

  it("serialises its matcher and bounds for the report", () => {
    expect(experimental_replyCount(FOOTER, { max: 1 }).toJSON()).toEqual({
      kind: "replyCount",
      matcher: String(FOOTER),
      regex: true,
      min: undefined,
      max: 1,
    });
  });
});

describe("a stateful RegExp gives the same answer every time", () => {
  // `g` / `y` make `RegExp.test` advance `lastIndex`, so the second reply, or
  // the second trial of the same check object, starts mid-string and misses.
  it("eachReply matches every reply with a /g pattern", () => {
    const check = experimental_eachReply(/Status/g);
    expect(check.eval(trace(["xx Status", "Status"])).pass).toBe(true);
    expect(check.eval(trace(["xx Status", "Status"])).pass).toBe(true);
  });

  it("replyCount counts every match with a /y pattern", () => {
    const check = experimental_replyCount(/S/y, { min: 2 });
    expect(check.eval(trace(["S", "S"])).pass).toBe(true);
    expect(check.eval(trace(["S", "S"])).pass).toBe(true);
  });

  it("output and received, the older checks, answer the same on every trial", () => {
    const out = output(/done/g);
    const got = received(/hello/g);
    const t: Trace = {
      ...trace(["done"]),
      modelRequests: [{ system: "hello", messages: [] }],
    };
    expect([out.eval(t).pass, out.eval(t).pass]).toEqual([true, true]);
    expect([got.eval(t).pass, got.eval(t).pass]).toEqual([true, true]);
  });
});

describe("replyCount refuses bounds that cannot mean anything", () => {
  it.each([
    { name: "no bound", opts: {} },
    { name: "min above max", opts: { min: 3, max: 1 } },
    { name: "a negative bound", opts: { min: -1 } },
  ])("$name", ({ opts }) => {
    expect(() => experimental_replyCount("X", opts)).toThrow(/replyCount/);
  });
});
