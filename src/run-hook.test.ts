/**
 * Hook unit-tier test suite (node:test): pure decision logic + real shell hooks across exit codes, stdin event passthrough, env injection, JSON permission decisions, runHookWith sandbox + egress routing (fake spawners) + gated bwrap confinement + a gated egress: { allow } integration (allowed host reached, off-list + raw socket dropped) and the OMC session-start dogfood (reaches the npm registry, drops nothing else)
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";

import {
  assertNoEgress,
  assertEgressOnly,
  assertWroteOnly,
  assertNoWrite,
} from "./harness-assert.js";
import { claudeCodeHookProtocol } from "./adapters/claude-code/hook-protocol.js";
import type { HookProtocol } from "./core/hook-protocol.js";
import {
  runHook,
  runHookWith,
  parseHookOutput,
  decideHook,
  propertyHook,
  fileToolEvents,
  type HookOutput,
} from "./run-hook.js";
import type { RunScriptDeps, ScriptSpawnResult } from "./run-script.js";
import {
  checksRecorded,
  resetCheckCount,
  surfacesRecorded,
} from "./check-count.js";
import { sandboxAvailable } from "./sandbox.js";
import { pathView, projectRootOf } from "./core/hook-program.js";

test("propertyHook: holds for a correct guard, finds a counterexample for a buggy one", () => {
  const CMDS = ["ls", "rm -rf /", "rm -rf foo", "git status", "cat x"];
  const mutate = (_e: { command: string }, rng: number) => ({
    command: CMDS[Math.abs(rng) % CMDS.length],
  });
  // invariant: any command containing "rm -rf" must be blocked.
  const invariants = {
    "destructive-blocked": (d: { blocked: boolean }, e: { command: string }) =>
      e.command.includes("rm -rf") ? d.blocked : true,
  };

  // A CORRECT guard blocks every "rm -rf" → property holds.
  const good = propertyHook({
    seed: { command: "ls" },
    mutate,
    decide: (e) => ({ blocked: e.command.includes("rm -rf") }),
    invariants,
    iterations: 200,
  });
  assert.ok(good.passed, "correct guard satisfies the invariant");

  // A BUGGY guard only blocks the exact "rm -rf /" → property finds "rm -rf foo".
  const buggy = propertyHook({
    seed: { command: "ls" },
    mutate,
    decide: (e) => ({ blocked: e.command === "rm -rf /" }),
    invariants,
    iterations: 200,
  });
  assert.equal(buggy.passed, false);
  assert.equal(buggy.failedInvariant, "destructive-blocked");
  assert.ok(buggy.counterexample?.command.includes("rm -rf"));
});

test("parseHookOutput parses a JSON decision and ignores plain text", () => {
  assert.deepEqual(parseHookOutput('{"decision":"block","reason":"no"}'), {
    decision: "block",
    reason: "no",
  });
  assert.equal(parseHookOutput("just a log line"), null);
  assert.equal(parseHookOutput("  not json {x"), null);
  // starts with "{" but invalid JSON → JSON.parse throws → caught → null
  assert.equal(parseHookOutput('{"unterminated": '), null);
});

test("decideHook: exit 2 blocks regardless of stdout", () => {
  const r = decideHook(2, null);
  assert.equal(r.blocked, true);
});

test("decideHook: legacy decision:block blocks on exit 0", () => {
  const json: HookOutput = { decision: "block" };
  const r = decideHook(0, json);
  assert.equal(r.blocked, true);
  assert.equal(r.decision, "block");
});

test("decideHook: permissionDecision:deny blocks and wins over legacy", () => {
  const json: HookOutput = {
    decision: "approve",
    hookSpecificOutput: { permissionDecision: "deny" },
  };
  const r = decideHook(0, json);
  assert.equal(r.blocked, true);
  assert.equal(r.decision, "deny"); // structured field preferred
});

test("decideHook: clean exit 0 with no JSON allows", () => {
  const r = decideHook(0, null);
  assert.equal(r.blocked, false);
  assert.equal(r.decision, undefined);
});

// --- #174: the halt-the-turn field --------------------------------------
// Both halves, because an advisory verdict cannot be noticed wrong: it must
// FIRE on the defect AND stay silent on everything adjacent to it.

test("decideHook: continue:false halts the turn, and counts as blocked", () => {
  const json: HookOutput = { continue: false, stopReason: "no pushing" };
  const r = decideHook(0, json);
  // The regression this pins: a real PreToolUse guard that stops every command
  // in the disaster battery was reported by `assertBlocksDisasters` as blocking
  // none of them, because this returned false here.
  assert.equal(r.blocked, true);
  assert.equal(r.haltsTurn, true);
  // A halt is not a per-call decision — it carries no deny value.
  assert.equal(r.decision, undefined);
});

test("decideHook: continue:true is not a halt", () => {
  const r = decideHook(0, { continue: true });
  assert.equal(r.blocked, false);
  assert.equal(r.haltsTurn, false);
});

test("decideHook: an ABSENT continue field is not a halt", () => {
  // `=== false`, never falsy — the whole bug class this guards against is a
  // missing field reading as a decision.
  const r = decideHook(0, { reason: "just talking" });
  assert.equal(r.blocked, false);
  assert.equal(r.haltsTurn, false);
});

test("decideHook: a deny sets blocked WITHOUT claiming the turn halted", () => {
  const json: HookOutput = {
    hookSpecificOutput: { permissionDecision: "deny" },
  };
  const r = decideHook(0, json);
  assert.equal(r.blocked, true);
  assert.equal(r.haltsTurn, false, "a deny refuses one call, it does not halt");
});

test("decideHook: a harness with no haltsTurnField ignores continue", () => {
  // The field is read from the PORT. `continue` is documented for Claude Code
  // and unverified for Codex, so a protocol that does not declare it must not
  // silently inherit the behaviour — this is what keeps the fact out of core.
  const noHalt: HookProtocol = {
    ...claudeCodeHookProtocol,
    name: "no-halt-harness",
    haltsTurnField: undefined,
  };
  const r = decideHook(0, { continue: false }, noHalt);
  assert.equal(r.blocked, false);
  assert.equal(r.haltsTurn, false);
});

test("runHook: a guard that halts the turn reports blocked", () => {
  // End-to-end through a real process, not just the pure decision: this is the
  // path `verifyGuardrail` walks.
  const r = runHook(
    `printf '%s' '{"continue": false, "stopReason": "blocked: force push"}'`,
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
  );
  assert.equal(r.exitCode, 0, "it halts by field, not by exit code");
  assert.equal(r.blocked, true);
  assert.equal(r.haltsTurn, true);
});

test("runHook: a guard that exits 2 reports blocked", () => {
  const r = runHook("exit 2", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
  });
  assert.equal(r.exitCode, 2);
  assert.equal(r.blocked, true);
});

test("runHook: a clean exit 0 is not blocked", () => {
  const r = runHook("exit 0", { hook_event_name: "Stop" });
  assert.equal(r.exitCode, 0);
  assert.equal(r.blocked, false);
});

test("runHook: a hook can read the event from stdin", () => {
  // Real-world shape: the hook inspects tool_input from the piped JSON and
  // blocks on a forbidden flag — the Edit/Write events the mock tier can't reach
  // are just as testable here.
  const guard = `node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const i=JSON.parse(s);
      if(String(i.tool_input&&i.tool_input.command).includes("--no-verify"))process.exit(2);
    });'`;
  const blocked = runHook(guard, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit --no-verify" },
  });
  assert.equal(blocked.blocked, true);
  const ok = runHook(guard, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit -m ok" },
  });
  assert.equal(ok.blocked, false);
});

test("runHook: a JSON permission decision on stdout is parsed", () => {
  const cmd = `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"nope"}}'`;
  const r = runHook(cmd, { hook_event_name: "PreToolUse" });
  assert.equal(r.blocked, true);
  assert.equal(r.decision, "deny");
  assert.equal(r.json?.hookSpecificOutput?.permissionDecisionReason, "nope");
});

test("runHook: env is injected so command strings with $VARS resolve", () => {
  const r = runHook('test "$VIGILES_FLAG" = "1" && exit 2 || exit 0', {
    hook_event_name: "PreToolUse",
  });
  assert.equal(r.blocked, false); // unset → exit 0
  const r2 = runHook(
    'test "$VIGILES_FLAG" = "1" && exit 2 || exit 0',
    {
      hook_event_name: "PreToolUse",
    },
    { env: { VIGILES_FLAG: "1" } },
  );
  assert.equal(r2.blocked, true);
});

test("runHook: governs MCP tools by name (no server needed)", () => {
  // The dominant real MCP test: a PreToolUse hook that blocks a destructive MCP
  // tool but allows read-only ones. The hook only sees the tool *name*
  // (`mcp__<server>__<tool>`), so this needs no running MCP server, no model —
  // the governance the unit tier already covers. Shape: a "deny merge" guard
  // over the github MCP server.
  const guard = `node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const i=JSON.parse(s);
      if(/^mcp__github__(merge_pull_request|delete_)/.test(i.tool_name||""))process.exit(2);
    });'`;
  const merge = runHook(guard, {
    hook_event_name: "PreToolUse",
    tool_name: "mcp__github__merge_pull_request",
    tool_input: { pull_number: 42 },
  });
  assert.equal(merge.blocked, true, "destructive github-MCP tool is blocked");
  const read = runHook(guard, {
    hook_event_name: "PreToolUse",
    tool_name: "mcp__github__get_issue",
    tool_input: { issue_number: 1 },
  });
  assert.equal(read.blocked, false, "read-only github-MCP tool is allowed");
});

// --- the sandbox seam (runHookWith with fake spawners) ---------------------

const spawnRes = (o: Partial<ScriptSpawnResult> = {}): ScriptSpawnResult => ({
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  ...o,
});

test("runHookWith routes direct vs sandbox by policy, refuses when unavailable", () => {
  let used = "";
  const deps = (available: boolean): RunScriptDeps => ({
    available,
    egressAvailable: available,
    direct: () => {
      used = "direct";
      return spawnRes({ stdout: '{"decision":"approve"}' });
    },
    sandboxed: () => {
      used = "sandbox";
      return spawnRes({ status: 2 });
    },
    egress: () => {
      used = "egress";
      return spawnRes();
    },
  });

  // default (no sandbox) → direct, regardless of availability
  const r1 = runHookWith("x", { hook_event_name: "Stop" }, {}, deps(true));
  assert.equal(used, "direct");
  assert.equal(r1.decision, "approve");

  // sandbox:"auto" + available → confined
  used = "";
  const r2 = runHookWith("x", {}, { sandbox: "auto" }, deps(true));
  assert.equal(used, "sandbox");
  assert.equal(r2.blocked, true); // exit 2

  // sandbox:"auto" + unavailable → refuse rather than run unconfined
  assert.throws(
    () => runHookWith("x", {}, { sandbox: "auto" }, deps(false)),
    /sandbox|bwrap/,
  );
});

test("runHookWith: trusted:false confines by default, refuses without bwrap", () => {
  let used = "";
  const deps = (available: boolean): RunScriptDeps => ({
    available,
    egressAvailable: available,
    direct: () => {
      used = "direct";
      return spawnRes();
    },
    sandboxed: () => {
      used = "sandbox";
      return spawnRes();
    },
    egress: () => {
      used = "egress";
      return spawnRes();
    },
  });

  // untrusted + no explicit sandbox + available → confined by default
  runHookWith("x", {}, { trusted: false }, deps(true));
  assert.equal(used, "sandbox");

  // untrusted + no explicit sandbox + unavailable → refuse, not run unconfined
  assert.throws(
    () => runHookWith("x", {}, { trusted: false }, deps(false)),
    /sandbox|bwrap/,
  );

  // recordEgress also forces confinement (the recorder lives in the netns)
  used = "";
  runHookWith("x", {}, { recordEgress: true }, deps(true));
  assert.equal(used, "sandbox");

  // untrusted but explicit opt-out → direct (you vouch for it / outer container)
  used = "";
  runHookWith("x", {}, { trusted: false, sandbox: false }, deps(true));
  assert.equal(used, "direct");

  // trusted (default) → direct even where a sandbox is available
  used = "";
  runHookWith("x", {}, {}, deps(true));
  assert.equal(used, "direct");
});

test("runHookWith routes egress:{allow} to the egress seam, refuses when unavailable", () => {
  let used = "";
  const deps = (egressAvailable: boolean): RunScriptDeps => ({
    available: true,
    egressAvailable,
    direct: () => {
      used = "direct";
      return spawnRes();
    },
    sandboxed: () => {
      used = "sandbox";
      return spawnRes();
    },
    egress: () => {
      used = "egress";
      return spawnRes({
        egress: [{ host: "registry.npmjs.org", port: 0, ts: 1, allowed: true }],
        egressDropped: { packets: 0, bytes: 0 },
      });
    },
  });

  // egress mode + tooling available → the egress seam, surfacing egress + dropped
  const r = runHookWith(
    "x",
    {},
    { egress: { allow: ["registry.npmjs.org"] } },
    deps(true),
  );
  assert.equal(used, "egress");
  assert.equal(r.egress[0]?.host, "registry.npmjs.org");
  assert.equal(r.egress[0]?.allowed, true);
  assert.deepEqual(r.egressDropped, { packets: 0, bytes: 0 });

  // egress mode + no tooling → refuse (it can't fall back to an unconfined run)
  assert.throws(
    () =>
      runHookWith(
        "x",
        {},
        { egress: { allow: ["registry.npmjs.org"] } },
        deps(false),
      ),
    /egress|slirp4netns|nft/,
  );
});

test("runHookWith maps a signal kill to exit 1", () => {
  const deps: RunScriptDeps = {
    available: true,
    egressAvailable: true,
    direct: () => spawnRes({ status: null, signal: "SIGKILL" }),
    sandboxed: () => spawnRes(),
    egress: () => spawnRes(),
  };
  assert.equal(runHookWith("x", {}, {}, deps).exitCode, 1);
});

// --- real bwrap confinement (skipped where bwrap is absent) ----------------

test.skipIf(!sandboxAvailable())(
  "sandbox: clears host env but adds opts.env back, runs confined",
  () => {
    process.env.VIG_FAKE_SECRET = "leaked";
    try {
      // $VIG_FAKE_SECRET must be empty under --clearenv; $GUARD is added back.
      const r = runHook(
        'printf "%s|%s" "$VIG_FAKE_SECRET" "$GUARD"',
        { hook_event_name: "Stop" },
        { sandbox: "auto", env: { GUARD: "ok" } },
      );
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, "|ok");
    } finally {
      delete process.env.VIG_FAKE_SECRET;
    }
  },
);

// --- recordEgress: record + block a hook's network (needs real bwrap) -------

// Capturing Node's global fetch() needs NODE_USE_ENV_PROXY, which only takes
// effect on Node 22+. Proxy-honoring tools (curl/npm/pip) work on every version;
// this gate is only for the fetch-based session-start test below.
const nodeMajor = Number(process.versions.node.split(".")[0]);

test.skipIf(!sandboxAvailable() || nodeMajor < 22)(
  "dogfood: oh-my-claudecode's session-start hook update-checks ONLY the npm registry",
  () => {
    // A REAL, useful finding about a popular plugin: OMC's SessionStart hook
    // fetch()es registry.npmjs.org for an update check on every session start.
    // recordEgress captures it (Node fetch via NODE_USE_ENV_PROXY) and blocks it;
    // assertEgressOnly proves it phones the npm registry and nowhere else.
    const root = join(process.cwd(), "test/dogfood/oh-my-claudecode@deee3a4");
    // session-start only runs its full logic in a real workspace (a .git /
    // .omc-workspace marker), so give it a throwaway one as the confined cwd.
    const ws = mkdtempSync(join(tmpdir(), "omc-ws-"));
    writeFileSync(join(ws, ".omc-workspace"), "");
    const state = mkdtempSync(join(tmpdir(), "omc-state-"));
    const r = runHook(
      `node "${root}/scripts/run.cjs" "${root}/scripts/session-start.mjs"`,
      { hook_event_name: "SessionStart", source: "startup" },
      {
        recordEgress: true,
        cwd: ws,
        env: { CLAUDE_PLUGIN_ROOT: root, OMC_STATE_DIR: state },
        timeoutMs: 30000,
      },
    );
    assert.ok(
      r.egress.some((e) => e.host === "registry.npmjs.org"),
      `expected the update check to reach the npm registry; got ${JSON.stringify(r.egress)}`,
    );
    assertEgressOnly(r, ["registry.npmjs.org"]); // …and nowhere else
  },
);

test.skipIf(!sandboxAvailable())(
  "dogfood: the real oh-my-claudecode keyword-detector hook phones home to nothing",
  () => {
    // Run a REAL third-party plugin hook (vendored, pinned) under recordEgress
    // and assert it makes zero network egress — the kind of supply-chain check
    // this capability exists for.
    const root = join(process.cwd(), "test/dogfood/oh-my-claudecode@deee3a4");
    const r = runHook(
      `node "${root}/scripts/run.cjs" "${root}/scripts/keyword-detector.mjs"`,
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "please ultrawork on this",
      },
      {
        recordEgress: true,
        env: { CLAUDE_PLUGIN_ROOT: root },
        timeoutMs: 30000,
      },
    );
    // it still does its job (injects routing) …
    assert.match(
      r.json?.hookSpecificOutput?.additionalContext ?? "",
      /ULTRAWORK/,
    );
    // … and it reached out to nothing.
    assertNoEgress(r);
  },
);

test.skipIf(!sandboxAvailable())(
  "dogfood: oh-my-claudecode keyword-detector writes ONLY its own state cache",
  () => {
    // Confine the real hook and record what it touches on disk: it should write
    // its keyword-state cache under .omc/ and nothing else.
    const root = join(process.cwd(), "test/dogfood/oh-my-claudecode@deee3a4");
    const r = runHook(
      `node "${root}/scripts/run.cjs" "${root}/scripts/keyword-detector.mjs"`,
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "please ultrawork on this",
      },
      { sandbox: "auto", env: { CLAUDE_PLUGIN_ROOT: root }, timeoutMs: 30000 },
    );
    // A confined run RECORDS writes, so this is a real list, not `undefined`.
    assert.ok(r.filesWritten, "a confined run records writes");
    assert.ok(r.filesWritten.length > 0, "it writes its state cache");
    assertWroteOnly(r, [/^\.omc\//]); // …and only under .omc/
  },
);

// --- the contract the `test-harness` skill teaches for plain helper scripts ---
//
// A knowledgeable user hand-rolled an `execFileSync` runner to test 13 helper
// scripts and hit the same bug three times: `execFileSync` returns stdout ALONE
// on success, so advisory output — which tools (including vigiles's own compiled
// hook `notice()`) write to stderr — vanished, and healthy react hooks were
// reported dead. `runHook` is the tier for a plain program, and it carries BOTH
// streams. These pin that promise so a refactor can't quietly invalidate the
// skill's advice.

test("runHook drives a plain helper script and returns BOTH streams, not just stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-script-"));
  writeFileSync(
    join(dir, "check-links.sh"),
    'echo "scanning..."\necho "0 broken links" >&2\nexit 0\n',
  );
  // A plain script ignores the event payload entirely — `{}` is fine.
  const r = runHook("bash check-links.sh", {}, { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "scanning...\n");
  // The load-bearing one: an execFileSync-shaped runner drops exactly this.
  assert.equal(r.stderr, "0 broken links\n");
});

test("a failing script still surfaces its stdout AND stderr, not an exception", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-script-"));
  writeFileSync(
    join(dir, "fail.sh"),
    'echo "partial output"\necho "boom" >&2\nexit 3\n',
  );
  const r = runHook("bash fail.sh", {}, { cwd: dir });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, "partial output\n");
  assert.equal(r.stderr, "boom\n");
});

test("an unconfined run leaves filesWritten UNDEFINED — and a write assertion refuses rather than passing", () => {
  // The regression this locks: the script below DOES write a file. Previously
  // an unconfined run reported `filesWritten: []`, so `assertNoWrite` returned
  // GREEN against a run that had just written — success with no evidence
  // inspected. Now the absence of a recording is visible in the data, and the
  // assertion refuses.
  const dir = mkdtempSync(join(tmpdir(), "vigiles-script-"));
  writeFileSync(join(dir, "w.sh"), "echo hi > wrote-a-file.txt\n");
  const r = runHook("bash w.sh", {}, { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.equal(r.filesWritten, undefined, "unconfined records nothing");
  assert.throws(
    () => {
      assertNoWrite(r, "wrote-a-file.txt");
    },
    /never recorded/i,
    "must not green-light a run whose writes were never captured",
  );
});

// --- a REFUSED run attributes nothing (the coverage probe follows the spawn) ---
//
// 🔴 The probe was recorded BEFORE the branch that can refuse. `runEgress` throws
// when the allowlist sandbox is missing and `runConfinedOrDirect` throws when
// confinement was required and bwrap is absent — so a harness asserting exactly
// that refusal (a documented, legitimate test: "an untrusted hook must not run
// unconfined here") caught the error, exited 0 with a check recorded, and the CLI
// runner then wrote an execution-tier coverage record for a hook that never ran.
// Same substitution as a `fail`/`vacuous` run writing a record, one layer down.

test("a REFUSED run records no surface probe — the intent to run is not a run", () => {
  const refusing: RunScriptDeps = {
    available: false,
    egressAvailable: false,
    direct: () => {
      throw new Error("no spawner may be reached in this test");
    },
    sandboxed: () => {
      throw new Error("no spawner may be reached in this test");
    },
    egress: () => {
      throw new Error("no spawner may be reached in this test");
    },
  };

  // FIRES (a): confinement required, bwrap absent → `runConfinedOrDirect` throws.
  resetCheckCount();
  assert.throws(
    () => runHookWith("sh hooks/guard.sh", {}, { trusted: false }, refusing),
    /sandbox|bwrap/,
  );
  assert.deepEqual(
    surfacesRecorded(),
    [],
    "a hook that was refused must not be attributed as executed",
  );

  // FIRES (b): the egress branch refuses on its own path, before any spawner.
  resetCheckCount();
  assert.throws(
    () =>
      runHookWith(
        "sh hooks/guard.sh",
        {},
        { egress: { allow: ["example.com"] } },
        refusing,
      ),
    /egress/,
  );
  assert.deepEqual(surfacesRecorded(), []);
});

test("…but a run that LAUNCHED and exited NONZERO is still an execution", () => {
  // The QUIET half, and the one a fix tightened to "exit 0" would break: most of
  // what the hook tier tests is a hook that ran and BLOCKED (exit 2) or failed
  // (exit 1). The spawner returning at all is the fact being recorded.
  const spawning = (status: number): RunScriptDeps => ({
    available: true,
    egressAvailable: true,
    direct: () => spawnRes({ status }),
    sandboxed: () => spawnRes({ status }),
    egress: () => spawnRes({ status }),
  });

  for (const status of [0, 1, 2]) {
    resetCheckCount();
    const r = runHookWith("sh hooks/guard.sh", {}, {}, spawning(status));
    assert.equal(r.exitCode, status);
    assert.deepEqual(
      surfacesRecorded(),
      [{ how: "command", ref: "hooks/guard.sh" }],
      `exit ${String(status)} still attributes the hook it ran`,
    );
  }

  // …and the check count is unaffected in BOTH directions: a refusal is still a
  // check (the harness asserted something), it is only not an EXECUTION. Without
  // this the fix could quietly turn a refusal-asserting harness `vacuous`, which
  // would retract that script's other records.
  resetCheckCount();
  assert.throws(() =>
    runHookWith("sh hooks/guard.sh", {}, { trusted: false }, {
      available: false,
      egressAvailable: false,
      direct: () => spawnRes(),
      sandboxed: () => spawnRes(),
      egress: () => spawnRes(),
    } satisfies RunScriptDeps),
  );
  assert.equal(
    checksRecorded(),
    1,
    "a refusal is still a check, just not a run",
  );
});

test("a shell that never LAUNCHED the hook records no surface probe", () => {
  // The reported gap: `spawnSync(cmd, { shell: true })` does not throw when the
  // shell cannot start the program — it returns 126/127. A harness may
  // legitimately assert exactly that (`the hook is not executable`), and the
  // unconditional probe then credited a hook although only `/bin/sh` ran.
  //
  // 🔴 REAL SPAWN, NOT A FAKE STATUS, because the numbers are the claim. Fake
  // deps would only assert that I typed 126 in two places.
  const dir = mkdtempSync(join(tmpdir(), "vigiles-launch-"));
  writeFileSync(join(dir, "noexec.sh"), "#!/bin/sh\necho ran\n", {
    mode: 0o644,
  });
  writeFileSync(join(dir, "ok.sh"), "#!/bin/sh\necho ran\nexit 3\n", {
    mode: 0o755,
  });

  // FIRES (a): the file EXISTS and would resolve as a surface — only the exec
  // bit is missing, so the shell reports 126 and nothing of the hook ran.
  resetCheckCount();
  const noexec = runHook("./noexec.sh", {}, { cwd: dir });
  assert.equal(noexec.exitCode, 126, noexec.stderr);
  assert.equal(noexec.stdout, "", "nothing of the hook ran");
  assert.deepEqual(
    surfacesRecorded(),
    [],
    "126 = the shell never launched it; crediting it would be a false grant",
  );

  // FIRES (b): 127, the not-found family (missing file, unknown command, and a
  // shebang naming an interpreter that does not exist — that last one is a real
  // file with the exec bit set, which is why "does the file exist" is not the
  // question).
  for (const cmd of ["./missing.sh", "definitely-not-a-command-xyz"]) {
    resetCheckCount();
    assert.equal(runHook(cmd, {}, { cwd: dir }).exitCode, 127, cmd);
    assert.deepEqual(surfacesRecorded(), [], cmd);
  }

  // …and the check itself still counts. A harness asserting non-executability
  // asserted something; turning it `vacuous` would retract its OTHER records.
  resetCheckCount();
  runHook("./noexec.sh", {}, { cwd: dir });
  assert.equal(checksRecorded(), 1, "a failed launch is still a check");

  // QUIET (a): a hook that RAN and exited 3 attributes, on the same real spawn.
  resetCheckCount();
  const ran = runHook("./ok.sh", {}, { cwd: dir });
  assert.equal(ran.exitCode, 3);
  assert.equal(ran.stdout.trim(), "ran");
  assert.deepEqual(surfacesRecorded(), [{ how: "command", ref: "./ok.sh" }]);

  // 🔴 QUIET (b), and the one an "exit code says it failed" fix would get wrong:
  // `sh <file>` / `bash <file>` on a NON-EXECUTABLE file exit 0 and the hook
  // genuinely runs — the interpreter reads it as an argument, so the exec bit is
  // irrelevant. Measured, not assumed; this is the documented idiom.
  for (const cmd of ["sh ./noexec.sh", "bash ./noexec.sh"]) {
    resetCheckCount();
    const r = runHook(cmd, {}, { cwd: dir });
    assert.equal(r.exitCode, 0, cmd);
    assert.equal(r.stdout.trim(), "ran", cmd);
    assert.deepEqual(
      surfacesRecorded(),
      [{ how: "command", ref: "./noexec.sh" }],
      cmd,
    );
  }
});

test("…and 126/127 is distinguished from an ordinary failing exit code", () => {
  // The constraint the fix is not allowed to break: a hook that runs and exits
  // non-zero HAS executed. Every code the hook tier actually deals in — 1
  // (failure), 2 (Claude Code's BLOCK) — must still attribute, and so must a
  // signal death (status null), which is a process that certainly started.
  const spawning = (status: number | null): RunScriptDeps => ({
    available: true,
    egressAvailable: true,
    direct: () => spawnRes({ status, signal: status === null ? "SIGKILL" : null }), // prettier-ignore
    sandboxed: () => spawnRes({ status }),
    egress: () => spawnRes({ status }),
  });

  for (const status of [0, 1, 2, 3, 125, 128, 255, null]) {
    resetCheckCount();
    runHookWith("sh hooks/guard.sh", {}, {}, spawning(status));
    assert.deepEqual(
      surfacesRecorded(),
      [{ how: "command", ref: "hooks/guard.sh" }],
      `exit ${String(status)} is an execution`,
    );
  }
  for (const status of [126, 127]) {
    resetCheckCount();
    runHookWith("sh hooks/guard.sh", {}, {}, spawning(status));
    assert.deepEqual(surfacesRecorded(), [], `exit ${String(status)} is not`);
  }
});

// ---------------------------------------------------------------------------
// fileToolEvents — the helper that exists because its absence hid a dead hook.
// Hand-built events carried the RELATIVE spelling; the harness sends the
// ABSOLUTE one; `PathView.under` matched only the first. Returning BOTH is the
// point, so the singular convenience is deliberately not offered.
// ---------------------------------------------------------------------------

test("fileToolEvents: returns BOTH spellings of the same file, relative first", () => {
  const [rel, abs] = fileToolEvents("migratsiya/papers/x/main.tex", {
    root: "/home/user/mine",
  });
  assert.equal(
    (rel.tool_input as { file_path: string }).file_path,
    "migratsiya/papers/x/main.tex",
  );
  assert.equal(
    (abs.tool_input as { file_path: string }).file_path,
    "/home/user/mine/migratsiya/papers/x/main.tex",
  );
  // The two differ ONLY in the path — same event, same tool, same extras.
  assert.notEqual(
    (rel.tool_input as { file_path: string }).file_path,
    (abs.tool_input as { file_path: string }).file_path,
  );
  for (const e of [rel, abs]) {
    assert.equal(e.hook_event_name, "PostToolUse");
    assert.equal(e.tool_name, "Edit");
    // `cwd` rides along so a hook spawned WITHOUT $CLAUDE_PROJECT_DIR still
    // resolves a root — the same fallback the live runtime uses.
    assert.equal(e.cwd, "/home/user/mine");
  }
});

test("fileToolEvents: event/tool/input/extra are overridable; root and path spellings normalize", () => {
  const [rel, abs] = fileToolEvents("./src/x.ts", {
    root: "/repo/",
    event: "PreToolUse",
    tool: "Write",
    input: { content: "x" },
    extra: { session_id: "s1" },
  });
  assert.equal(rel.hook_event_name, "PreToolUse");
  assert.equal(rel.tool_name, "Write");
  assert.equal(rel.session_id, "s1");
  assert.equal(rel.cwd, "/repo"); // trailing slash trimmed, no `//` in the join
  assert.deepEqual(rel.tool_input, { file_path: "src/x.ts", content: "x" });
  assert.deepEqual(abs.tool_input, {
    file_path: "/repo/src/x.ts",
    content: "x",
  });
});

test("fileToolEvents: with no explicit root it uses $CLAUDE_PROJECT_DIR, then the test's cwd", () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = "/from/env";
    assert.equal(fileToolEvents("a.md")[1].cwd, "/from/env");
    assert.equal(
      (fileToolEvents("a.md")[1].tool_input as { file_path: string }).file_path,
      "/from/env/a.md",
    );
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(fileToolEvents("a.md")[1].cwd, process.cwd());
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

// ---------------------------------------------------------------------------
// A FILESYSTEM ROOT is still a root.
//
// 🔴 Trimming every trailing separator turned `"/"` into `""` and `"C:\"` into
// `"C:"`, and the damage is downstream and SILENT: `projectRootOf` skips an
// empty `cwd`, `usableRoot` rejects a bare drive letter, so the ABSOLUTE-spelling
// event became undecidable and every repo-relative prefix missed. The event still
// existed and the hook still ran — a test asserting a hook does NOT fire would
// pass on an event that could never have made it fire.
//
// So this asserts the RUNTIME's own verdict (`pathView` + `projectRootOf`, the
// pair a compiled hook uses), not the string shape — the string is what looked
// fine while the verdict was wrong.
// ---------------------------------------------------------------------------
test("fileToolEvents: a filesystem root stays usable — BOTH spellings still decide", () => {
  const decides = (root: string): [boolean, boolean] => {
    const events = fileToolEvents("docs/x.md", { root });
    return events.map((e) => {
      const fp = (e.tool_input as { file_path: string }).file_path;
      return pathView(fp, projectRootOf({ cwd: e.cwd })).under(["docs"]);
    }) as [boolean, boolean];
  };
  for (const root of ["/", "C:\\", "C:/", "C:", "//"]) {
    assert.deepEqual(
      decides(root),
      [true, true],
      `root ${root} went undecidable`,
    );
  }
  // The ordinary case is unchanged: trailing separators still get trimmed.
  assert.equal(fileToolEvents("a.md", { root: "/repo//" })[0].cwd, "/repo");
  assert.deepEqual(decides("/repo/"), [true, true]);
  // And the absolute spelling never grows a doubled separator at the root.
  const [, abs] = fileToolEvents("docs/x.md", { root: "/" });
  assert.equal(
    (abs.tool_input as { file_path: string }).file_path,
    "/docs/x.md",
  );
});

test("fileToolEvents: an EMPTY root is not a root — it falls through, it does not become `/`", () => {
  // The same undecidable-event failure by a second door: `??` skips only
  // null/undefined, so `root: ""` used to land in `cwd` verbatim, and
  // `projectRootOf` skips an empty `cwd` exactly as it skips an empty
  // `$CLAUDE_PROJECT_DIR`. Treating it as the filesystem root instead would be
  // worse — `under(["docs"])` would then be TRUE for anything, the wrong error
  // direction for an allowlist.
  const saved = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = "/from/env";
    assert.equal(fileToolEvents("a.md", { root: "" })[0].cwd, "/from/env");
    assert.equal(fileToolEvents("a.md", { root: "   " })[0].cwd, "/from/env");
    process.env.CLAUDE_PROJECT_DIR = "";
    assert.equal(fileToolEvents("a.md")[0].cwd, process.cwd());
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

// Round 30: a caller reusing a real `tool_input` fixture must not lose the pair.
// Spread last, `opts.input.file_path` overwrote the generated one in BOTH
// entries — two events, one spelling, and the helper's only guarantee gone
// without a single failure to show for it.
test("fileToolEvents: an input fixture cannot overwrite the generated path", () => {
  const events = fileToolEvents("src/x.ts", {
    root: "/repo",
    input: { file_path: "/somewhere/else.ts", old_string: "a" },
  });
  const [rel, abs] = events;
  const inputOf = (e: (typeof events)[number]): Record<string, unknown> =>
    (e.tool_input ?? {}) as Record<string, unknown>;
  assert.equal(inputOf(rel).file_path, "src/x.ts");
  assert.equal(inputOf(abs).file_path, "/repo/src/x.ts");
  // the other extras still land
  assert.equal(inputOf(rel).old_string, "a");
  assert.notEqual(inputOf(rel).file_path, inputOf(abs).file_path);
});

// Round 31: the sibling of the `file_path` case, two lines up in the same
// object. Extras copied from a real event carry a `cwd`; spread last it replaced
// the root the helper had just chosen, so the absolute entry was built from one
// root and evaluated against another.
test("fileToolEvents: extras cannot override the selected root", () => {
  const [rel, abs] = fileToolEvents("src/x.ts", {
    root: "/repo",
    extra: { cwd: "/somewhere/else", session_id: "s1" },
  });
  assert.equal(rel.cwd, "/repo");
  assert.equal(abs.cwd, "/repo");
  // the other extras still land
  assert.equal((rel as unknown as Record<string, unknown>).session_id, "s1");
});

// Round 39, and the sibling of round 38's fix — made twice because the first was
// made in only one of the two places. A relative `root` masked the absolute
// `process.cwd()` fallback, so the "absolute" entry came out as `./src/x.ts` and
// `cwd` as `.`, which the runtime rejects. The helper then returned TWO relative
// spellings, leaving untested exactly the behaviour it exists to exercise.
test("fileToolEvents: a RELATIVE root is skipped, not used", () => {
  const abs = (opts: Parameters<typeof fileToolEvents>[1]) => {
    const [, a] = fileToolEvents("src/x.ts", opts);
    return String((a.tool_input as Record<string, unknown>).file_path);
  };
  for (const root of [".", "../up", "relative/dir"]) {
    const got = abs({ root });
    assert.ok(
      got.startsWith("/"),
      `root ${root} must fall through to an absolute one, got ${got}`,
    );
  }
  assert.equal(abs({ root: "/repo" }), "/repo/src/x.ts");
});

test("fileToolEvents: the two spellings are never the same string", () => {
  for (const root of [".", "/repo", undefined]) {
    const [rel, a] = fileToolEvents("src/x.ts", root ? { root } : {});
    const p = (e: typeof rel) =>
      String((e.tool_input as Record<string, unknown>).file_path);
    assert.notEqual(p(rel), p(a), `root ${String(root)} collapsed the pair`);
  }
});

// --- the closed block-mechanism table -------------------------------------

test("decideHook reports WHICH mechanisms fired, not just that one did", () => {
  // The shape that stops #174 repeating: a hook can block several ways at once,
  // and each new mechanism reports itself instead of needing a fresh boolean.
  const both = decideHook(2, { continue: false });
  assert.deepEqual([...both.blockedBy].sort(), ["exit-code", "halt-field"]);
  assert.equal(both.blocked, true);
  assert.equal(both.haltsTurn, true);
});

test("haltsTurn is DERIVED from the table, not computed twice", () => {
  // Order-independent: evaluating only the first match would make `haltsTurn`
  // depend on where `halt-field` sits in the table.
  const exitOnly = decideHook(2, null);
  assert.deepEqual(exitOnly.blockedBy, ["exit-code"]);
  assert.equal(exitOnly.haltsTurn, false);

  const haltOnly = decideHook(0, { continue: false });
  assert.deepEqual(haltOnly.blockedBy, ["halt-field"]);
  assert.equal(haltOnly.haltsTurn, true);
});

test("a clean run fires no mechanism at all", () => {
  const clean = decideHook(0, null);
  assert.deepEqual(clean.blockedBy, []);
  assert.equal(clean.blocked, false);
});
