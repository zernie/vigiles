/**
 * Claude Code's env-only answer to "is a real model reachable, and on whose
 * bill" — the two predicates behind `HarnessLiveDriver.access` on this adapter.
 *
 * These tests moved here WITH the code. They used to sit in
 * `scan-trigger-suggest.test.ts`, beside a module named for the
 * harness-agnostic read-vs-run decision, while asserting one harness's
 * environment variables — the same misplacement, one layer up.
 */
import { describe, it, expect } from "vitest";
import { hasModelAccess, isMeteredAccess } from "./model-access.js";

describe("hasModelAccess", () => {
  it("true for a metered API key", () => {
    expect(hasModelAccess({ ANTHROPIC_API_KEY: "sk-x" })).toBe(true);
  });
  it("true inside an authenticated Claude Code session (no key)", () => {
    expect(hasModelAccess({ CLAUDECODE: "1" })).toBe(true);
    expect(hasModelAccess({ CLAUDE_CODE_ENTRYPOINT: "remote" })).toBe(true);
  });
  it("false with nothing set", () => {
    expect(hasModelAccess({})).toBe(false);
    expect(hasModelAccess({ CLAUDECODE: "0" })).toBe(false);
  });
});

describe("isMeteredAccess", () => {
  it("metered iff a paid API key is set (subscription is not metered)", () => {
    expect(isMeteredAccess({ ANTHROPIC_API_KEY: "sk-x" })).toBe(true);
    expect(isMeteredAccess({ CLAUDECODE: "1" })).toBe(false);
    expect(isMeteredAccess({})).toBe(false);
  });
});
