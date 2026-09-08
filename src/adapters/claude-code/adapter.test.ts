/**
 * Adapter-bundle test suite (vitest): claudeCodeAdapter bundles all five ports, passes the conformance kit, the kit catches a broken adapter, detect recognizes a CLAUDE.md / .claude-plugin repo (and not an empty dir), detectAdapter falls back to Claude Code, getAdapter looks up by name
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claudeCodeAdapter } from "./adapter.js";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
  assertHarnessTestable,
  checkAdapterConformance,
} from "../../adapter-conformance.js";
import {
  detectAdapter,
  detectAdapterResult,
  resolveAdapter,
  getAdapter,
} from "../../adapter-registry.js";
import type { HarnessAdapter } from "../../core/adapter.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

test("claudeCodeAdapter bundles all five ports + a detect (full capabilities)", () => {
  assert.equal(claudeCodeAdapter.name, "claude-code");
  // Claude Code is a full-capability adapter — every transport port is present.
  assert.equal(claudeCodeAdapter.capabilities.harnessTesting, true);
  assert.equal(claudeCodeAdapter.capabilities.shellHooks, true);
  assert.equal(claudeCodeAdapter.dialect.name, "claude-code");
  assert.equal(claudeCodeAdapter.layout.name, "claude-code");
  assert.equal(claudeCodeAdapter.runtime?.agentBinary, "claude");
  assert.equal(claudeCodeAdapter.hookProtocol?.blockExitCode, 2);
  assert.equal(claudeCodeAdapter.modelMock?.modelEndpoint, "/v1/messages");
});

test("claudeCodeAdapter passes the conformance kit", () => {
  assertAdapterConformance(claudeCodeAdapter); // throws on failure
});

test("claudeCodeAdapter passes behavioural settings-load conformance", () => {
  assertAdapterLoadsHooks(claudeCodeAdapter); // round-trips a real settings file
});

test("conformance kit catches a broken adapter", () => {
  const broken: HarnessAdapter = {
    ...claudeCodeAdapter,
    name: "",
    dialect: { ...claudeCodeAdapter.dialect, builtinAgentTools: [] },
  };
  const r = checkAdapterConformance(broken);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((m) => m.includes("name is empty")));
  assert.ok(r.failures.some((m) => m.includes("builtinAgentTools")));
});

test("conformance kit catches a dialect that contradicts ITSELF", () => {
  // The exact state that shipped for months: `Agent` claimed as both declarable
  // and never-available, while its own alias `Task` sat in the built-in catalog.
  // Nothing compared the two lists, so nothing noticed. This pins the WIRING —
  // `dialectVocabularyProblems` has its own unit tests, but they would all pass
  // with the call removed from the kit.
  const contradictory: HarnessAdapter = {
    ...claudeCodeAdapter,
    dialect: {
      ...claudeCodeAdapter.dialect,
      builtinAgentTools: ["Read", "Agent"],
      neverAvailableTools: ["Agent"],
      sideEffectingTools: [],
      subagentToolVocabulary: undefined,
      hookEventVocabulary: undefined,
    },
  };
  const r = checkAdapterConformance(contradictory);
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((m) => m.includes("dialect self-contradiction")),
    `expected a self-contradiction failure, got: ${r.failures.join(" | ")}`,
  );
});

test("conformance kit catches flat lists that drift from the vocabulary", () => {
  const drifted: HarnessAdapter = {
    ...claudeCodeAdapter,
    dialect: {
      ...claudeCodeAdapter.dialect,
      // The vocabulary still declares `Agent` as declarable; the projection lost it.
      builtinAgentTools: claudeCodeAdapter.dialect.builtinAgentTools.filter(
        (t) => t !== "Agent",
      ),
    },
  };
  const r = checkAdapterConformance(drifted);
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((m) => m.includes("subagentToolVocabulary")),
    `expected a projection failure, got: ${r.failures.join(" | ")}`,
  );
});

test("conformance catches a shell-hook adapter that can't inject context", () => {
  // The exact class of gap that let Codex's inject support sit unverified: a
  // shellHooks adapter whose hookProtocol declares NO injectable events (so an
  // inject/nudge hook would silently never reach the agent). The kit must reject it.
  const proto = claudeCodeAdapter.hookProtocol;
  assert.ok(proto, "fixture precondition: CC has a hookProtocol");
  const noInject: HarnessAdapter = {
    ...claudeCodeAdapter,
    hookProtocol: { ...proto, injectableEvents: [] },
  };
  const r = checkAdapterConformance(noInject);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((m) => m.includes("injectableEvents is empty")));
});

test("conformance ACCEPTS a pillar-1-only adapter (no transport ports)", () => {
  // A closed, un-mockable harness (Cursor/Devin shape): reference verification
  // only. It legitimately omits runtime/hookProtocol/modelMock, and the kit must
  // not demand them — the capability gate, not a fake transport.
  const pillar1Only: HarnessAdapter = {
    name: "cursor-ish",
    capabilities: {
      referenceVerification: true,
      harnessTesting: false,
      shellHooks: false,
      subagents: false,
    },
    dialect: { ...claudeCodeAdapter.dialect, name: "cursor-ish" },
    layout: { ...claudeCodeAdapter.layout, name: "cursor-ish" },
    detect: () => 0,
  };
  assertAdapterConformance(pillar1Only); // throws on failure → must not throw
  assert.throws(
    () => assertHarnessTestable(pillar1Only),
    /does not support harness testing/,
  );
});

test("conformance REJECTS a half-wired adapter (claims harnessTesting, no runtime)", () => {
  const halfWired: HarnessAdapter = {
    name: "claude-code",
    capabilities: {
      referenceVerification: true,
      harnessTesting: true, // claims it…
      shellHooks: false,
      subagents: true,
    },
    dialect: claudeCodeAdapter.dialect,
    layout: claudeCodeAdapter.layout,
    // …but no runtime/modelMock, and a stray hookProtocol it disclaims.
    hookProtocol: claudeCodeAdapter.hookProtocol,
    detect: () => 0,
  };
  const r = checkAdapterConformance(halfWired);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((m) => m.includes("runtime is missing")));
  assert.ok(r.failures.some((m) => m.includes("modelMock is missing")));
  assert.ok(r.failures.some((m) => m.includes("shellHooks is false")));
});

test("detect: specificity score — empty 0, CLAUDE.md 1, manifest 3", () => {
  const dir = makeTmpDir("adapter-detect");
  try {
    assert.equal(claudeCodeAdapter.detect(dir), 0);
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\n");
    assert.equal(claudeCodeAdapter.detect(dir), 1); // weak signal
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
    assert.equal(claudeCodeAdapter.detect(dir), 3); // strong signal wins
  } finally {
    cleanupTmpDir(dir);
  }
});

test("detectAdapterResult falls back to Claude Code for an unmarked repo", () => {
  const dir = makeTmpDir("adapter-registry");
  try {
    const r = detectAdapterResult(dir);
    assert.equal(r.adapter.name, "claude-code");
    assert.equal(r.fallback, true);
    assert.deepEqual(r.ambiguousWith, []);
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\n");
    const r2 = detectAdapterResult(dir);
    assert.equal(r2.adapter.name, "claude-code");
    assert.equal(r2.fallback, false);
    assert.equal(detectAdapter(dir).name, "claude-code");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveAdapter: --harness override wins, unknown throws", () => {
  const dir = makeTmpDir("adapter-resolve");
  try {
    assert.equal(resolveAdapter(dir).name, "claude-code"); // auto-detect
    assert.equal(resolveAdapter(dir, "claude-code"), claudeCodeAdapter);
    assert.equal(resolveAdapter(dir, "codex").name, "codex"); // registered override
    assert.throws(
      () => resolveAdapter(dir, "no-such-harness"),
      /Unknown harness/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("getAdapter looks up by name", () => {
  assert.equal(getAdapter("claude-code"), claudeCodeAdapter);
  assert.equal(getAdapter("nope"), undefined);
});
