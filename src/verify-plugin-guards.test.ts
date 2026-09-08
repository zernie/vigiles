/**
 * Plugin-guard sweep suite (vitest, unit tier — nothing but `echo`/`exit` is ever
 * spawned, no model, no key).
 *
 * The load-bearing half is a fixture plugin carrying the three shapes the report
 * has to tell apart, and it is written so a single mistaken verdict is visible:
 * a CONDITIONAL guard reachable by only part of the battery, an UNCONDITIONAL one
 * that blocks all of it, and hooks the battery cannot reach at all — by event, by
 * matcher, and by an unresolvable command. All three of the last kind must read
 * as their own status, never as a score of zero.
 *
 * Beside it, the REAL vendored davila7 guard (the artifact #211 was measured on)
 * proves the condition is read off the CONFIG rather than passed by the caller —
 * the whole point of this function existing next to `verifyGuardrail`.
 *
 * BOTH HARNESSES: the same sweep runs over a Codex-shaped repo (flat TOML hooks,
 * `${PLUGIN_ROOT}`), which is what could catch a Claude-Code assumption baked into
 * the agnostic path — a CC-shaped fixture structurally cannot. And a harness with
 * no shell hooks (the opencode prototype) is asserted to report n/a in words.
 *
 * The last block covers the RENDERER over the same fixtures. Its contract is
 * that the union's honesty survives being turned into text — so the load-bearing
 * assertion there is two-directional: a sweep that measured nothing must contain
 * NO score-shaped string and MUST contain the words saying nothing was measured.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_verifyPluginGuards,
  experimental_formatPluginGuardReport,
  type PluginGuardReport,
} from "./verify-plugin-guards.js";
import { DISASTER_CATALOG } from "./guardrail-check.js";
import { hookMatcherReach } from "./core/hook-matcher.js";
import { codexAdapter } from "./adapters/codex/adapter.js";
import { opencodeAdapter } from "./adapters/opencode/adapter.js";

/** Denies every call it is spawned for — the unconditional-guard shape. */
const DENY_ALL = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'`;
/** Runs and allows — an ordinary observing hook, not a guard. */
const ALLOW_ALL = `echo watching`;

const VENDOR = join(
  __dirname,
  "..",
  "test",
  "dogfood",
  "davila7-force-push-blocker@869640b",
);

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vigiles-sweep-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              // (a) conditional — only the force pushes ever reach it.
              {
                type: "command",
                if: "Bash(git push *--force*)",
                command: DENY_ALL,
              },
              // (b) unconditional — blocks the whole battery.
              { type: "command", command: DENY_ALL },
              // (c3) irrelevant by an UNSET variable in the command.
              { type: "command", command: '"$SOME_UNSET_GUARD_HOME"/guard.sh' },
            ],
          },
          // (c2) irrelevant by matcher — a file-tool guard, not a Bash one.
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: ALLOW_ALL }],
          },
        ],
        // (c1) irrelevant by event.
        Stop: [{ hooks: [{ type: "command", command: ALLOW_ALL }] }],
      },
    }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The outcomes, in config order — the order the report promises. */
const sweep = () => experimental_verifyPluginGuards(dir).hooks;

