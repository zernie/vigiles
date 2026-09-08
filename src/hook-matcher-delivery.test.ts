/**
 * Which matcher strings does the harness actually honour as "every tool"?
 *
 * This is a claim about somebody else's product, and we had it wrong. `**` sat
 * in `MATCH_ALL` (core/hook-matcher.ts) with no measurement behind it, while the
 * measured semantics table at the top of that same file never mentioned it — an
 * assumption load-bearing enough that a guard registered under `**` would be
 * reported as having ALLOWED the whole disaster battery.
 *
 * 🔴 THAT DIRECTION MANUFACTURES AN ACCUSATION, which is why it is pinned here
 * rather than left to prose. Believing a matcher selects more than it does makes
 * the sweep run a battery the harness would never have handed the hook, then
 * publish the result as the guard's own verdict: "your guard let seven disasters
 * through", about a guard the harness never spawned. It is the exact mirror of
 * scoring a hook that could not start, and both were found in the same run.
 *
 * The ORACLE is a marker file, not the transcript: each hook's only job is to
 * append a line, so "did the harness spawn it?" is answered by ground truth on
 * disk. `.*` is the IN-RUN CONTROL — it is measured in the same session, on the
 * same tool call, so a run where nothing at all fired cannot be misread as
 * evidence about `**`.
 *
 * ONE MORE ALTERNATIVE EXPLANATION WAS RULED OUT BY HAND, because the control
 * above does not reach it: perhaps the harness spawns only the FIRST matching
 * hook for an event, and `**` was simply second. Swapping `**` for `*` in this
 * exact fixture makes BOTH markers appear, so a second registration on the same
 * event does fire — the silence belongs to the matcher, not to the position.
 *
 * SCOPE, stated because it is the honest limit: this drives `claude -p`
 * (headless), which is what `runHarnessTest` can reach; interactive sessions are
 * unmeasured. It says nothing about how any OTHER harness reads `**` — Codex
 * declares `matcherStyle: "regex"`, where the same string is uncompilable for a
 * different reason.
 *
 * Same shape and same reason as `src/subagent-delivery.test.ts`: prose in a doc
 * cannot notice that the platform moved, a test can. If Claude Code ever starts
 * honouring `**`, this goes red and names what changed.
 */
import { describe, expect, it } from "vitest";

import { runHarnessTest, scriptModel } from "./harness-test.js";
import { onPathClaudeVersion } from "./dialect-drift.js";

/**
 * A hook whose entire job is to record that it was spawned. It takes the marker
 * name as an argument so ONE script serves both arms — two copies could differ,
 * and then a difference in firing would not be attributable to the matcher.
 */
const MARKER_SCRIPT = `
require("node:fs").appendFileSync(process.argv[2], process.argv[3] + "\\n");
process.exit(0);
`;

const markerHook = (name: string) => ({
  type: "command" as const,
  command: `node {cwd}/marker.cjs {cwd}/fired.ndjson ${name}`,
});

describe("which matchers Claude Code honours as match-all", () => {
  // Loud skip, never a silent pass: the alarm only means something where the
  // real binary is present.
  const version = onPathClaudeVersion();
  const gate = version ? it : it.skip;

  if (!version) {
    it.skip("matcher-delivery check skipped — no claude binary on PATH", () => {
      /* gated above */
    });
  }

  gate(
    "`.*` fires on a Bash call and `**` does not",
    async () => {
      const r = await runHarnessTest({
        files: { "marker.cjs": MARKER_SCRIPT },
        settings: {
          hooks: {
            PreToolUse: [
              { matcher: ".*", hooks: [markerHook("control")] },
              { matcher: "**", hooks: [markerHook("glob")] },
            ],
          },
        },
        model: scriptModel([
          { tool: "Bash", input: { command: "echo hello" } },
          { text: "done" },
        ]),
        prompt: "Run one echo.",
        allowedTools: ["Bash"],
        timeoutMs: 120_000,
        sandbox: false,
      });

      const fired = (r.file("fired.ndjson") ?? "").split("\n").filter(Boolean);

      // THE CONTROL FIRST. Without it, an empty file would "prove" the claim
      // while actually proving that the session never made the tool call.
      expect(
        fired,
        `the .* control must fire, or this run measured nothing (claude ${version ?? "?"})`,
      ).toContain("control");

      // THE CLAIM. `**` is not honoured as a match-all.
      expect(
        fired,
        "`**` must NOT be honoured as a match-all — if this fires, MATCH_ALL in core/hook-matcher.ts needs it back",
      ).not.toContain("glob");
    },
    150_000,
  );
});
