/**
 * Does the harness DELIVER a subagent's tool calls to `PreToolUse` — and does a
 * deny actually stop them?
 *
 * This is a claim about somebody else's product, and we had it wrong for months.
 * Claude Code issue #34692 ("PreToolUse does not fire for a subagent's tool
 * calls", closed not-planned) was quoted across our docs as a standing limit on
 * what a gate can promise. Measured 2026-08-24 against a stock
 * `@anthropic-ai/claude-code@2.1.241` installed straight from the registry: the
 * subagent's own `Bash` DOES reach the hook, and an exit-2 deny DOES stop it.
 *
 * So this file exists to keep the claim honest in BOTH directions. Prose in a
 * doc cannot notice that the platform moved; a test can. If Claude Code ever
 * reverts to the #34692 behaviour, this goes red and names what changed —
 * nobody has to remember to re-check.
 *
 * WHAT THIS DOES NOT SAY. Delivery is not invulnerability, and the surrounding
 * caveat survives untouched: a model can still route around a tool entirely
 * (#45427 / #32376 — a Bash heredoc instead of `Write`), so a gate remains a
 * strong default and is never "unbypassable". Only the delivery half changed.
 *
 * SCOPE, stated because it is the honest limit: this drives `claude -p`
 * (headless), which is what `runHarnessTest` can reach. Interactive sessions
 * are unmeasured, and subagent NESTING (depth 2) does not occur here at all —
 * an outer subagent given the spawn tool runs the work itself rather than
 * dispatching its own.
 */
import { describe, expect, it } from "vitest";

import { runHarnessTest, scriptModel } from "./harness-test.js";
import { onPathClaudeVersion } from "./adapters/claude-code/dialect-drift.js";

/** A subagent whose whole job is one observable side effect. */
const ECHOER = `---
name: echoer
description: Runs one harmless echo command and reports back.
tools: Bash
---
Run \\\`echo SUBAGENT_RAN > subagent-ran.txt\\\` then reply "echoer done".
`;

/**
 * A PreToolUse hook that denies ONLY a subagent's call. The discriminator is
 * `agent_id`, which the harness sets on an event originating inside a subagent
 * and omits on the parent's own calls — so the parent's IDENTICAL command is
 * the in-run control: if the parent's echo lands and the subagent's does not,
 * the block is attributable to the hook's decision, not to a broken subagent.
 */
const DENY_SUBAGENT_HOOK = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let e = {};
  try { e = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch {}
  require("node:fs").appendFileSync(process.argv[2], JSON.stringify({
    agent_id: e.agent_id ?? null, agent_type: e.agent_type ?? null, tool: e.tool_name ?? null,
  }) + "\\n");
  if (e.agent_id) { console.error("denied: subagent tool call"); process.exit(2); }
  process.exit(0);
});
`;

describe("subagent tool calls reach PreToolUse (the #34692 claim)", () => {
  // Loud skip, never a silent pass: the alarm only means something where the
  // real binary is present.
  const gate = onPathClaudeVersion() ? it : it.skip;

  if (!onPathClaudeVersion()) {
    it.skip("delivery check skipped — the claude binary is not on PATH", () => {
      /* gated above */
    });
  }

  gate(
    "a subagent's Bash is delivered AND blocked, while the parent's identical Bash runs",
    async () => {
      const r = await runHarnessTest({
        files: {
          ".claude/agents/echoer.md": ECHOER,
          "deny-subagent.cjs": DENY_SUBAGENT_HOOK,
        },
        settings: {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command:
                      "node {cwd}/deny-subagent.cjs {cwd}/hook-log.ndjson",
                  },
                ],
              },
            ],
          },
        },
        model: scriptModel([
          {
            tool: "Agent",
            input: {
              subagent_type: "echoer",
              description: "run echoer",
              prompt: "Run your one Bash command now.",
              run_in_background: false,
            },
          },
          {
            tool: "Bash",
            input: { command: "echo SUBAGENT_RAN > subagent-ran.txt" },
          },
          { text: "echoer done" },
          {
            tool: "Bash",
            input: { command: "echo PARENT_RAN > parent-ran.txt" },
          },
          { text: "parent done" },
        ]),
        prompt: "Dispatch the echoer subagent, then run your own echo.",
        allowedTools: ["Read", "Edit", "Write", "Bash", "Agent"],
        timeoutMs: 180_000,
        sandbox: false,
      });

      const events = (r.file("hook-log.ndjson") ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      // DELIVERY — the half that #34692 said was impossible.
      const fromSubagent = events.filter((e) => e.agent_id !== null);
      expect(
        fromSubagent.map((e) => e.tool),
        "a subagent's own Bash must reach PreToolUse",
      ).toContain("Bash");

      // The event carries WHICH subagent — the field that makes a per-agent
      // contract enforceable without tracking dispatches ourselves.
      expect(fromSubagent.map((e) => e.agent_type)).toContain("echoer");

      // ENFORCEMENT, by ground truth on disk rather than by the trace: the
      // denied command left no file, the allowed identical one did.
      expect(
        r.file("subagent-ran.txt"),
        "the denied subagent command must not have run",
      ).toBeNull();
      expect(
        r.file("parent-ran.txt"),
        "the parent's identical command is the control and must have run",
      ).toBe("PARENT_RAN\n");
    },
    200_000,
  );
});
