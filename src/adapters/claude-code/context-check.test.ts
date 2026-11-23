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
import { describe, expect, it } from "vitest";

import {
  buildAgentArgs,
  closedRun,
  formatEvalReport,
  resolveSpawnEnv,
  runEvalWith,
  type AgentRunner,
  type RunOut,
} from "../../eval.js";
import { startMock } from "../../mock-model.js";
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
        env: { kind: "ephemeral" },
      },
      mockRunner(mock.url, extra),
    );
    return { report, text: formatEvalReport(report) };
  } finally {
    mock.close();
  }
}

const gate = onPathClaudeVersion() ? it : it.skip;
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
    "a lone AGENTS.md is expected and delivered",
    async () => {
      const { report } = await evalIn({
        "AGENTS.md": "Always answer CONTEXT_SENTINEL_C.\n",
      });
      expect(report.arms["skill"]?.context).toEqual([
        { kind: "delivered", files: ["AGENTS.md"] },
        { kind: "delivered", files: ["AGENTS.md"] },
      ]);
    },
    120_000,
  );

  gate(
    "a BOM and an HTML comment, which the client strips, are not a false missing",
    async () => {
      const { report } = await evalIn({
        "CLAUDE.md":
          "﻿First line CONTEXT_SENTINEL_D.\r\n<!-- a note for humans -->\r\nLast line.\r\n",
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