describe("experimental_verifyPluginGuards — the per-hook verdicts differ", () => {
  it("reads four hooks in config order and gives each its own status", () => {
    const hooks = sweep();
    expect(hooks.map((h) => h.status)).toEqual([
      "measured",
      "measured",
      "unresolved",
      "not-applicable",
      "not-applicable",
    ]);
    // The index is what tells two hooks sharing a command apart.
    expect(hooks.map((h) => h.hook.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("the CONDITIONAL guard blocks only what its `if` lets through", () => {
    const [conditional] = sweep();
    if (conditional?.status !== "measured") throw new Error("not measured");
    expect(conditional.blocked).toEqual(["force-push"]);
    expect(conditional.allowed).toEqual([]);
    expect(conditional.notRun).toHaveLength(DISASTER_CATALOG.length - 1);
    // Every entry is still present — a hook reporting 1/1 would be the lie.
    expect(conditional.results).toHaveLength(DISASTER_CATALOG.length);
    for (const r of conditional.results.filter((x) => !x.ran))
      expect(r.reason).toContain("does not match");
  });

  it("the UNCONDITIONAL guard blocks the whole battery", () => {
    const unconditional = sweep()[1];
    if (unconditional?.status !== "measured") throw new Error("not measured");
    expect(unconditional.blocked).toHaveLength(DISASTER_CATALOG.length);
    expect(unconditional.notRun).toEqual([]);
    expect(unconditional.hook.condition).toBeNull();
  });

  it("an UNSET variable is `unresolved`, and the reason names the variable", () => {
    const unresolved = sweep()[2];
    if (unresolved?.status !== "unresolved") throw new Error("not unresolved");
    expect(unresolved.reason).toContain("$SOME_UNSET_GUARD_HOME");
    // The fix is in the caller's hands, and the message says so.
    expect(unresolved.reason).toContain("env");
  });

  it("a MATCHER that selects no battery tool is n/a, not a zero score", () => {
    const byMatcher = sweep()[3];
    if (byMatcher?.status !== "not-applicable")
      throw new Error("not n/a by matcher");
    expect(byMatcher.hook.matcher).toBe("Edit|Write");
    expect(byMatcher.reason).toContain("Bash");
    expect(byMatcher.reason).toContain("never spawns");
  });

  it("a hook on ANOTHER EVENT is n/a, and the reason names both events", () => {
    const byEvent = sweep()[4];
    if (byEvent?.status !== "not-applicable")
      throw new Error("not n/a by event");
    expect(byEvent.reason).toContain("Stop");
    expect(byEvent.reason).toContain("PreToolUse");
  });

  it("says nothing in `notes` when something WAS measured", () => {
    // The empty case has a voice (below); the measured case must not, or the
    // note stops meaning anything.
    expect(experimental_verifyPluginGuards(dir).notes).toEqual([]);
  });

  it("carries the battery + delivery event it measured against", () => {
    const report = experimental_verifyPluginGuards(dir, {
      categories: ["destructive-git"],
    });
    expect(report.event).toBe("PreToolUse");
    expect(report.events.map((e) => e.id)).toEqual([
      "force-push",
      "force-push-compound",
      "reset-hard",
    ]);
    const unconditional = report.hooks[1];
    if (unconditional?.status !== "measured") throw new Error("not measured");
    expect(unconditional.blocked).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The FOURTH non-verdict: a condition that rejects the whole battery.
//
// It reached `measured` with every row not-run and rendered as `blocks 0/7` — a
// score for a hook the harness never spawned, in the unsafe direction. It gets
// its own fixture because the shared one above has this hook's near-twin (a
// condition that rejects MOST of the battery, which must stay `measured`), and
// the pair is the whole assertion: the line is "none reached", not "few reached".
// ---------------------------------------------------------------------------

/** Reaches the battery by matcher, matches none of it by condition. */
const NEVER_MATCHES = "Bash(terraform apply*)";

/** A repo whose hooks are exactly `hooks`, swept and thrown away. */
function sweepFixture(
  hooks: readonly Record<string, unknown>[],
): PluginGuardReport {
  const tmp = mkdtempSync(join(tmpdir(), "vigiles-sweep-cond-"));
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(
    join(tmp, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks }] } }),
  );
  try {
    return experimental_verifyPluginGuards(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("a condition that selects NOTHING is not a score of zero", () => {
  it("🔴 is `not-applicable`, and the reason names the condition", () => {
    const [only] = sweepFixture([
      { type: "command", if: NEVER_MATCHES, command: DENY_ALL },
    ]).hooks;
    // Before the fix this was `measured` with blocked: [] — `blocks 0/7`.
    expect(only?.status).toBe("not-applicable");
    if (only?.status !== "not-applicable") throw new Error("scored");
    expect(only.reason).toContain(`condition \`${NEVER_MATCHES}\``);
    expect(only.reason).toContain("selects none");
    // It says the harness never ran it — the distinction the whole file exists
    // for. "Blocks nothing" would be the lie.
    expect(only.reason).toContain("never spawns");
    expect(only.reason).not.toMatch(SCORE_SHAPED);
  });

  it("🔴 the sole-hook repo says NOTHING WAS MEASURED, and prints no score", () => {
    // The path the reclassification creates: a repo whose only hook moves out of
    // `measured` now measures nothing, so `notes` must find its voice rather
    // than the report going quiet with an empty score.
    const report = sweepFixture([
      { type: "command", if: NEVER_MATCHES, command: DENY_ALL },
    ]);
    expect(report.hooks.every((h) => h.status !== "measured")).toBe(true);
    expect(report.notes.join(" ")).toContain("none of them reachable");
    expect(report.notes.join(" ")).toContain("Nothing was measured");
    const out = experimental_formatPluginGuardReport(report);
    expect(out).not.toMatch(SCORE_SHAPED);
    expect(out).toContain("Nothing was measured");
  });

  it("does not silence a measured sibling, and `notes` stays empty for it", () => {
    // The other direction of the same invariant: reclassifying one hook must not
    // cost the report the hooks that DID run, and `notes` is empty ONLY when
    // something was measured — which is still true with a not-applicable beside
    // it (a matcher-excluded hook has always been in that position).
    const report = sweepFixture([
      { type: "command", if: NEVER_MATCHES, command: DENY_ALL },
      { type: "command", command: DENY_ALL },
    ]);
    expect(report.hooks.map((h) => h.status)).toEqual([
      "not-applicable",
      "measured",
    ]);
    const measured = report.hooks[1];
    if (measured?.status !== "measured") throw new Error("not measured");
    expect(measured.blocked).toHaveLength(DISASTER_CATALOG.length);
    expect(report.notes).toEqual([]);
  });

  it("a condition matching PART of the battery still scores", () => {
    // The guard on the fix: `every(!ran)` must not become `some(!ran)`. This is
    // the shared fixture's conditional hook in miniature — one event reaches it,
    // six do not, and it is a real 1/7 rather than a non-verdict.
    const [partial] = sweepFixture([
      { type: "command", if: "Bash(git push *--force*)", command: DENY_ALL },
    ]).hooks;
    expect(partial?.status).toBe("measured");
    if (partial?.status !== "measured") throw new Error("not measured");
    expect(partial.blocked).toEqual(["force-push"]);
    expect(partial.notRun).toHaveLength(DISASTER_CATALOG.length - 1);
  });
});

// ---------------------------------------------------------------------------
// The honest empty cases. None of these may read as "safe" or "blocks nothing".
// ---------------------------------------------------------------------------

describe("the empty cases speak", () => {
  it("a plugin with NO hooks says so, in words", () => {
    const empty = mkdtempSync(join(tmpdir(), "vigiles-sweep-empty-"));
    writeFileSync(join(empty, "CLAUDE.md"), "# nothing here\n");
    try {
      const report = experimental_verifyPluginGuards(empty);
      expect(report.hooks).toEqual([]);
      expect(report.notes.join(" ")).toContain("not a clean bill of health");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("hooks that exist but none reachable says THAT instead", () => {
    const stopOnly = mkdtempSync(join(tmpdir(), "vigiles-sweep-stop-"));
    mkdirSync(join(stopOnly, ".claude"), { recursive: true });
    writeFileSync(
      join(stopOnly, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ command: ALLOW_ALL }] }] },
      }),
    );
    try {
      const report = experimental_verifyPluginGuards(stopOnly);
      expect(report.hooks).toHaveLength(1);
      expect(report.notes.join(" ")).toContain("none of them reachable");
      expect(report.notes.join(" ")).toContain("rather than the (empty) score");
    } finally {
      rmSync(stopOnly, { recursive: true, force: true });
    }
  });

  it("a harness with no shell hooks reports n/a, never an empty success", () => {
    // opencode's hooks are in-process TS modules; the battery cannot drive them.
    const report = experimental_verifyPluginGuards(dir, {
      adapter: opencodeAdapter,
    });
    expect(report.harness).toBe("opencode");
    expect(report.hooks).toEqual([]);
    expect(report.notes.join(" ")).toContain("n/a");
    expect(report.notes.join(" ")).toContain("Nothing was measured");
  });
});

// ---------------------------------------------------------------------------
// The REAL vendored guard — the artifact #211 was measured on.
// ---------------------------------------------------------------------------

describe("davila7 force-push-blocker (vendored, MIT) — read from the config", () => {
  it("honours EACH hook's own `if` without the caller passing one", () => {
    // This is the whole difference from verifyGuardrail: the caller supplies a
    // DIRECTORY, and the two hooks get two different conditions because that is
    // what the file says. Passing one condition for both is unrepresentable here.
    const hooks = experimental_verifyPluginGuards(VENDOR).hooks;
    expect(hooks).toHaveLength(2);

    const [first, second] = hooks;
    if (first?.status !== "measured" || second?.status !== "measured")
      throw new Error("the vendored guard should be measured");

    expect(first.hook.condition).toBe("Bash(git push *--force*)");
    expect(first.blocked).toEqual(["force-push"]);

    expect(second.hook.condition).toBe("Bash(git push *-f*)");
    expect(second.blocked).toEqual(["force-push", "force-push-compound"]);

    // The 7/7 that #211 killed must not come back through this door.
    for (const h of [first, second])
      expect(h.blocked.length).toBeLessThan(DISASTER_CATALOG.length);
  });

  it("never reports a not-run event as allowed", () => {
    const [first] = experimental_verifyPluginGuards(VENDOR).hooks;
    if (first?.status !== "measured") throw new Error("not measured");
    // `rm -rf /` is neither blocked nor allowed by this guard — it is not seen.
    expect(first.allowed).toEqual([]);
    expect(first.notRun).toContain("rm-rf");
    expect(first.blocked).not.toContain("rm-rf");
  });
});

// ---------------------------------------------------------------------------
// Both harnesses. A CC-shaped fixture cannot catch a CC assumption.
// ---------------------------------------------------------------------------

describe("the sweep is harness-agnostic", () => {
  it("reads a Codex-shaped repo: flat TOML hooks + ${PLUGIN_ROOT}", () => {
    const codex = mkdtempSync(join(tmpdir(), "vigiles-sweep-codex-"));
    mkdirSync(join(codex, ".codex"), { recursive: true });
    writeFileSync(join(codex, "AGENTS.md"), "# codex repo\n");
    // Codex's flat shape: the entry IS the command holder, no nested `hooks`.
    writeFileSync(
      join(codex, ".codex", "config.toml"),
      [
        "[[hooks.PreToolUse]]",
        'matcher = "Bash"',
        `command = ${JSON.stringify(DENY_ALL)}`,
        "",
        "[[hooks.Stop]]",
        `command = ${JSON.stringify(ALLOW_ALL)}`,
        "",
      ].join("\n"),
    );
    try {
      const report = experimental_verifyPluginGuards(codex, {
        adapter: codexAdapter,
      });
      expect(report.harness).toBe("codex");
      expect(report.hooks.map((h) => h.status)).toEqual([
        "measured",
        "not-applicable",
      ]);
      const [gate] = report.hooks;
      if (gate?.status !== "measured") throw new Error("not measured");
      // Codex blocks by the same exit-2 / deny-decision protocol, so the whole
      // battery is denied — one run covers the neutral half deliberately.
      expect(gate.blocked).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(codex, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The matcher predicate it leans on. Fail-open is right where the HARNESS is
// fail-open too, and wrong where the harness fails CLOSED — see the uncompilable
// case below and the full semantics table in core/hook-matcher.test.ts.
// ---------------------------------------------------------------------------

describe("hookMatcherReach", () => {
  it("compares a literal matcher by equality (the measured rule)", () => {
    expect(hookMatcherReach("Bash", "Bash")).toBe("selects");
    expect(hookMatcherReach("Edit", "Bash")).toBe("misses");
  });

  it("treats a metacharacter matcher as an unanchored regex", () => {
    expect(hookMatcherReach("Edit|Write", "Write")).toBe("selects");
    expect(hookMatcherReach("Edit|Write", "Bash")).toBe("misses");
    expect(hookMatcherReach("Ba.h", "Bash")).toBe("selects");
  });

  it("FAILS OPEN on an absent or match-all matcher", () => {
    // Those really do select every tool, so answering "selects" states a fact.
    expect(hookMatcherReach(null, "Bash")).toBe("selects");
    for (const all of ["", "*", ".*"])
      expect(hookMatcherReach(all, "Bash")).toBe("selects");
  });

  it("REFUSES on `**`, which the harness does not honour", () => {
    // Measured: claude 2.1.263 spawns nothing for `**` while `.*` fires. Calling
    // it a match-all was the mirror of the false 7/7 — a false ACCUSATION, since
    // the guard would have been reported as allowing a battery it never saw.
    expect(hookMatcherReach("**", "Bash")).toBe("uncompilable");
  });

  it("REFUSES on a matcher the engine rejects", () => {
    // Not fail-open: the harness cannot compile it either, so it never spawns
    // the hook. Calling that "selects" invents the run the score is read off.
    expect(hookMatcherReach("Bash(", "Bash")).toBe("uncompilable");
  });
});

// ---------------------------------------------------------------------------
// The four defects the Codex reviewer found on #212. Each fixture is the
// smallest repo that produces one, and each assertion is the one that failed
// before the fix.
// ---------------------------------------------------------------------------

/** A throwaway repo carrying one settings.json, cleaned up by the caller. */
function ccRepo(hooks: unknown): string {
  const at = mkdtempSync(join(tmpdir(), "vigiles-sweep-finding-"));
  mkdirSync(join(at, ".claude"), { recursive: true });
  writeFileSync(
    join(at, ".claude", "settings.json"),
    JSON.stringify({ hooks }),
  );
  return at;
}

/** A throwaway Codex repo: flat TOML `[[hooks.<event>]]` entries. */
function codexRepo(lines: readonly string[]): string {
  const at = mkdtempSync(join(tmpdir(), "vigiles-sweep-codex-finding-"));
  mkdirSync(join(at, ".codex"), { recursive: true });
  writeFileSync(join(at, "AGENTS.md"), "# codex repo\n");
  writeFileSync(join(at, ".codex", "config.toml"), lines.join("\n"));
  return at;
}

describe("an UNCOMPILABLE matcher gets no score (the false 7/7, second door)", () => {
  it("reports not-applicable naming the matcher, never a measured count", () => {
    // The hook body denies everything. Believe the matcher and it scores 7/7 —
    // the exact number #211 removed — while the harness, which cannot build
    // `Bash(` either, never spawns it once.
    const at = ccRepo({
      PreToolUse: [
        { matcher: "Bash(", hooks: [{ type: "command", command: DENY_ALL }] },
      ],
    });
    try {
      const report = experimental_verifyPluginGuards(at);
      const [only] = report.hooks;
      if (only?.status === "measured")
        throw new Error("an uncompilable matcher must not be measured");
      expect(only?.status).toBe("not-applicable");
      if (only?.status !== "not-applicable") throw new Error("unreachable");
      expect(only.reason).toContain("Bash(");
      expect(only.reason).toContain("compile");
      // And the renderer carries no number for it either.
      const out = experimental_formatPluginGuardReport(report).replaceAll(
        report.dir,
        "<dir>",
      );
      expect(out).not.toMatch(SCORE_SHAPED);
      expect(out).toContain("Nothing was measured");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("a Codex matcher is read with Codex's semantics", () => {
  it("measures `ash`, which regex-matches Bash on a regex-matcher harness", () => {
    const at = codexRepo([
      "[[hooks.PreToolUse]]",
      'matcher = "ash"',
      `command = ${JSON.stringify(DENY_ALL)}`,
      "",
    ]);
    try {
      const [only] = experimental_verifyPluginGuards(at, {
        adapter: codexAdapter,
      }).hooks;
      if (only?.status !== "measured")
        throw new Error(`expected measured, got ${only?.status ?? "none"}`);
      expect(only.blocked).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("still applies Claude Code's equality rule on Claude Code", () => {
    const at = ccRepo({
      PreToolUse: [
        { matcher: "ash", hooks: [{ type: "command", command: DENY_ALL }] },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at).hooks;
      expect(only?.status).toBe("not-applicable");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("a variable the command itself sets is not a missing variable", () => {
  it("measures a self-contained command and a single-quoted `$`", () => {
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          // The shell assigns GUARD before expanding it; the second names a
          // variable inside single quotes, where no expansion happens at all.
          hooks: [
            { type: "command", command: 'GUARD=echo; "$GUARD" ran' },
            { type: "command", command: "echo '$NOT_A_DEPENDENCY'" },
          ],
        },
      ],
    });
    try {
      const statuses = experimental_verifyPluginGuards(at).hooks.map(
        (h) => h.status,
      );
      expect(statuses).toEqual(["measured", "measured"]);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("a genuinely unset variable is STILL unresolved", () => {
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: '"$NO_SUCH_GUARD_HOME"/g.sh' }],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at).hooks;
      expect(only?.status).toBe("unresolved");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("the harness's own event variables are supplied", () => {
  it("resolves the ones the sweep synthesizes (`$hook_event_name`, `$cwd`)", () => {
    const at = codexRepo([
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      `command = ${JSON.stringify('echo "$hook_event_name $cwd"')}`,
      "",
    ]);
    try {
      const [only] = experimental_verifyPluginGuards(at, {
        adapter: codexAdapter,
      }).hooks;
      if (only?.status !== "measured")
        throw new Error(`expected measured, got ${only?.status ?? "none"}`);
      expect(only.allowed).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("does NOT invent a value it cannot derive (`$permission_mode`)", () => {
    // Declared by the adapter, but the sweep synthesizes no permission mode —
    // and a hook may branch on it, so a made-up value would be a made-up run.
    const at = codexRepo([
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      `command = ${JSON.stringify('echo "$permission_mode"')}`,
      "",
    ]);
    try {
      const [only] = experimental_verifyPluginGuards(at, {
        adapter: codexAdapter,
      }).hooks;
      expect(only?.status).toBe("unresolved");
      if (only?.status !== "unresolved") throw new Error("unreachable");
      expect(only.reason).toContain("permission_mode");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The RENDERER. Its whole contract is that the union's honesty survives being
// turned into text: a measured hook shows numbers, an unmeasured one shows a
// REASON and no number, and a sweep that measured nothing says so in words.
// A `0/7` printed beside a hook the battery never reached would reintroduce —
// one layer above the type system — the exact false confidence the union exists
// to make unrepresentable, so that is asserted directly.
// ---------------------------------------------------------------------------

/** Any `n/m` — what a score looks like, whatever the numbers are. */
const SCORE_SHAPED = /\d+\s*\/\s*\d+/;

/** The output with the swept path masked, so a tmpdir can't look like a score. */
const rendered = (report: PluginGuardReport): string =>
  experimental_formatPluginGuardReport(report).replaceAll(report.dir, "<dir>");

describe("experimental_formatPluginGuardReport", () => {
  it("renders the MIXED case: numbers for measured, reasons for the rest", () => {
    // The mixed report is where a formatter usually leaks a misleading total —
    // one number summed over hooks that were never asked the question.
    const out = rendered(experimental_verifyPluginGuards(dir));

    // The census is a census, not a score: no `n/m` on it.
    expect(out).toContain(
      "5 hooks declared: 2 measured, 1 unresolved, 2 not applicable.",
    );

    // Measured hooks carry their own count, and ONLY they do.
    expect(out).toContain("blocks 1/7");
    expect(out).toContain("blocks 7/7");
    expect(out.match(/blocks \d+\/\d+/g)).toHaveLength(2);

    // …and their rows are the same vocabulary formatGuardrailReport prints.
    expect(out).toContain("✅ blocks  git push --force to a protected branch");
    expect(out).toContain("⊘ not run  rm -rf of a broad path");

    // The unmeasured half names each hook and its reason, and never a count.
    expect(out).toContain("⊘ unresolved — 1 hook");
    expect(out).toContain("⊘ not applicable — 2 hooks");
    expect(out).toContain("$SOME_UNSET_GUARD_HOME");
    expect(out).toContain("registered on Stop");
    expect(out).toContain("selects none of the tools this battery calls");
  });

  it("gives each unmeasured hook its own index, so two are told apart", () => {
    const out = rendered(experimental_verifyPluginGuards(dir));
    // The fixture's two n/a hooks share nothing but their status; the index is
    // what a reader follows back to the config.
    expect(out).toContain("#3  `echo watching`");
    expect(out).toMatch(/#4\s+`echo watching`/);
  });

  it("names the selection facts the sweep actually read", () => {
    const out = rendered(experimental_verifyPluginGuards(dir));
    // The conditional guard's `if` is the whole reason its score is 1/7 — a
    // report showing the number without the condition invites the wrong reading.
    expect(out).toContain(
      "PreToolUse · matcher `Bash` · if `Bash(git push *--force*)`",
    );
    // The unconditional one shows no `if` clause at all.
    expect(out).toMatch(/blocks 7\/7[\s\S]*?PreToolUse · matcher `Bash`\n/);
  });

  it("🔴 NOTHING MEASURED: no score-shaped string, and it says so in words", () => {
    // The load-bearing assertion, in BOTH directions. A renderer that dropped
    // `notes` would print an empty-looking report that reads as a clean bill of
    // health; one that printed `0/7` per hook would invent a verdict.
    const stopOnly = mkdtempSync(join(tmpdir(), "vigiles-fmt-stop-"));
    mkdirSync(join(stopOnly, ".claude"), { recursive: true });
    writeFileSync(
      join(stopOnly, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ command: ALLOW_ALL }] }] },
      }),
    );
    try {
      const out = rendered(experimental_verifyPluginGuards(stopOnly));
      expect(out).not.toMatch(SCORE_SHAPED);
      expect(out).toContain("Nothing was measured");
      expect(out).toContain("none of them reachable");
      // The hook is still accounted for, by reason.
      expect(out).toContain("registered on Stop");
    } finally {
      rmSync(stopOnly, { recursive: true, force: true });
    }
  });

  it("🔴 NO HOOKS AT ALL: the same two directions, with the absence named", () => {
    const empty = mkdtempSync(join(tmpdir(), "vigiles-fmt-empty-"));
    writeFileSync(join(empty, "CLAUDE.md"), "# nothing here\n");
    try {
      const out = rendered(experimental_verifyPluginGuards(empty));
      expect(out).not.toMatch(SCORE_SHAPED);
      expect(out).toContain("Nothing was measured");
      expect(out).toContain("not a clean bill of health");
      // No census row of zeroes — that reads as a scoreboard.
      expect(out).not.toContain("0 measured");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("a harness with no shell hooks renders its n/a note, not an empty pass", () => {
    const out = rendered(
      experimental_verifyPluginGuards(dir, { adapter: opencodeAdapter }),
    );
    expect(out).not.toMatch(SCORE_SHAPED);
    expect(out).toContain("n/a");
    expect(out).toContain("Nothing was measured");
  });

  it("MANY unmeasured hooks stay readable: grouped by reason, then counted", () => {
    // A repo can register dozens of hooks that a Bash battery never reaches.
    // Listing all of them buries the two lines that mattered, so the reason is
    // printed once per group and the tail is counted — nothing is dropped
    // silently, and the section stays bounded however many hooks there are.
    const many = mkdtempSync(join(tmpdir(), "vigiles-fmt-many-"));
    mkdirSync(join(many, ".claude"), { recursive: true });
    writeFileSync(
      join(many, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: DENY_ALL }],
            },
          ],
          Stop: Array.from({ length: 12 }, (_, i) => ({
            hooks: [{ type: "command", command: `echo notify-${i}` }],
          })),
        },
      }),
    );
    try {
      const out = rendered(experimental_verifyPluginGuards(many));
      // Every hook is COUNTED, exactly.
      expect(out).toContain("⊘ not applicable — 12 hooks");
      // The reason is printed ONCE for the whole group, not twelve times.
      const reasons = out.match(/registered on Stop/g) ?? [];
      expect(reasons).toHaveLength(1);
      // Three are named, the remaining nine are counted.
      expect(out).toContain("#1  `echo notify-0`");
      expect(out).toContain("#3  `echo notify-2`");
      expect(out).not.toContain("echo notify-3");
      expect(out).toContain("…and 9 more hooks for this reason");
      // The whole not-measured section stays small however many hooks there are.
      const section = out.slice(out.indexOf("NOT MEASURED"));
      expect(section.split("\n").length).toBeLessThan(12);
      // And the measured hook is NOT collapsed — it is what you came for.
      expect(out).toContain("blocks 7/7");
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });

  it("a long or multi-line command is elided to one line", () => {
    const out = rendered(experimental_verifyPluginGuards(dir));
    expect(out).toContain("…`");
    // No rendered command spills a newline into the layout.
    for (const line of out.split("\n")) expect(line).not.toContain(DENY_ALL);
  });
});

// ---------------------------------------------------------------------------
// The campaign's two findings + the reviewer's three: all one class — we would
// run a DIFFERENT program than the harness runs, and score it anyway. Each
// fixture is the smallest repo that produces one; each assertion failed first.
// ---------------------------------------------------------------------------

/**
 * A hook script inside a throwaway repo — EXECUTABLE, because a file without
 * the execute bit makes the shell exit 126 and the sweep (correctly) refuses to
 * score it. That is how this helper was written the first time, and the new
 * post-hoc check caught it.
 */
function writeHookScript(at: string, name: string, body: string): void {
  mkdirSync(join(at, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(at, ".claude", "hooks", name), `#!/bin/sh\n${body}`, {
    mode: 0o755,
  });
}

describe("a hook whose SCRIPT is missing gets no score at all", () => {
  it("is unresolved, not a perfect 7/7", () => {
    // 🔴 THE LOUDEST LIE. `python3 <missing>` exits 2, and 2 is Claude Code's
    // DENY code — so a guard that never existed was certified as stopping every
    // disaster in the battery. Measured on the unfixed build:
    //   MEASURED blocks=7/7 exits=2,2,2,2,2,2,2
    // No malformed config is needed to reach it: a relative script path is the
    // commonest hook shape there is.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "python3 .claude/hooks/guard.py" },
          ],
        },
      ],
    });
    try {
      const report = experimental_verifyPluginGuards(at, { cwd: at });
      const [only] = report.hooks;
      // The load-bearing assertion: NO SCORE EXISTS. Not a 0, not a 7 — the
      // union must not even carry a `results` array for this hook.
      if (only?.status === "measured")
        throw new Error(
          `a hook whose script is missing must not be measured (got ${only.blocked.length}/${only.results.length})`,
        );
      expect(only?.status).toBe("unresolved");
      if (only?.status !== "unresolved") throw new Error("unreachable");
      expect(only.reason).toContain(".claude/hooks/guard.py");
      // And the renderer prints no number for it either.
      const out = experimental_formatPluginGuardReport(report).replaceAll(
        report.dir,
        "<dir>",
      );
      expect(out).not.toMatch(SCORE_SHAPED);
      expect(out).toContain("Nothing was measured");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("MEASURES the same hook once the script is on disk", () => {
    // The mirror half. Without it, "never score a script hook" would pass this
    // suite while quietly measuring nothing at all.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "sh .claude/hooks/guard.sh" }],
        },
      ],
    });
    try {
      writeHookScript(at, "guard.sh", "exit 2\n");
      const [only] = experimental_verifyPluginGuards(at, { cwd: at }).hooks;
      if (only?.status !== "measured")
        throw new Error(`expected measured, got ${only?.status ?? "none"}`);
      expect(only.blocked).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("refuses when the PROGRAM itself never launched (exit 127)", () => {
    // The other half of the same question, and the one an exit code CAN answer:
    // a missing interpreter, a non-executable file, a bad shebang. 126/127 are
    // the shell's own codes for "I never got as far as the program", so they are
    // not a language's exit convention and not a guess about stderr text.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "no_such_interpreter_xyz guard" },
          ],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at, { cwd: at }).hooks;
      if (only?.status === "measured")
        throw new Error("a program that never launched must not be measured");
      expect(only?.status).toBe("unresolved");
      if (only?.status !== "unresolved") throw new Error("unreachable");
      expect(only.reason).toContain("127");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("the variables checked are the ones the RUN will actually have", () => {
  it("a confined run does not inherit the ambient environment", () => {
    // 🔴 `trusted: false` confines with `--clearenv`, restoring only HOME /
    // TMPDIR / PATH and the caller's `env`. Checking availability against
    // `process.env` therefore clears a variable the hook will NOT find, so the
    // sweep runs a differently-configured program — and scores it.
    process.env["VIGILES_AMBIENT_PROBE"] = "set-on-the-host";
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: '"$VIGILES_AMBIENT_PROBE"/guard.sh' },
          ],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at, {
        trusted: false,
        cwd: at,
      }).hooks;
      expect(only?.status).toBe("unresolved");
      if (only?.status !== "unresolved") throw new Error("unreachable");
      expect(only.reason).toContain("VIGILES_AMBIENT_PROBE");
    } finally {
      delete process.env["VIGILES_AMBIENT_PROBE"];
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("an UNCONFINED run still sees the ambient environment", () => {
    // The mirror: the MODE decides, so the default direct run is unchanged.
    process.env["VIGILES_AMBIENT_PROBE"] = "echo";
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: '"$VIGILES_AMBIENT_PROBE" watching' },
          ],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at, { cwd: at }).hooks;
      expect(only?.status).toBe("measured");
    } finally {
      delete process.env["VIGILES_AMBIENT_PROBE"];
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("the harness's own project-root variables are supplied", () => {
  it("measures the commonest project-hook shape", () => {
    // `layout.projectRootTokens` declares what the harness sets, and the sweep
    // IS sweeping that root — so a hook reading `$CLAUDE_PROJECT_DIR` is an
    // ordinary hook, not an unresolvable one.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.sh',
            },
          ],
        },
      ],
    });
    try {
      writeHookScript(at, "guard.sh", "exit 2\n");
      const [only] = experimental_verifyPluginGuards(at, { cwd: at }).hooks;
      if (only?.status !== "measured")
        throw new Error(`expected measured, got ${only?.status ?? "none"}`);
      expect(only.blocked).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("a command the SHELL PARSER rejects gets no score (the false 7/7, third door)", () => {
  it("is unresolved, and the reason names the syntax error, not a variable", () => {
    // 🔴 MEASURED ON THE UNFIXED BUILD, and it is the same signature as the
    // missing-script lie with no missing script involved:
    //   `echo "unterminated`  →  MEASURED blocks=7/7 exits=2,2,2,2,2,2,2
    // `sh` exits 2 for a syntax error and 2 is this harness's DENY code, so the
    // battery certified a command that never ran. The file pre-flight went
    // QUIET on it (`commandFileRefs` returns `{ parsed: false, refs: [] }`,
    // which reads exactly like a clean command) because the caller dropped
    // `parsed` on the floor.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: 'echo "unterminated' }],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at).hooks;
      expect(only?.status).toBe("unresolved");
      if (only?.status !== "unresolved") throw new Error("expected unresolved");
      expect(only.reason).toMatch(/not valid shell/);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("blames the SYNTAX, not the variable its regex fallback still sees", () => {
    // `shellVarReads` falls back to a regex when the parse fails, so it reports
    // `FOO` here — and the variable check ran first, telling the caller to pass
    // `env` for a command that could never run whatever `env` contained. The
    // parse verdict has to come first for either reason to be true.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: 'echo "$UNSET_ON_PURPOSE' }],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at).hooks;
      if (only?.status !== "unresolved") throw new Error("expected unresolved");
      expect(only.reason).toMatch(/not valid shell/);
      expect(only.reason).not.toMatch(/UNSET_ON_PURPOSE/);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("still measures a command that merely LOOKS exotic but parses", () => {
    // The other direction, or the gate is just "refuse everything": a compound
    // command with quoting and a pipeline is valid shell and stays measurable.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `echo 'x' | grep -q x && ${DENY_ALL} || true`,
            },
          ],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at).hooks;
      expect(only?.status).toBe("measured");
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("a CONFINED run resolves relative paths where it will actually run", () => {
  it("does not score a relative script it can only see from THIS cwd", () => {
    // 🔴 THE PRE-FLIGHT AND THE RUNNER DISAGREED. `sandboxedSpawn` chdirs into a
    // `work/` directory it has just created and left empty when no `cwd` is
    // given, while this check resolved against `process.cwd()`. Measured with
    // the same guard, the same command, two directories:
    //   project dir      → exit 0   (the guard's real verdict: allow)
    //   fresh empty dir  → exit 2   (cannot open its script = DENY = a block)
    // So a guard that allows was reported as blocking, out of nothing but the
    // directory mismatch — the false 7/7 through a fourth door.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "sh .claude/hooks/guard.sh" }],
        },
      ],
    });
    const was = process.cwd();
    try {
      writeHookScript(at, "guard.sh", "exit 0\n");
      // The script IS present relative to this process — the only thing that
      // made the old check pass. It will not be present in the sandbox's dir.
      process.chdir(at);
      const [only] = experimental_verifyPluginGuards(at, {
        trusted: false,
      }).hooks;
      if (only?.status !== "unresolved")
        throw new Error(`expected unresolved, got ${only?.status ?? "none"}`);
      expect(only.reason).toMatch(/RELATIVE path/);
      expect(only.reason).toMatch(/fresh empty directory/);
    } finally {
      process.chdir(was);
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("an ABSOLUTE path keeps its ORDINARY verdict under confinement", () => {
    // The narrowing matters as much as the refusal: confinement changes the
    // working directory, it does not hide the filesystem (`--ro-bind / /`), so
    // an absolute script is still tested on disk and gets the plain reason —
    // refusing every path under confinement would trade one wrong answer for
    // another. Asserted on a MISSING absolute path so the decision is made by
    // the pre-flight and nothing is ever spawned.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "sh /nonexistent/vigiles/guard.sh" },
          ],
        },
      ],
    });
    try {
      const [only] = experimental_verifyPluginGuards(at, {
        trusted: false,
      }).hooks;
      if (only?.status !== "unresolved") throw new Error("expected unresolved");
      expect(only.reason).toMatch(/not on disk here/);
      expect(only.reason).not.toMatch(/RELATIVE path/);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  it("an UNCONFINED run still resolves against this process's cwd", () => {
    // The default path is unchanged: no `trusted: false`, no sandbox, so the
    // runner really does inherit `process.cwd()` and the check follows it.
    const at = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "sh .claude/hooks/guard.sh" }],
        },
      ],
    });
    const was = process.cwd();
    try {
      writeHookScript(at, "guard.sh", "exit 2\n");
      process.chdir(at);
      const [only] = experimental_verifyPluginGuards(at).hooks;
      expect(only?.status).toBe("measured");
    } finally {
      process.chdir(was);
      rmSync(at, { recursive: true, force: true });
    }
  });
});

describe("the PROJECT root is the project, not the plugin", () => {
  it("binds `$CLAUDE_PROJECT_DIR` to the host project when they differ", () => {
    // Sweeping an INSTALLED plugin against a host project is a supported call
    // (`dir` = the plugin, `cwd` = the project), and it is the only shape where
    // the two roots differ. Binding both to `dir` sent an ordinary project hook
    // at the plugin's tree: measured on the unfixed build, this exact case
    // reported `unresolved — the command runs /<plugin>/hooks/guard.sh, which
    // is not on disk here`, for a script sitting in the project all along.
    const plugin = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: 'sh "$CLAUDE_PROJECT_DIR"/hooks/guard.sh',
            },
          ],
        },
      ],
    });
    const project = mkdtempSync(join(tmpdir(), "vigiles-sweep-project-"));
    try {
      mkdirSync(join(project, "hooks"), { recursive: true });
      writeFileSync(join(project, "hooks", "guard.sh"), "#!/bin/sh\nexit 2\n", {
        mode: 0o755,
      });
      const [only] = experimental_verifyPluginGuards(plugin, {
        cwd: project,
      }).hooks;
      if (only?.status !== "measured")
        throw new Error(
          `expected measured, got ${only?.status ?? "none"}${only ? ` — ${only.reason}` : ""}`,
        );
      expect(only.blocked).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("leaves the PLUGIN root bound to the swept dir", () => {
    // The other half of the same change: only the project tokens moved. A hook
    // reading `$CLAUDE_PLUGIN_ROOT` must still find the plugin it shipped with,
    // or fixing one conflation would have introduced its mirror image.
    const plugin = ccRepo({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: 'sh "$CLAUDE_PLUGIN_ROOT"/.claude/hooks/guard.sh',
            },
          ],
        },
      ],
    });
    const project = mkdtempSync(join(tmpdir(), "vigiles-sweep-project-"));
    try {
      writeHookScript(plugin, "guard.sh", "exit 2\n");
      const [only] = experimental_verifyPluginGuards(plugin, {
        cwd: project,
      }).hooks;
      if (only?.status !== "measured")
        throw new Error(
          `expected measured, got ${only?.status ?? "none"}${only ? ` — ${only.reason}` : ""}`,
        );
      expect(only.blocked).toHaveLength(DISASTER_CATALOG.length);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The two Codex round-2 findings that land on the report itself.
// ---------------------------------------------------------------------------

/** A repo whose only hook runs a RELATIVE script with the given exit code. */
function repoWithRelativeGuard(label: string, exitCode: number): string {
  const root = mkdtempSync(join(tmpdir(), `vigiles-sweep-${label}-`));
  mkdirSync(join(root, ".claude", "vg-hooks"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "vg-hooks", "relguard.sh"),
    `#!/bin/sh\nexit ${exitCode}\n`,
  );
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "sh .claude/vg-hooks/relguard.sh" },
            ],
          },
        ],
      },
    }),
  );
  return root;
}

describe("a relative hook path resolves against the SWEPT repo", () => {
  // Codex round 2, P2. The execution cwd defaulted to the CALLER's directory
  // while the project-root variables were set to the swept root — two trees,
  // one run. A guard that is on disk exactly where its config says was reported
  // `unresolved`; and where the caller happened to hold the same relative path,
  // the sweep ran and SCORED the caller's file under the swept repo's name.
  let swept = "";
  let decoy = "";

  beforeAll(() => {
    // 🔴 THE SWEPT GUARD ALLOWS, AND THAT CHOICE IS THE TEST. `sh missing.sh`
    // exits 2 — this harness's DENY code — so a run that never found the script
    // scores a full block. With the swept guard DENYING, a correct measurement
    // and a total failure to find the file both read `7/7`, and the assertion
    // proves nothing: verified by mutation, which passed green until the codes
    // were flipped. An ALLOWING guard makes the right answer 0/7, so the false
    // 7/7 this whole file exists to prevent is the one thing it cannot be
    // confused with.
    swept = repoWithRelativeGuard("swept", 0); // 0 = allow  → correct run: 0/7
    decoy = repoWithRelativeGuard("decoy", 2); // 2 = deny   → wrong tree: 7/7
  });
  afterAll(() => {
    for (const d of [swept, decoy]) rmSync(d, { recursive: true, force: true });
  });

  it("measures it, instead of reporting a present guard as missing", () => {
    // The test process's cwd is this repository, which has no such file — so
    // before the fix this was `unresolved: not on disk here`.
    const [hook] = experimental_verifyPluginGuards(swept).hooks;
    expect(hook?.status).toBe("measured");
  });

  it("treats recordEgress as confinement, like the runner does", () => {
    // Codex round 2, P1, and the half a unit test of `routeScriptRun` alone
    // does NOT reach: the sweep must ASK the runner's router rather than keep
    // its own copy of the mode expression. The copy knew `trusted`/`sandbox`
    // and not `recordEgress` — which the runner has always confined for — so a
    // recordEgress sweep pre-flighted this relative script against the host,
    // accepted it, then ran it in a fresh empty directory where `sh` cannot
    // open it and exits 2: this harness's DENY code, scored as a block.
    const [hook] = experimental_verifyPluginGuards(swept, {
      recordEgress: true,
    }).hooks;
    expect(hook?.status).toBe("unresolved");
    expect(hook?.status === "unresolved" && hook.reason).toContain(
      "fresh empty directory",
    );
    // The same shape under the option the copy DID know, so the assertion above
    // is about recordEgress and not about relative paths in general.
    const [confined] = experimental_verifyPluginGuards(swept, {
      trusted: false,
    }).hooks;
    expect(confined?.status).toBe("unresolved");
    // …and unconfined it is measured, or the test proves only that something
    // always refuses.
    expect(experimental_verifyPluginGuards(swept).hooks[0]?.status).toBe(
      "measured",
    );
  });

  it("scores the SWEPT repo's file, not a same-named one elsewhere", () => {
    // The two guards are byte-different on purpose (deny vs allow), so the
    // score itself says which file ran. Without that the assertion above would
    // pass while measuring the wrong tree.
    const mine = experimental_verifyPluginGuards(swept).hooks[0];
    expect(mine?.status).toBe("measured");
    expect(mine?.status === "measured" && mine.blocked.length).toBe(0);
    // …and an explicit `cwd` still overrides, which is the installed-plugin
    // case: hooks READ from the plugin, RUN against a project elsewhere.
    const elsewhere = experimental_verifyPluginGuards(swept, {
      cwd: decoy,
    }).hooks[0];
    expect(elsewhere?.status === "measured" && elsewhere.blocked.length).toBe(
      DISASTER_CATALOG.length,
    );
  });
});

describe("declared actions that are not commands", () => {
  // Codex round 2, P2. `normalizeHooks` keeps only `command` actions, which is
  // right — nothing that spawns a shell can drive a `prompt`. But the sweep read
  // the empty list as "no hooks are declared", which is an accusation about the
  // repository rather than a limit of the tier.
  const write = (label: string, hooks: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), `vigiles-sweep-${label}-`));
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks }),
    );
    return root;
  };

  it("says DECLARED-and-not-measured, never 'no hooks are declared'", () => {
    const root = write("noncmd", {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "prompt", prompt: "safe?" },
            { type: "http", url: "https://example.test/h" },
            { type: "mcp_tool", server: "s", tool: "t" },
            { type: "agent", agent: "reviewer" },
          ],
        },
      ],
    });
    try {
      const report = experimental_verifyPluginGuards(root);
      expect(report.unmeasurable).toHaveLength(4);
      expect(report.unmeasurable.map((a) => a.type).sort()).toEqual([
        "agent",
        "http",
        "mcp_tool",
        "prompt",
      ]);
      const notes = report.notes.join(" ");
      expect(notes).toContain("No COMMAND hooks are declared");
      expect(notes).toContain("not an absence of guards");
      expect(notes).toContain("NOT measured");
      // The sentence that was false is gone.
      expect(notes).not.toContain("it is an absence of guards.");
      // …and the reader is told, in the rendering too.
      const text = experimental_formatPluginGuardReport(report);
      expect(text).toContain("not a command");
      expect(text).toContain("prompt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts them beside the measured ones in a MIXED config", () => {
    // The undercount half: a reader who sees one measured hook has no way to
    // know a second guard went unexamined unless the sweep says so.
    const root = write("mixed", {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: DENY_ALL },
            { type: "prompt", prompt: "safe?" },
          ],
        },
      ],
    });
    try {
      const report = experimental_verifyPluginGuards(root);
      expect(report.hooks).toHaveLength(1);
      expect(report.hooks[0]?.status).toBe("measured");
      expect(report.unmeasurable).toHaveLength(1);
      // `notes` is otherwise empty once something was measured — this one is
      // said anyway, because it is a gap in COVERAGE, not a failure to measure.
      expect(report.notes.join(" ")).toContain("not a shell process");
      expect(report.notes.join(" ")).toContain("Declared and NOT measured");
      expect(experimental_formatPluginGuardReport(report)).toContain(
        "further action(s) declared are not commands",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays silent for a repo whose hooks are all commands", () => {
    const report = experimental_verifyPluginGuards(dir);
    expect(report.unmeasurable).toEqual([]);
    expect(experimental_formatPluginGuardReport(report)).not.toContain(
      "not a command",
    );
  });
});
