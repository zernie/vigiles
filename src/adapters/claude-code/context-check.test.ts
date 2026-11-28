/**
 * Every `runEval` trial checks that the project's instruction files reached the
 * model's FIRST request (vigiles#416), on the real path: the real `claude`
 * binary against the scripted mock model — no key, no cost.
 *
 * The defect this pins: a trial whose instruction file never loaded used to
 * score like any other — exit 0, a number, an arm difference — because "the
 * file was in the directory" stood in for evidence. Here the run is made to
 * drop `CLAUDE.md` (`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, one of the six measured
 * ways it silently does not load) and the trial must come back `missing` and
 * unscored.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildAgentArgs,
  closedRun,
  resolveSpawnEnv,
  runEvalReporting,
  runEvalWith,
  type AgentRunner,
  type EvalReport,
  type RunOut,
} from "../../eval.js";
import { contextInReport } from "../../core/eval-report-failures.js";
import { formatEvalReport } from "../../eval-format.js";
import {
  expectedInstructions,
  type ContextEvidence,
} from "../../core/context-evidence.js";
import { runFailure } from "../../eval-entry.js";
import { startContextCapture } from "../../eval-context.js";
import { claudeCodeLayout } from "./layout.js";
import { startMock } from "../../mock-model.js";
import { firstClaudeRequest } from "./request-capture.io.js";
import { onPathClaudeVersion } from "./dialect-drift.js";
import { claudeCodeRuntime } from "./runtime.js";

/** `spawnAgent`'s spawn, pointed at the mock, with `extra` env on top. */
function mockRunner(
  baseUrl: string,
  extra: Record<string, string> = {},
): AgentRunner {
  return (a) =>
    new Promise<RunOut>((done) => {
      const env = {
        ...resolveSpawnEnv(a),
        ...claudeCodeRuntime.wireMock(baseUrl).env,
        ...extra,
      };
      const child = spawn(claudeCodeRuntime.agentBinary, buildAgentArgs(a), {
        cwd: a.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code, signal) => {
        done(closedRun({ code, signal, timedOut: false, stdout, stderr }));
      });
    });
}

async function evalIn(
  files: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const mock = await startMock(
    Array.from({ length: 10 }, () => ({ text: "ok" })),
  );
  try {
    const report = await runEvalWith(
      {
        name: "context",
        arms: { skill: { files } },
        task: "say ok",
        measure: () => ({ ran: true }),
        trials: 2,
        spacingSec: 0,
        env: { kind: "local", inherit: "none" },
      },
      mockRunner(mock.url, extra),
    );
    return { report, text: formatEvalReport(report) };
  } finally {
    mock.close();
  }
}

const gate = onPathClaudeVersion() ? it : it.skip;

/** Does the `claude` on PATH read a lone `AGENTS.md` (v2.1.277 and later)? */
function readsAgentsMd(): boolean {
  const [major = 0, minor = 0, patch = 0] = (onPathClaudeVersion() ?? "0.0.0")
    .split(".")
    .map(Number);
  return major * 1e6 + minor * 1e3 + patch >= 2_001_277;
}
if (!onPathClaudeVersion())
  it.skip("context check skipped — the claude binary is not on PATH", () => {
    /* gated above */
  });

