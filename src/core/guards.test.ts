/**
 * Guard prototype test suite (vitest): proves the typed vocabulary expresses the
 * real OSS hook cases + the new ORDER axis, decides correctly, and generates a
 * valid Claude Code hooks block. Pure, no model, no shell.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  guard,
  decideGuards,
  compileGuards,
  guardedTools,
  serializeGuards,
  parseGuards,
  loadGuards,
  readGuardLedger,
  recordGuardCall,
  parseGuardEvent,
  runGuardHook,
  type Guard,
} from "./guards.js";
import { makeTmpDir, cleanupTmpDir } from "./test-utils.js";
import { runHook } from "../run-hook.js";

test("block: denies a matching tool call (reproduces pre-edit.sh's intent)", () => {
  const guards: Guard[] = [
    guard.block(
      { tool: "Edit", when: { file_path: /\.md$/ } },
      "compiled artifact — edit the .spec.ts instead",
    ),
  ];
  // Edit on a .md → blocked with the message.
  const denied = decideGuards(guards, {
    tool: "Edit",
    input: { file_path: "CLAUDE.md" },
  });
  assert.equal(denied.allow, false);
  assert.match(denied.reason ?? "", /edit the \.spec\.ts/);
  // Edit on a .ts → allowed (the `when` didn't match).
  assert.equal(
    decideGuards(guards, { tool: "Edit", input: { file_path: "a.ts" } }).allow,
    true,
  );
});

test("requireBefore (ORDER): destroy is denied until plan has fired", () => {
  const guards: Guard[] = [
    guard.requireBefore(
      { tool: "Bash", when: { command: /terraform destroy/ } },
      { tool: "Bash", when: { command: /terraform plan/ } },
      "`terraform destroy` requires a prior `terraform plan` this session",
    ),
  ];
  const destroy = {
    tool: "Bash",
    input: { command: "terraform destroy -auto-approve" },
  };

  // No prior plan → blocked.
  const blocked = decideGuards(guards, destroy, []);
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason ?? "", /requires a prior `terraform plan`/);

  // After a plan call in the ledger → allowed.
  const ok = decideGuards(guards, destroy, [
    { tool: "Bash", input: { command: "terraform plan -out=tf.plan" } },
  ]);
  assert.equal(ok.allow, true);

  // The plan call itself is never gated.
  assert.equal(
    decideGuards(guards, { tool: "Bash", input: { command: "terraform plan" } })
      .allow,
    true,
  );
});

test("confine: denies a path-taking tool escaping the allowlist (rm -rf / class)", () => {
  const guards: Guard[] = [
    guard.confine(["Write", "Edit"], ["src/**", "test/**"]),
  ];
  // Inside the allowed set → ok.
  assert.equal(
    decideGuards(guards, { tool: "Write", input: { file_path: "src/x.ts" } })
      .allow,
    true,
  );
  // Outside (home dir) → denied.
  const escaped = decideGuards(guards, {
    tool: "Write",
    input: { file_path: "/home/user/.ssh/authorized_keys" },
  });
  assert.equal(escaped.allow, false);
  assert.match(escaped.reason ?? "", /outside the allowed set/);
});

test("compileGuards emits a valid CC hooks block pointing at vigiles's OWN gate", () => {
  const guards: Guard[] = [
    guard.block({ tool: "Edit", when: { file_path: /\.md$/ } }, "x"),
    guard.requireBefore(
      { tool: "Bash", when: { command: /destroy/ } },
      { tool: "Bash", when: { command: /plan/ } },
    ),
    guard.confine(["Write"], ["src/**"]),
  ];
  assert.deepEqual(guardedTools(guards), ["Bash", "Edit", "Write"]);

  const cfg = compileGuards(guards);
  const entry = cfg.hooks.PreToolUse[0];
  assert.equal(entry.matcher, "Bash|Edit|Write");
  // The command is vigiles's audited gate — NOT user shell (safe-by-construction).
  assert.equal(entry.hooks[0].command, "npx vigiles hook-runtime guard");
  assert.equal(entry.hooks[0].type, "command");
});

// ---------------------------------------------------------------------------
// Serialization — a guard set round-trips through .vigiles/guards.json (RegExp-safe)
// ---------------------------------------------------------------------------

test("serializeGuards/parseGuards round-trips every kind incl. RegExp matchers", () => {
  const guards: Guard[] = [
    guard.block(
      { tool: "Edit", when: { file_path: /\.md$/i } },
      "edit the spec",
    ),
    guard.requireBefore(
      { tool: "Bash", when: { command: /terraform destroy/ } },
      { tool: "Bash", when: { command: /terraform plan/ } },
      "plan first",
    ),
    guard.confine(["Write"], ["src/**"], "stay in src", "path"),
  ];
  const back = parseGuards(serializeGuards(guards));
  assert.equal(back.length, 3);
  // The RegExp survived (a plain JSON.stringify would have dropped it to {}).
  const blockGuard = back[0];
  assert.equal(blockGuard.kind, "block");
  if (blockGuard.kind === "block") {
    const re = blockGuard.target.when?.file_path;
    assert.ok(re instanceof RegExp);
    assert.equal((re as RegExp).source, "\\.md$");
    assert.equal((re as RegExp).flags, "i");
  }
  // The same guards still decide identically after a round-trip.
  assert.equal(
    decideGuards(back, { tool: "Edit", input: { file_path: "X.MD" } }).allow,
    false,
  );
  const confineGuard = back[2];
  assert.equal(confineGuard.kind, "confine");
  if (confineGuard.kind === "confine")
    assert.equal(confineGuard.pathKey, "path");
});

test("parseGuards is tolerant — drops a malformed guard, keeps the valid ones", () => {
  const json = JSON.stringify({
    guards: [
      { kind: "block", target: { tool: "Edit" }, reason: "ok" },
      { kind: "block", target: { tool: "Edit" } }, // no reason → dropped
      { kind: "nonsense" }, // unknown kind → dropped
      { kind: "confine", tools: ["Write"], allow: ["src/**"] },
    ],
  });
  const back = parseGuards(json);
  assert.equal(back.length, 2);
  assert.equal(back[0].kind, "block");
  assert.equal(back[1].kind, "confine");
  // Garbage in → empty out, never a throw.
  assert.deepEqual(parseGuards("not json"), []);
});

// ---------------------------------------------------------------------------
// Runtime IO — load the set, read/append the session ledger
// ---------------------------------------------------------------------------

test("loadGuards reads .vigiles/guards.json (absent → none)", () => {
  const dir = makeTmpDir("guards-load");
  try {
    assert.deepEqual(loadGuards(dir), []);
    mkdirSync(join(dir, ".vigiles"), { recursive: true });
    const guards: Guard[] = [
      guard.confine(["Write"], ["src/**"], "stay in src"),
    ];
    writeFileSync(join(dir, ".vigiles/guards.json"), serializeGuards(guards));
    assert.equal(loadGuards(dir).length, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("recordGuardCall appends to the ledger; readGuardLedger reads it back oldest-first", () => {
  const dir = makeTmpDir("guards-ledger");
  try {
    assert.deepEqual(readGuardLedger(dir), []);
    recordGuardCall(dir, {
      tool: "Bash",
      input: { command: "terraform plan" },
    });
    recordGuardCall(dir, { tool: "Read", input: { file_path: "x" } });
    const ledger = readGuardLedger(dir);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].tool, "Bash");
    assert.equal(ledger[1].tool, "Read");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("parseGuardEvent reads tool_name/tool_input; malformed → null", () => {
  const e = parseGuardEvent(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
  );
  assert.equal(e?.tool, "Bash");
  assert.equal(parseGuardEvent("not json"), null);
  assert.equal(parseGuardEvent(JSON.stringify({ tool_input: {} })), null);
});

// ---------------------------------------------------------------------------
// runGuardHook — the runnable gate: allow records, deny doesn't, ORDER across calls
// ---------------------------------------------------------------------------

function writeGuards(dir: string, guards: Guard[]): void {
  mkdirSync(join(dir, ".vigiles"), { recursive: true });
  writeFileSync(join(dir, ".vigiles/guards.json"), serializeGuards(guards));
}

test("runGuardHook: an allowed call is recorded; a blocked call is not", () => {
  const dir = makeTmpDir("guards-run");
  try {
    writeGuards(dir, [
      guard.block({ tool: "Edit", when: { file_path: /\.md$/ } }, "no md"),
    ]);
    // Allowed → recorded.
    const ok = runGuardHook(
      dir,
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x.ts" } }),
    );
    assert.equal(ok.decision.allow, true);
    assert.equal(ok.recorded, true);
    assert.equal(readGuardLedger(dir).length, 1);
    // Blocked → NOT recorded (the call never happened).
    const denied = runGuardHook(
      dir,
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "a.md" } }),
    );
    assert.equal(denied.decision.allow, false);
    assert.equal(denied.recorded, false);
    assert.equal(readGuardLedger(dir).length, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("runGuardHook (ORDER): destroy is blocked, then allowed once plan has been recorded", () => {
  const dir = makeTmpDir("guards-order");
  try {
    writeGuards(dir, [
      guard.requireBefore(
        { tool: "Bash", when: { command: /terraform destroy/ } },
        { tool: "Bash", when: { command: /terraform plan/ } },
        "plan first",
      ),
    ]);
    const destroy = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "terraform destroy -auto-approve" },
    });
    // No prior plan → blocked.
    assert.equal(runGuardHook(dir, destroy).decision.allow, false);
    // Run the plan (allowed → recorded in the ledger).
    const plan = runGuardHook(
      dir,
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "terraform plan -out=tf.plan" },
      }),
    );
    assert.equal(plan.decision.allow, true);
    // Now destroy is unlocked across calls (the ledger remembers the plan).
    assert.equal(runGuardHook(dir, destroy).decision.allow, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// E2E — the real built CLI gate, driven through runHook (no model, no shell guard)
// ---------------------------------------------------------------------------

const CLI = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");

test("guard-hook CLI blocks destroy before plan (exit 2), allows after (ORDER, live)", () => {
  const dir = makeTmpDir("guard-hook-e2e");
  try {
    writeGuards(dir, [
      guard.requireBefore(
        { tool: "Bash", when: { command: /terraform destroy/ } },
        { tool: "Bash", when: { command: /terraform plan/ } },
        "`terraform destroy` requires a prior `terraform plan` this session",
      ),
    ]);
    const destroyEvent = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "terraform destroy -auto-approve" },
    };
    // Before any plan → blocked with the reason.
    const blocked = runHook(`node ${CLI} hook-runtime guard`, destroyEvent, {
      cwd: dir,
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.stderr, /terraform plan/);

    // Run the plan (the gate records it).
    const plan = runHook(
      `node ${CLI} hook-runtime guard`,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "terraform plan -out=tf.plan" },
      },
      { cwd: dir },
    );
    assert.equal(plan.blocked, false);
    assert.ok(existsSync(join(dir, ".vigiles/guard-ledger.json")));

    // Now destroy is allowed — the ledger persisted the plan across hook invocations.
    const after = runHook(`node ${CLI} hook-runtime guard`, destroyEvent, {
      cwd: dir,
    });
    assert.equal(after.blocked, false);
    assert.equal(after.exitCode, 0);
  } finally {
    cleanupTmpDir(dir);
  }
});
