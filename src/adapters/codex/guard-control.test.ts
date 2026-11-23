/**
 * The battery's control probe on Codex (unit tier — only `echo`/`exit` spawned).
 *
 * #213: exit 2 is the DENY code on Codex as on Claude Code, and an interpreter
 * that cannot open its script also exits 2. The control (`ls`, a command no guard
 * has a reason to deny) separates the two: blocked too ⇒ no verdict. Codex reads
 * the decision through its own `hookProtocol`, so the control has to be judged by
 * that protocol, not by Claude Code's. The Claude Code half is
 * ../../guardrail-check.test.ts and ../../verify-plugin-guards.test.ts.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGuardrail, type CaseOutcome } from "../../guardrail-check.js";
import { experimental_verifyPluginGuards } from "../../verify-plugin-guards.js";
import { codexAdapter } from "./adapter.js";
import { codexHookProtocol } from "./hook-protocol.js";

/** The outcome as one comparable tag. */
function tag(o: CaseOutcome): string {
  return o.kind === "not-run" ? `not-run/${o.why}` : o.kind;
}

const DENY = `echo '{"decision":"block"}'`;
const DENY_BUT_LS = `case "$(cat)" in *'"command":"ls"'*) exit 0;; esac; ${DENY}`;

/** A throwaway Codex repo whose only hook is a PreToolUse Bash guard. */
function codexRepo(command: string): string {
  const at = mkdtempSync(join(tmpdir(), "vigiles-codex-control-"));
  mkdirSync(join(at, ".codex"), { recursive: true });
  writeFileSync(join(at, "AGENTS.md"), "# codex repo\n");
  writeFileSync(
    join(at, ".codex", "config.toml"),
    [
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      `command = ${JSON.stringify(command)}`,
      "",
    ].join("\n"),
  );
  return at;
}

test("codex: a guard that blocks the control has no verdict", () => {
  const results = verifyGuardrail(DENY, { protocol: codexHookProtocol });
  assert.ok(results.length > 0);
  for (const r of results)
    assert.equal(tag(r.outcome), "not-run/control-blocked");
});

test("codex: a guard that lets the control through keeps its verdict", () => {
  for (const r of verifyGuardrail(DENY_BUT_LS, { protocol: codexHookProtocol }))
    assert.equal(tag(r.outcome), "blocked", r.event.id);
});

test("codex: the sweep reports a blocked control as `no-verdict`", () => {
  const cases: readonly [string, string][] = [
    [DENY, "no-verdict"],
    ["python3 missing.py", "no-verdict"],
    [DENY_BUT_LS, "measured"],
  ];
  for (const [command, status] of cases) {
    const at = codexRepo(command);
    try {
      const report = experimental_verifyPluginGuards(at, {
        adapter: codexAdapter,
        cwd: at,
      });
      assert.deepEqual(
        report.hooks.map((h) => h.status),
        [status],
        command,
      );
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }
});