describe("the per-trial context check, on the real binary", () => {
  gate(
    "a CLAUDE.md the run never loaded is missing in every trial, and those trials are not scored",
    async () => {
      const { report, text } = await evalIn(
        { "CLAUDE.md": "Always answer CONTEXT_SENTINEL_A.\n" },
        { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
      );
      const arm = report.arms["skill"];
      expect(arm?.context?.map((e) => e.kind)).toEqual(["missing", "missing"]);
      expect(arm?.runs).toBe(0);
      expect(text).toContain(
        "✗ context: CLAUDE.md missing from the model's request in 2 of 2 trials — not scored",
      );
    },
    120_000,
  );

  gate(
    "a CLAUDE.md that loaded is delivered",
    async () => {
      const { report, text } = await evalIn({
        "CLAUDE.md": "Always answer CONTEXT_SENTINEL_B.\n",
      });
      expect(report.arms["skill"]?.context?.map((e) => e.kind)).toEqual([
        "delivered",
        "delivered",
      ]);
      expect(report.arms["skill"]?.runs).toBe(2);
      expect(text).toContain("✓ context: CLAUDE.md delivered in 2 of 2 trials");
    },
    120_000,
  );

  gate(
    "a lone AGENTS.md is expected; delivered from v2.1.277, missing before",
    async () => {
      const { report } = await evalIn({
        "AGENTS.md": "Always answer CONTEXT_SENTINEL_C.\n",
      });
      // "Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later"
      // (instruction-chain.ts). An older client (the CI pin) drops it, and the
      // check must say so instead of scoring the trial.
      const trial = readsAgentsMd()
        ? { kind: "delivered", files: ["AGENTS.md"] }
        : { kind: "missing", files: ["AGENTS.md"], delivered: [] };
      expect(report.arms["skill"]?.context).toEqual([trial, trial]);
    },
    120_000,
  );
});

describe("what the context check expects, on the real binary", () => {
  gate(
    "a BOM and an HTML comment, which the client strips, are not a false missing",
    async () => {
      const { report } = await evalIn({
        "CLAUDE.md":
          "\uFEFFFirst line CONTEXT_SENTINEL_D.\r\n<!-- a note for humans -->\r\nLast line.\r\n",
      });
      expect(report.arms["skill"]?.context?.map((e) => e.kind)).toEqual([
        "delivered",
        "delivered",
      ]);
    },
    120_000,
  );

  gate(
    "a world with no instruction file expects nothing, and says so",
    async () => {
      const { report, text } = await evalIn({ "notes.txt": "x" });
      expect(report.arms["skill"]?.context?.map((e) => e.kind)).toEqual([
        "nothing-expected",
        "nothing-expected",
      ]);
      expect(text).toContain("context: no instruction files in this arm");
    },
    120_000,
  );
});

describe("the Claude Code request channel, without the binary", () => {
  it("reads nothing from a directory the run never wrote to", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-requests-test-"));
    try {
      expect(firstClaudeRequest(dir)).toBeUndefined();
      expect(firstClaudeRequest(join(dir, "gone"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a broken index line and a side-channel request for the agent loop's", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-requests-test-"));
    try {
      writeFileSync(
        join(dir, "index.jsonl"),
        [
          "not json",
          JSON.stringify({ request_file: "side.request.json" }),
          JSON.stringify({ request_file: "gone.request.json" }),
          JSON.stringify({ request_file: "main.request.json" }),
          JSON.stringify({ other: 1 }),
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "side.request.json"),
        JSON.stringify({ system: "classifier" }),
      );
      writeFileSync(
        join(dir, "main.request.json"),
        JSON.stringify({ tools: [{ name: "Bash" }], system: ["MAIN_LOOP", 1] }),
      );
      const body = firstClaudeRequest(dir);
      expect(body).toContain("MAIN_LOOP");
      expect(body).not.toContain("classifier");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the Claude Code request channel, from a client without an index", () => {
  it("orders the request files by when they were written", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-requests-test-"));
    try {
      // 2.1.187 (the CI pin) writes `<id>.request.json` and no index.jsonl.
      const write = (name: string, body: unknown, at: number): void => {
        writeFileSync(join(dir, name), JSON.stringify(body));
        utimesSync(join(dir, name), at, at);
      };
      write(
        "b.request.json",
        { tools: [{ name: "Bash" }], system: "SECOND" },
        2,
      );
      write(
        "z.request.json",
        { tools: [{ name: "Bash" }], system: "FIRST" },
        1,
      );
      write("a.response.json", { content: "not a request" }, 0);
      expect(firstClaudeRequest(dir)).toContain("FIRST");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runEval's own warning, without the binary", () => {
  it("prints the missing instruction file to stderr, not only into the report", async () => {
    // A stand-in client: writes a first request that lacks CLAUDE.md where the
    // channel's env points, as a client that dropped the file would.
    const runner: AgentRunner = (a) => {
      const target = a.env?.["OTEL_LOG_RAW_API_BODIES"] ?? "";
      const dir = target.slice("file:".length);
      writeFileSync(
        join(dir, "r.request.json"),
        JSON.stringify({ tools: [{ name: "Bash" }], system: "no file here" }),
      );
      return Promise.resolve({ code: 0, stdout: "" });
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const report = await runEvalReporting(
        {
          name: "context",
          arms: { skill: { files: { "CLAUDE.md": "Always answer X.\n" } } },
          task: "say ok",
          measure: () => ({ ran: true }),
          trials: 1,
          spacingSec: 0,
          env: { kind: "local", inherit: "none" },
        },
        runner,
      );
      expect(report.arms["skill"]?.context?.map((e) => e.kind)).toEqual([
        "missing",
      ]);
      const printed = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("⚠ runEval:");
      expect(printed).toContain("CLAUDE.md");
    } finally {
      err.mockRestore();
    }
  });
});

describe("what a trial expects, without the binary", () => {
  it("expects an @-import as a file of its own, from the chain, not the author", () => {
    expect(
      expectedInstructions(claudeCodeLayout, {
        "CLAUDE.md": "@docs/style.md\nRules.\n",
        "docs/style.md": "Use tabs.\n",
        "src/a.ts": "x",
      }).map((e) => e.path),
    ).toEqual(["CLAUDE.md", "docs/style.md"]);
  });

  it("an opted-out trial is not checked and opens no channel", () => {
    const capture = startContextCapture({
      runtime: claudeCodeRuntime,
      world: { "CLAUDE.md": "x" },
      enabled: false,
    });
    expect(capture.env).toEqual({});
    capture.reset();
    expect(capture.finish()).toEqual({
      kind: "unobservable",
      why: "opted-out",
      files: ["CLAUDE.md"],
    });
    capture.dispose();
  });
});

describe("a missing instruction file fails the eval", () => {
  const usage = {
    totalCostUsd: 0,
    meanCostUsd: 0,
    meanDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
  };
  const report = (context: readonly ContextEvidence[]): EvalReport => ({
    name: "e",
    trials: 1,
    arms: {
      skill: {
        runs: 0,
        metrics: {},
        stats: {},
        usage,
        unansweredStubCalls: [],
        context,
      },
    },
    totalCostUsd: 0,
    aborted: false,
  });
  const missing: ContextEvidence = {
    kind: "missing",
    files: ["AGENTS.md"],
    delivered: [],
  };

  it("names the arm and the file, before the zero-runs line", () => {
    expect(contextInReport(report([missing]))).toContain(
      "skill: ✗ context: AGENTS.md missing from the model's request in 1 of 1 trials — not scored",
    );
    expect(
      runFailure("x.eval.mjs", "runEval", report([missing]), {}),
    ).toMatchObject({ code: 1 });
    expect(
      runFailure("x.eval.mjs", "runEval", report([missing]), {})?.message,
    ).toContain("not scored");
  });

  it("a not-checked trial does not fail it", () => {
    expect(
      contextInReport(
        report([{ kind: "unobservable", why: "no-request-body", files: [] }]),
      ),
    ).toBeUndefined();
  });
});
