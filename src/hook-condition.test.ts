/**
 * Hook-condition suite (vitest, unit tier — nothing but `echo` is ever spawned).
 *
 * Three halves, cheapest first:
 *   1. the SEVEN documented Bash-matching rows, transcribed from Claude Code's
 *      hooks docs, table-driven so a row cannot be quietly dropped;
 *   2. the boundary — `normalizeHooks` carries the key, and the key it reads is
 *      bound to the one the port declares, so a rename fails here;
 *   3. the load-bearing half: the REAL vendored davila7 guard driven through
 *      `runGuardrail` in BOTH directions — honoured, only the force pushes
 *      reach it; dropped, the original 7/7 false green comes back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeHookCondition } from "./adapters/claude-code/hook-condition.js";
import { claudeCodeHookProtocol } from "./adapters/claude-code/hook-protocol.js";
import { decideHookCondition } from "./core/hook-condition.js";
import { normalizeHooks } from "./core/hook-normalize.js";
import {
  disasters,
  runGuardrail,
  guardrailHolds,
  unblockedDisasters,
  formatGuardrailReport,
  DISASTER_CATALOG,
} from "./guardrail-check.js";
import { runHook } from "./run-hook.js";

const bash = (command: string) => ({
  event: "PreToolUse",
  tool: "Bash",
  input: { command },
});

const runs = (condition: string, command: string) =>
  claudeCodeHookCondition.matches(condition, bash(command)).runs;

describe("claudeCodeHookCondition — the documented Bash matching table", () => {
  // Verbatim from Claude Code's hooks docs, "Bash if matching". The last two rows
  // are the FAIL-OPEN half and are why a blanket "contains $ ⇒ run" is wrong:
  // rows 4 and 5 also contain `$(` and must answer NO.
  const rows: ReadonlyArray<[string, string, boolean, string]> = [
    ["Bash(git *)", "FOO=bar git push", true, "leading assignments stripped"],
    ["Bash(git *)", "npm test && git push", true, "each subcommand is checked"],
    ["Bash(rm *)", "echo $(rm -rf /)", true, "commands inside $() are checked"],
    ["Bash(rm *)", "echo $(date)", false, "no subcommand matches"],
    [
      "Bash(cat *)",
      "echo before $(date) after",
      false,
      "full command and date both checked, neither matches",
    ],
    [
      "Bash(git *)",
      "$TOOL git push",
      true,
      "the command name is unknowable, so it runs",
    ],
    [
      "Bash(git push *)",
      "echo $(date)",
      true,
      "argument-bearing pattern + dynamic command runs anyway",
    ],
  ];

  for (const [pattern, command, expected, why] of rows) {
    it(`${pattern} vs \`${command}\` → ${expected ? "runs" : "does NOT run"} (${why})`, () => {
      expect(runs(pattern, command)).toBe(expected);
    });
  }

  it("also catches a backtick substitution, like $()", () => {
    expect(runs("Bash(rm *)", "echo `rm -rf /`")).toBe(true);
  });

  it("keeps a quoted operand instead of dropping it", () => {
    // The literal-word extractor drops `'skip hooks'`; the normalized one keeps
    // it. Using both is what stops a quoted argument silently shrinking a command
    // into a non-match.
    expect(
      runs("Bash(git commit *skip hooks*)", "git commit -m 'skip hooks'"),
    ).toBe(true);
  });
});

describe("claudeCodeHookCondition — rule shapes", () => {
  it("a bare tool name matches every call to that tool", () => {
    expect(runs("Bash", "rm -rf /")).toBe(true);
  });

  it("a rule naming a DIFFERENT tool never runs", () => {
    const v = claudeCodeHookCondition.matches("Edit(*.ts)", bash("rm -rf /"));
    expect(v.runs).toBe(false);
    expect(v.why).toContain("names Edit");
  });

  it("matches a non-Bash tool against its path input", () => {
    const call = {
      event: "PreToolUse",
      tool: "Edit",
      input: { file_path: "/repo/src/a.ts" },
    };
    expect(claudeCodeHookCondition.matches("Edit(*.ts)", call).runs).toBe(true);
    expect(claudeCodeHookCondition.matches("Edit(*.py)", call).runs).toBe(
      false,
    );
  });

  it("FAILS OPEN on a rule it cannot parse", () => {
    // The safety asymmetry: an unreadable rule may never turn into "we skipped
    // this hook", because that would be a false alarm we invented.
    expect(runs("!!! not a rule", "rm -rf /")).toBe(true);
  });
});

describe("decideHookCondition — the neutral event rule", () => {
  it("no condition ⇒ unconditional", () => {
    expect(
      decideHookCondition(undefined, bash("rm -rf /"), claudeCodeHookCondition)
        .runs,
    ).toBe(true);
    expect(
      decideHookCondition("", bash("rm -rf /"), claudeCodeHookCondition).runs,
    ).toBe(true);
  });

  it("a harness with no condition support treats every hook as unconditional", () => {
    expect(
      decideHookCondition("Bash(git push *)", bash("rm -rf /"), undefined).runs,
    ).toBe(true);
  });

  it("a condition on a NON-tool event means the hook never runs", () => {
    const v = decideHookCondition(
      "Bash(git *)",
      { event: "Stop", tool: "", input: {} },
      claudeCodeHookCondition,
    );
    expect(v.runs).toBe(false);
    expect(v.why).toContain("only evaluated on");
  });
});

describe("the boundary carries the field", () => {
  it("normalizeHooks reads the condition off a Claude Code action", () => {
    const raw = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              if: "Bash(git push *--force*)",
              command: "guard.sh",
            },
            { type: "command", command: "audit.sh" },
          ],
        },
      ],
    };
    expect(normalizeHooks(raw)).toEqual([
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "guard.sh",
        condition: "Bash(git push *--force*)",
      },
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "audit.sh",
        condition: null,
      },
    ]);
  });

  it("binds the key the reader uses to the key the port declares", () => {
    // Two spellings of one fact would drift silently: the reader would find
    // nothing and every hook would look unconditional again — the exact defect.
    const [reg] = normalizeHooks({
      PreToolUse: [
        {
          hooks: [
            {
              command: "x.sh",
              [claudeCodeHookCondition.field]: "Bash(git *)",
            },
          ],
        },
      ],
    });
    expect(reg?.condition).toBe("Bash(git *)");
  });

  it("is reachable from the protocol port", () => {
    expect(claudeCodeHookProtocol.condition).toBe(claudeCodeHookCondition);
  });
});

describe("runHook honours a declared condition", () => {
  const DENY = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'`;

  it("does not spawn the hook when the condition does not match", () => {
    const r = runHook(
      DENY,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      },
      { condition: "Bash(git push *--force*)" },
    );
    expect(r.ran).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.stdout).toBe("");
  });

  it("spawns and blocks when it does match", () => {
    const r = runHook(
      DENY,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
      },
      { condition: "Bash(git push *--force*)" },
    );
    expect(r.ran).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it("with NO condition the behaviour is exactly as before", () => {
    const r = runHook(DENY, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    expect(r.ran).toBe(true);
    expect(r.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The load-bearing half: the REAL vendored guard, both directions.
// ---------------------------------------------------------------------------

const VENDOR = join(
  __dirname,
  "..",
  "test",
  "dogfood",
  "davila7-force-push-blocker@869640b",
  ".claude",
  "settings.json",
);

function vendoredHooks() {
  const settings = JSON.parse(readFileSync(VENDOR, "utf8")) as {
    hooks: unknown;
  };
  const regs = normalizeHooks(settings.hooks);
  expect(regs).toHaveLength(2);
  return regs;
}

/** The seven catalog disasters only: these tests are about the condition. */
const CATALOG_ONLY = disasters({ harmless: [], spellings: [] });

