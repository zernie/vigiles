/**
 * Checks over every reply of a run, not only the last. A style rule ("end each
 * reply with a status block", "one block per user message") is a rule about
 * EACH reply; `output` sees only the final one. Reached as
 * `check.output(m, { eachReply: true })` and `check.turns({ matching: m, … })`
 * (v52; formerly `experimental_eachReply` / `experimental_replyCount`).
 */

import { describe, expect, it } from "vitest";

import { output, received, turns } from "./check.js";
import type { Trace } from "./harness-test.js";

const eachReply = (m: string | RegExp) => output(m, { eachReply: true });
const replyCount = (
  m: string | RegExp,
  opts: { readonly min?: number; readonly max?: number },
) => turns({ ...opts, matching: m });

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

describe("check.output(m, { eachReply: true })", () => {
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

describe("check.turns({ matching })", () => {
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
      kind: "turns",
      matching: String(FOOTER),
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
    const check = eachReply(/Status/g);
    expect(check.eval(trace(["xx Status", "Status"])).pass).toBe(true);
    expect(check.eval(trace(["xx Status", "Status"])).pass).toBe(true);
  });

  it("replyCount counts every match with a /y pattern", () => {
    const check = replyCount(/S/y, { min: 2 });
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

describe("turns refuses bounds that cannot mean anything", () => {
  it.each([
    { name: "no bound", opts: {} },
    { name: "min above max", opts: { min: 3, max: 1 } },
    { name: "a negative bound", opts: { min: -1 } },
  ])("$name", ({ opts }) => {
    expect(() => replyCount("X", opts)).toThrow(/turns/);
  });
});
