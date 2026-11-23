/**
 * Codex has no request-body channel vigiles reads, so the per-trial context
 * check (vigiles#416) says "not checked" for it — never a pass, never a
 * failure that would sink a Codex eval.
 */
import { describe, expect, it } from "vitest";

import { contextSummaryLines } from "../../core/context-evidence.js";
import { startContextCapture } from "../../eval-context.js";
import { codexRuntime } from "./runtime.js";

describe("the context check on a harness without a request channel", () => {
  it("is unobservable, not delivered and not missing", () => {
    const capture = startContextCapture({
      runtime: codexRuntime,
      world: { "AGENTS.md": "Use tabs.\n" },
      enabled: true,
    });
    const evidence = capture.finish();
    capture.dispose();
    expect(evidence).toEqual({
      kind: "unobservable",
      why: "harness-has-no-channel",
      files: [],
    });
    expect(contextSummaryLines([evidence])).toEqual([
      "⚠ context not checked: this harness has no request-body channel in 1 of 1 trials",
    ]);
    expect(capture.env).toEqual({});
  });
});
