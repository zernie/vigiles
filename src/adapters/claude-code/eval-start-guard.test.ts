/**
 * A run that never reached the model is not a trial.
 *
 * Measured 2026-10-06 on Claude Code 2.1.291: `allowedTools: []` built a bare
 * `--allowedTools` flag, the CLI exited 1 with "argument missing" before any
 * model turn, and `paid_measureArms` scored six such runs as trials — a 0% rate
 * on one check and a 100% on another, over runs that asked the model nothing.
 */
import { describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentArgs,
  runEvalWith,
  runPool,
  startFailure,
  withStartGuard,
  type AgentRunArgs,
  type RunContext,
  type RunOut,
} from "../../eval.js";
import { buildClaudeArgs } from "../../harness-test.js";

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
  // `allowedTools` is a permission allowlist (`--allowedTools`). An empty list
  // pre-approves nothing, so the flag is left out; a bare `--allowedTools` is a
  // usage error that exits before calling the model.
  it("an empty list leaves the flag out, in the eval tier", () => {
    const argv = buildAgentArgs({ ...args, tools: [] });
    expect(argv).not.toContain("--allowedTools");
    expect(argv).not.toContain("--tools");
  });

  it("an empty list leaves the flag out, in the harness tier", () => {
    const argv = buildClaudeArgs({ model: [], allowedTools: [] }, false);
    expect(argv).not.toContain("--allowedTools");
  });

  it("a non-empty list is allowed as before", () => {
    const argv = buildAgentArgs({ ...args, tools: ["Read", "Edit"] });
    expect(argv.slice(-3)).toEqual(["--allowedTools", "Read", "Edit"]);
  });
});

describe("startFailure", () => {
  it("names a run that exited before calling the model, with the harness's own words", () => {
    expect(startFailure(CRASH)).toMatch(
      /exited 1 before calling the model.*argument missing/s,
    );
  });

  it("is null for a run that reached the model, whatever its exit code", () => {
    expect(startFailure({ code: 1, stdout: RESULT, stderr: "" })).toBeNull();
    expect(startFailure({ code: 0, stdout: RESULT, stderr: "" })).toBeNull();
  });

  it("is null for a run that reached the model and then crashed", () => {
    // An assistant event means the model was called; a missing `result` then
    // means the run broke later, which is a scored outcome, not a start failure.
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "hi" }] },
    });
    expect(
      startFailure({
        code: 1,
        stdout: assistantLine,
        stderr: "socket hang up",
      }),
    ).toBeNull();
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
    await expect(guarded(args)).rejects.toThrow(/before calling the model/);
  });

  it("passes a run that reached the model through unchanged", async () => {
    const ok: RunOut = { code: 0, stdout: RESULT, stderr: "" };
    await expect(withStartGuard(() => Promise.resolve(ok))(args)).resolves.toBe(
      ok,
    );
  });
});

describe("a cached run is held to the same guard", () => {
  it("a crash cached before the guard existed is run again, not replayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "start-guard-cache-"));
    const spec = (measure: (ctx: RunContext) => { ok: boolean }) => ({
      env: { kind: "inherit", reason: "unit test: a fake runner" } as const,
      arms: { a: {} },
      task: "t",
      trials: 1,
      spacingSec: 0,
      model: "claude-haiku-4-5-20251001",
      cache: "readwrite" as const,
      cacheDir: dir,
      measure,
    });
    try {
      // An unguarded runner, as the real one was before: the crash is cached.
      await runEvalWith(
        spec(() => ({ ok: false })),
        () => Promise.resolve(CRASH),
      );
      const calls: number[] = [];
      const report = await runEvalWith(
        spec((ctx) => ({ ok: ctx.output === "ok" })),
        () => {
          calls.push(1);
          return Promise.resolve({ code: 0, stdout: RESULT, stderr: "" });
        },
      );
      expect(calls).toHaveLength(1);
      expect(report.arms.a?.stats.ok?.mean).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runPool stops handing out work once a worker throws", () => {
  it("does not start the remaining items after a failure", async () => {
    const started: number[] = [];
    const run = runPool([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i);
      if (i === 0) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 10));
      return i;
    });
    await expect(run).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([0, 1]);
  });
});
