/**
 * Coverage-dogfood over the THREE real vendored plugins (test/dogfood/*).
 *
 * Companion to vendor.test.ts (which asserts loadPlugin INVARIANTS) and to
 * agent-runtime.test.ts / run-hook.test.ts (which already cover the wshobson
 * inherits-all footgun via parseAgentTools/decidePreToolUse and the OMC hooks
 * under bubblewrap egress/fs recording). This file adds the MISSING free, model-
 * free coverage and proves how far the cheap rungs reach, per
 * research/eval-coverage-and-isolation.md:
 *
 *   R1  — a hook's block/allow + injected-context decision (`runHook`, NO sandbox,
 *         NO model) and the structural facts a scan exposes (skill descriptions,
 *         agent tool-contracts incl. the inherits-all footgun, hook resolution).
 *         These RUN here, for free, in CI.
 *   R2  — a skill that shells out to a real CLI, tested by SHADOWING that CLI on
 *         PATH with a recorded canned result (`stubBinDir`/`writeToolStubs`) so the
 *         downstream script logic runs with no live service. Demonstrated on
 *         superpowers' find-polluter.sh (shells out to `npm`).
 *
 * Everything here is offline, deterministic, and needs no API key — distinct from
 * the bwrap-gated egress/fs tests in run-hook.test.ts (which skip without a
 * sandbox). The per-plugin scorecards (test/dogfood/*.COVERAGE.md)
 * record the full rung breakdown, including the model-gated (trigger/behavior) and
 * R3 (real browser/DB) items these cheap tiers cannot reach.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";

import { runHook } from "../../run-hook.js";
import { stubBinDir } from "../../tool-stub.js";
import { scanPlugin } from "../../scan.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeDialect } from "./dialect.js";

// __dirname is dist/adapters/claude-code at runtime; vendored plugins are at the
// repo root. Matches the relative climb in vendor.test.ts.
const VENDOR = "../../../test/dogfood";
const omcRoot = join(__dirname, VENDOR, "oh-my-claudecode@deee3a4");
const spRoot = join(__dirname, VENDOR, "superpowers@6fd4507");
const wsRoot = join(__dirname, VENDOR, "wshobson-accessibility@cf6059d");

// ===========================================================================
// oh-my-claudecode — R1
// ===========================================================================

test("OMC keyword-detector (R1): a magic keyword injects the routing context", () => {
  // The UserPromptSubmit hook runs as a plain process — no model, no sandbox. We
  // pipe a real prompt and assert it injects the skill-routing additionalContext.
  // (run-hook.test.ts covers the SAME hook under bwrap egress/fs recording, which
  // SKIPS without a sandbox; this is the always-runs free floor underneath it.)
  const r = runHook(
    `node "${omcRoot}/scripts/run.cjs" "${omcRoot}/scripts/keyword-detector.mjs"`,
    { hook_event_name: "UserPromptSubmit", prompt: "please ultrawork on this" },
    { env: { CLAUDE_PLUGIN_ROOT: omcRoot }, timeoutMs: 15000 },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.blocked, false);
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext ?? "",
    /MAGIC KEYWORD: ULTRAWORK/,
  );
});

test("OMC keyword-detector (R1): an ordinary prompt injects NOTHING (no false-fire)", () => {
  // The precision half of the keyword router, decided deterministically: a prompt
  // with no magic keyword must not inject routing — it suppresses output instead.
  const r = runHook(
    `node "${omcRoot}/scripts/run.cjs" "${omcRoot}/scripts/keyword-detector.mjs"`,
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "what does this function return?",
    },
    { env: { CLAUDE_PLUGIN_ROOT: omcRoot }, timeoutMs: 15000 },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.blocked, false);
  assert.equal(
    r.json?.hookSpecificOutput?.additionalContext ?? undefined,
    undefined,
    "no routing context should be injected for a keyword-free prompt",
  );
});

test("OMC scan (R1): skills carry trigger descriptions; agents declare a tool contract", () => {
  // Structural facts the cheap tier verifies for free. OMC's ask + verify skills
  // each ship a description (the trigger surface a model-gated eval would then
  // measure); its code-reviewer/critic agents DO declare a contract (via
  // disallowedTools: Write, Edit), so they are NOT the inherits-all footgun.
  const report = scanPlugin(omcRoot, claudeCodeLayout, claudeCodeDialect);

  for (const s of report.skills) {
    assert.ok(
      s.hasDescription,
      `skill ${s.name} should ship a trigger description`,
    );
  }
  assert.ok(
    report.skills.some((s) => s.name === "ask"),
    "expected the ask skill",
  );
  assert.ok(
    report.skills.some((s) => s.name === "verify"),
    "expected the verify skill",
  );
  assert.ok(report.mcp, "OMC ships the `t` MCP server — flagged, not wired");
});

// ===========================================================================
// superpowers — R1 (hook fires) + R2 (shell-out skill via PATH stub)
// ===========================================================================

test("superpowers session-start (R1): injects the using-superpowers context", () => {
  // The SessionStart hook is a pure bash script — runs directly, no model. In the
  // vendored slice the using-superpowers skill is intentionally absent (the known
  // dangling ref vendor.test.ts asserts), so the hook hits its read-fallback. The
  // R1 fact under test is the INJECTION SHAPE: it always emits the superpowers
  // preamble in additionalContext regardless of the skill body's availability.
  const r = runHook(
    `bash "${spRoot}/hooks/run-hook.cmd" session-start`,
    { hook_event_name: "SessionStart", source: "startup" },
    { env: { CLAUDE_PLUGIN_ROOT: spRoot }, timeoutMs: 15000 },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.blocked, false);
  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(ctx, /You have superpowers/);
  assert.match(ctx, /using-superpowers/);
});

test("superpowers session-start (R2): a reconstructed plugin root injects the REAL skill body", () => {
  // R2 record-replay shape WITHOUT a stubbed binary: the slice omits the skill the
  // hook reads, so we reconstruct a COMPLETE plugin root (copy the hook scripts +
  // supply a using-superpowers/SKILL.md fixture) and prove the hook embeds the
  // skill's actual content into additionalContext. The vendored snapshot is never
  // mutated — we copy out, then add the missing file beside the copy.
  const root = mkdtempSync(join(tmpdir(), "sp-complete-"));
  const hooksDir = join(root, "hooks");
  const skillDir = join(root, "skills", "using-superpowers");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  for (const f of ["run-hook.cmd", "session-start"]) {
    const dest = join(hooksDir, f);
    copyFileSync(join(spRoot, "hooks", f), dest);
    chmodSync(dest, 0o755);
  }
  const marker = "VIGILES_USING_SUPERPOWERS_FIXTURE_BODY";
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: using-superpowers\ndescription: how to use skills\n---\n\n${marker}\n`,
  );

  const r = runHook(
    `bash "${join(hooksDir, "run-hook.cmd")}" session-start`,
    { hook_event_name: "SessionStart", source: "startup" },
    { env: { CLAUDE_PLUGIN_ROOT: root }, timeoutMs: 15000 },
  );
  assert.equal(r.exitCode, 0);
  const ctx = r.json?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(
    ctx,
    new RegExp(marker),
    "the hook should embed the real using-superpowers body once the ref resolves",
  );
});

test("superpowers find-polluter.sh (R2): a recorded `npm` stub on PATH drives the bisection", () => {
  // THE canonical R2 demonstration of the new helper on a real shell-out skill
  // script. find-polluter.sh bisects a test suite by shelling out to `npm test`
  // per file and checking for a pollution artifact. We SHADOW `npm` on PATH with a
  // recorded canned result (stubBinDir → writeToolStubs) — exit 0, no side effect,
  // exactly as a clean run records — so the script's real bisection logic runs to
  // its "no polluter found" terminus with NO live npm and NO model.
  const sp = join(spRoot, "skills/systematic-debugging/find-polluter.sh");
  const root = mkdtempSync(join(tmpdir(), "sp-polluter-"));
  const work = join(root, "work");
  const src = join(work, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.test.ts"), "");
  writeFileSync(join(src, "b.test.ts"), "");

  // Recorded fixture: a clean `npm test` exits 0 and creates nothing.
  const bin = stubBinDir([{ name: "npm", stdout: "ok\n", exitCode: 0 }], root);

  const r = runHook(
    `bash "${sp}" .vigiles-pollution-never './src/*.test.ts'`,
    { hook_event_name: "PreToolUse" },
    {
      cwd: work,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeoutMs: 15000,
    },
  );
  assert.equal(r.exitCode, 0, r.stderr);
  // It actually walked every test file via the stubbed npm and terminated clean.
  assert.match(r.stdout, /Found 2 test files/);
  assert.match(r.stdout, /Testing: \.\/src\/a\.test\.ts/);
  assert.match(r.stdout, /Testing: \.\/src\/b\.test\.ts/);
  assert.match(r.stdout, /No polluter found/);
});

// ===========================================================================
// wshobson-accessibility — R1 (the inherits-all footgun, via the scan surface)
// ===========================================================================

test("wshobson scan (R1): ui-visual-validator surfaces the inherits-all footgun", () => {
  // agent-runtime.test.ts proves parseAgentTools/decidePreToolUse report the
  // missing rail; this asserts the SAME footgun on the scan REPORT surface (what a
  // `vigiles audit` user sees): the agent ships no `tools:` line, so its contract is
  // null = inherits EVERY tool, despite being a read-only visual validator.
  const report = scanPlugin(wsRoot, claudeCodeLayout, claudeCodeDialect);
  const agent = report.agents.find((a) => a.name === "ui-visual-validator");
  assert.ok(agent, "expected the ui-visual-validator agent");
  assert.equal(
    agent.tools,
    null,
    "no tools: line → null contract → inherits all (the footgun)",
  );
});

test("wshobson scan (R1): WCAG skills carry trigger descriptions", () => {
  // The two audit skills each ship a description — the surface a model-gated
  // trigger-rate eval would measure. The cheap tier just confirms it's present.
  const report = scanPlugin(wsRoot, claudeCodeLayout, claudeCodeDialect);
  assert.ok(report.skills.length >= 2, "expected ≥ 2 accessibility skills");
  for (const s of report.skills) {
    assert.ok(
      s.hasDescription,
      `skill ${s.name} should ship a trigger description`,
    );
  }
  assert.ok(
    report.skills.some((s) => s.name === "wcag-audit-patterns"),
    "expected wcag-audit-patterns",
  );
});

// Reference the raw agent file so the relative-path climb stays honest even if the
// scan surface changes shape — a cheap guard that the snapshot is where we think.
test("wshobson: the vendored agent file is reachable at the pinned path", () => {
  const md = readFileSync(
    join(wsRoot, "agents/ui-visual-validator.md"),
    "utf-8",
  );
  assert.match(md, /name:\s*ui-visual-validator/);
  assert.ok(!/^tools:/m.test(md), "the wild agent ships no tools: line");
});
