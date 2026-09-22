/**
 * audit read-vs-run decision tests — the pure `decideExecute` that makes a plain
 * `audit` a deterministic READ and gates ALL execution (safety battery + live MCP
 * + trigger-rate) behind one consent: ask at a TTY (remembered), `--measure` is
 * the headless yes, headless stays a read + a loud nudge. Plus the prompts
 * scaffold. The model-access helpers moved out with the Claude Code env vars
 * they read — `src/adapters/claude-code/model-access.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  decideExecute,
  formatExecuteSkip,
  scaffoldTriggerPrompts,
  type ExecuteEnv,
} from "./scan-trigger-suggest.js";

describe("decideExecute", () => {
  // The default: an interactive human, something executable present, no sticky.
  const base: ExecuteEnv = {
    hasExecutable: true,
    isTTY: true,
    json: false,
    noInteractive: false,
  };

  it("ASKS once at a TTY when there's something to run and no sticky choice", () => {
    expect(decideExecute(base)).toEqual({ kind: "ask" });
  });

  it("nothing executable → skip 'nothing' (a clean read, no nudge)", () => {
    expect(decideExecute({ ...base, hasExecutable: false })).toEqual({
      kind: "skip",
      reason: "nothing",
    });
  });

  it("headless (non-TTY / --json / --no-interactive) stays a read → skip 'headless'", () => {
    expect(decideExecute({ ...base, isTTY: false })).toEqual({
      kind: "skip",
      reason: "headless",
    });
    expect(decideExecute({ ...base, json: true })).toEqual({
      kind: "skip",
      reason: "headless",
    });
    expect(decideExecute({ ...base, noInteractive: true })).toEqual({
      kind: "skip",
      reason: "headless",
    });
  });

  it("headless never executes — not even a remembered yes (audit is a local report, not CI)", () => {
    expect(decideExecute({ ...base, isTTY: false, remembered: true })).toEqual({
      kind: "skip",
      reason: "headless",
    });
  });

  it("interactive honors the sticky choice (no re-ask)", () => {
    expect(decideExecute({ ...base, remembered: true })).toEqual({
      kind: "run",
    });
    expect(decideExecute({ ...base, remembered: false })).toEqual({
      kind: "skip",
      reason: "remembered-no",
    });
  });
});

describe("formatExecuteSkip", () => {
  it("'nothing' → no nudge (a clean read)", () => {
    expect(formatExecuteSkip("nothing")).toBeNull();
  });

  it("headless points at interactive + the testing API (no execution flag exists)", () => {
    const note = formatExecuteSkip("headless");
    expect(note).toContain("skipped");
    expect(note).toContain("interactively");
    expect(note).toContain("`vigiles` testing API");
    expect(note).not.toContain("--measure");
  });

  it("remembered-no points at the config, not a flag", () => {
    const note = formatExecuteSkip("remembered-no");
    expect(note).toContain("audit.measure");
    expect(note).not.toContain("--measure`");
  });
});

describe("scaffoldTriggerPrompts", () => {
  it("emits the real TriggerPromptSet shape (name → {prompts, irrelevant})", () => {
    const json = scaffoldTriggerPrompts(["alpha", "beta"]);
    const parsed = JSON.parse(json) as Record<
      string,
      { prompts: string[]; irrelevant: string[] }
    >;
    expect(Object.keys(parsed)).toEqual(["alpha", "beta"]);
    expect(Array.isArray(parsed.alpha.prompts)).toBe(true);
    expect(parsed.alpha.prompts.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.alpha.irrelevant)).toBe(true);
    expect(parsed.beta.prompts[0]).toContain("beta");
  });
});