type Vendored = {
  readonly command: string;
  readonly condition?: string | null;
};

/** The same, run under a hook's declared `if`. */
function withIf(hook: Vendored | undefined) {
  return { condition: hook?.condition ?? undefined };
}

/** The catalog run on a vendored hook, under its declared `if`. */
function runUnderIf(hook: Vendored | undefined) {
  return runGuardrail(hook?.command ?? "", CATALOG_ONLY, withIf(hook));
}

describe("davila7 force-push-blocker (vendored, MIT) — the measured false green", () => {
  it("its actions really do carry `if` with an unconditional deny body", () => {
    // Grounds every number below in the upstream file rather than a synthetic
    // stand-in: if the vendor is ever re-pinned to a file without `if`, this
    // fails instead of the suite quietly testing nothing.
    const [first, second] = vendoredHooks();
    expect(first?.condition).toBe("Bash(git push *--force*)");
    expect(second?.condition).toBe("Bash(git push *-f*)");
    expect(first?.command).toContain(`"permissionDecision":"deny"`);
    expect(first?.command.startsWith("echo ")).toBe(true);
  });

  it("WITHOUT the condition it is certified as blocking all 7 — the defect", () => {
    // The exact behaviour measured before this change. Kept as a test because it
    // is the thing that must never come back: drop the condition and the battery
    // hands a bare `echo deny` a perfect score against rm -rf / and ~/.ssh reads.
    const [first] = vendoredHooks();
    const results = runGuardrail(first?.command ?? "", CATALOG_ONLY).rows;
    expect(results.filter((r) => r.blocked)).toHaveLength(
      DISASTER_CATALOG.length,
    );
    expect(unblockedDisasters(results)).toHaveLength(0);
  });

  it("WITH the condition only the force push reaches it", () => {
    const [first] = vendoredHooks();
    const results = runUnderIf(first).rows;

    const blocked = results.filter((r) => r.blocked).map((r) => r.event.id);
    expect(blocked).toEqual(["force-push"]);

    // Everything else is NOT RUN — a different fact from "allowed", and the one
    // the report has to be able to state.
    const notRun = results.filter((r) => !r.ran).map((r) => r.event.id);
    expect(notRun).toEqual([
      "force-push-compound",
      "reset-hard",
      "rm-rf",
      "no-verify-commit",
      "read-ssh-key",
      "curl-pipe-sh",
    ]);
    for (const r of results.filter((x) => !x.ran))
      expect(r.reason).toContain("does not match");
  });

  it("its second action catches the compound force push its first misses", () => {
    // `git push -f` hidden behind `cd repo && git commit … &&` — the AST-backed
    // leaf walk is what sees it, and the -f pattern is what admits it.
    const [, second] = vendoredHooks();
    const results = runUnderIf(second).rows;
    expect(results.filter((r) => r.blocked).map((r) => r.event.id)).toEqual([
      "force-push",
      "force-push-compound",
    ]);
  });

  it("guardrailHolds FAILS and says NOT RUN, not `exit 0`", () => {
    const [first] = vendoredHooks();
    const verdict = guardrailHolds().eval(
      runGuardrail(first?.command ?? "", disasters(), withIf(first)),
    );
    expect(verdict.pass).toBe(false);
    const message = verdict.message;
    expect(message).toContain("NOT RUN");
    expect(message).toContain("rm -rf");
    // The old wording would have blamed an exit code for a process that never
    // existed, which reads as "the guard considered this and allowed it".
    expect(message).not.toContain("rm -rf of a broad path (exit");
  });

  it("the coverage report distinguishes not-run from allows", () => {
    const [first] = vendoredHooks();
    const report = formatGuardrailReport(
      first?.command ?? "",
      runUnderIf(first).rows,
    );
    expect(report).toContain("⊘ not run");
    expect(report).toContain("blocks 1/7");
  });
});
