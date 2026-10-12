/**
 * Every finding that says "too much always-loaded text" names where the text
 * can go. An error that only says "cut content" leaves one move — delete — and
 * the reader deletes rules that still matter instead of moving them to a
 * carrier that loads them only when they apply.
 */
import { describe, it, expect } from "vitest";

import {
  formatCeiling,
  formatRefusal,
  formatVerdict,
  type CeilingVerdict,
} from "./instruction-baseline.js";
import { MOVE_OUT_OF_ALWAYS_LOADED } from "./instruction-remedies.js";

const over: CeilingVerdict = {
  total: 38_000,
  max: 20_000,
  unit: "chars",
  largest: [
    { path: "CLAUDE.md", size: 30_000 },
    { path: "a.md", size: 8_000 },
  ],
};

describe("the remedy list", () => {
  it("names each carrier an always-loaded rule can move to", () => {
    expect(MOVE_OUT_OF_ALWAYS_LOADED.split("\n")).toEqual([
      "Move what does not apply to every request:",
      "  - a rule for one folder → that folder's nested CLAUDE.md or AGENTS.md (loads only there)",
      "  - a step tied to one action → a hook",
      "  - a procedure for one kind of task → a skill",
      "  - a fact a machine can check → a lint rule or a test, then delete the prose",
      "  - measurements and history → docs, linked, not loaded",
      "  - text another file already says → delete it",
    ]);
  });
});

describe("every over-weight finding carries it", () => {
  it("the ceiling finding", () => {
    expect(formatCeiling(over, ".")).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("the refusal to record a baseline above the ceiling", () => {
    expect(formatRefusal(over, ".")).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("growth over the recorded baseline", () => {
    const msg = formatVerdict(
      { kind: "grew", from: 10, to: 20, unit: "chars", changes: [] },
      ".",
    );
    expect(msg).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });
});
