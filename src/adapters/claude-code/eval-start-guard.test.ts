/**
 * A run that never reached the model is not a trial.
 *
 * Measured 2026-10-06 on Claude Code 2.1.291: `allowedTools: []` built a bare
 * `--allowedTools` flag, the CLI exited 1 with "argument missing" before any
 * model turn, and `paid_measureArms` scored six such runs as trials — a 0% rate
 * on one check and a 100% on another, over runs that asked the model nothing.
 */
import { describe, expect, it } from "vitest";

import {
  buildAgentArgs,
  startFailure,
  withStartGuard,
  type AgentRunArgs,
  type RunOut,
} from "../../eval.js";

const args: AgentRunArgs = {
  task: "t",
  cwd: "/tmp/x",
  model: "sonnet",
  tools: ["Read"],
  hasSettings: false,
  pluginDir: undefined,
  timeoutMs: 1000,
};
const RESULT = JSON.stringify({ type: "result", result: "ok", num_turns: 1 });
const CRASH: RunOut = {
  code: 1,
  stdout: "",
  stderr:
    "error: option '--allowedTools, --allowed-tools <tools...>' argument missing",
};

describe("the tool list on the command line", () => {
  it("an empty list disables every tool, not a flag with no value", () => {
    const argv = buildAgentArgs({ ...args, tools: [] });
    expect(argv).not.toContain("--allowedTools");
    expect(
      argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2),
    ).toEqual(["--tools", ""]);
  });

  it("a non-empty list is allowed as before", () => {
    const argv = buildAgentArgs({ ...args, tools: ["Read", "Edit"] });
    expect(argv.slice(-3)).toEqual(["--allowedTools", "Read", "Edit"]);
    expect(argv).not.toContain("--tools");
  });
});

describe("startFailure", () => {
  it("names a run that exited before any model turn, with the harness's own words", () => {
    expect(startFailure(CRASH)).toMatch(
      /exited 1 before any model turn.*argument missing/s,
    );
  });

  it("is null for a run that reached the model, whatever its exit code", () => {
    expect(startFailure({ code: 1, stdout: RESULT, stderr: "" })).toBeNull();
    expect(startFailure({ code: 0, stdout: RESULT, stderr: "" })).toBeNull();
  });

  it("is null for a rate-limited run, which the retry loop handles", () => {
    expect(
      startFailure({ code: 1, stdout: "", stderr: "429 rate_limit_error" }),
    ).toBeNull();
  });
});

describe("withStartGuard", () => {
  it("throws instead of handing back a run that never reached the model", async () => {
    const guarded = withStartGuard(() => Promise.resolve(CRASH));
    await expect(guarded(args)).rejects.toThrow(/before any model turn/);
  });

  it("passes a run that reached the model through unchanged", async () => {
    const ok: RunOut = { code: 0, stdout: RESULT, stderr: "" };
    await expect(withStartGuard(() => Promise.resolve(ok))(args)).resolves.toBe(
      ok,
    );
  });
});
