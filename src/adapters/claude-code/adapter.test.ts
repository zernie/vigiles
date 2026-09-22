/**
 * Adapter-bundle test suite (vitest): claudeCodeAdapter bundles all five ports, passes the conformance kit, the kit catches a broken adapter, detect recognizes a CLAUDE.md / .claude-plugin repo (and not an empty dir), detectAdapter falls back to Claude Code, getAdapter looks up by name
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  assert.equal(claudeCodeAdapter.harnessTesting, true);
  assert.equal(claudeCodeAdapter.shellHooks, true);
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
  //
  // TWO ways it is now caught, and the second is why this test changed: once the
  // dialect carries a capability table, the table would ANSWER for the broken
  // list and the adapter would pass. So an adapter declaring both must have them
  // AGREE — otherwise the richer source quietly covers for the emptied one.
  const proto = claudeCodeAdapter.hookProtocol;
  assert.ok(proto, "fixture precondition: CC has a hookProtocol");
  const noInject: HarnessAdapter = {
    ...claudeCodeAdapter,
    hookProtocol: { ...proto, injectableEvents: [] },
  };
  const r = checkAdapterConformance(noInject);
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((m) => m.includes("disagrees with dialect.eventCapabilities")), // prettier-ignore
    "a table that contradicts the emptied list must be reported, not used to pass",
  );

  // …and with NO table either, the original emptiness check is what catches it.
  const alsoNoTable: HarnessAdapter = {
    ...noInject,
    dialect: { ...claudeCodeAdapter.dialect, eventCapabilities: undefined },
  };
  const r2 = checkAdapterConformance(alsoNoTable);
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((m) => m.includes("injectableEvents is empty")));
});

test("conformance ACCEPTS a pillar-1-only adapter (no transport ports)", () => {
  // A closed, un-mockable harness (Cursor/Devin shape): reference verification
  // only. It legitimately omits runtime/hookProtocol/modelMock, and the kit must
  // not demand them — the capability gate, not a fake transport.
  const pillar1Only: HarnessAdapter = {
    name: "cursor-ish",
    harnessTesting: false,
    shellHooks: false,
    subagents: false,
    dialect: { ...claudeCodeAdapter.dialect, name: "cursor-ish" },
    layout: { ...claudeCodeAdapter.layout, name: "cursor-ish" },
    claims: () => false,
    detect: () => ({ specificity: 0, via: "instruction-file" }) as const,
    // `[]` is the honest answer for a harness with nothing to say about its
    // install — which is exactly why `advisories` is required rather than a
    // capability flag: a pillar-1-only adapter still implements it.
    advisories: () => [],
  };
  assertAdapterConformance(pillar1Only); // throws on failure → must not throw
  assert.throws(
    () => assertHarnessTestable(pillar1Only),
    /does not support harness testing/,
  );
});

test("conformance REJECTS a half-wired adapter (claims harnessTesting, no runtime)", () => {
  // 🔴 THE CAST IS THE POINT, NOT A CONVENIENCE. This literal no longer
  // type-checks as a `HarnessAdapter`: the capability flags are discriminants
  // of unions, so "harnessTesting: true with no runtime" and "shellHooks: false
  // with a hookProtocol" are both compile errors — which is the ratchet, and is
  // why no adapter in this repo can be written this way again.
  //
  // The conformance kit still has to say it, for the case the type cannot
  // reach: a third-party adapter authored in JavaScript, or one crossing a
  // package boundary through a cast exactly like this one. So the test builds
  // the shape the only way left, and asserts the kit explains it.
  const halfWired = {
    name: "claude-code",
    harnessTesting: true, // claims it…
    shellHooks: false,
    subagents: true,
    dialect: claudeCodeAdapter.dialect,
    layout: claudeCodeAdapter.layout,
    // …but no runtime/modelMock/driver, and a stray hookProtocol it disclaims.
    hookProtocol: claudeCodeAdapter.hookProtocol,
    claims: () => false,
    detect: () => ({ specificity: 0, via: "instruction-file" }) as const,
  } as unknown as HarnessAdapter;
  const r = checkAdapterConformance(halfWired);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((m) => m.includes("runtime is missing")));
  assert.ok(r.failures.some((m) => m.includes("modelMock is missing")));
  assert.ok(r.failures.some((m) => m.includes("shellHooks is false")));
  // The check that did NOT exist when opencodeAdapter shipped this state.
  assert.ok(r.failures.some((m) => m.includes("harnessTestDriver is missing")));
});

test("detect: specificity + via — empty 0, CLAUDE.md 1, manifest 3", () => {
  const dir = makeTmpDir("adapter-detect");
  // `detect` takes the DOMAIN's predicate now, not a root, so the test builds
  // the same one the registry does. An adapter has no way to reach the disk.
  const exists = (rel: string): boolean => existsSync(join(dir, rel));
  try {
    assert.deepEqual(claudeCodeAdapter.detect(exists), {
      specificity: 0,
      via: "instruction-file",
    });
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\n");
    assert.deepEqual(claudeCodeAdapter.detect(exists), {
      specificity: 1,
      via: "instruction-file", // weak signal
    });
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
    assert.deepEqual(claudeCodeAdapter.detect(exists), {
      specificity: 3,
      via: "manifest", // strong signal wins
    });
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

test("instructionTargets names AGENTS.md — and detect/claims are UNCHANGED by it", () => {
  // 🔴 THE MEASUREMENT BEHIND THE FIELD, AS AN ASSERTION. `AGENTS.md` joined
  // `instructionTargets` on 2026-09-21 because the vendor reversed itself
  // ("Claude Code can read `AGENTS.md` as your project instructions", v2.1.277+
  // — see dialect.ts for the quote). The expected objection is that a second
  // target makes this adapter score a bare `AGENTS.md` repository and start
  // fighting Codex for it. It does not: `detect` reads the LAYOUT, never this
  // field. The two halves are pinned together on purpose, because the first
  // without the second is the change nobody would have merged.
  assert.deepEqual(claudeCodeAdapter.dialect.instructionTargets, [
    "CLAUDE.md",
    "AGENTS.md",
  ]);
  // [0] is the default COMPILE target (`core/compile.ts`), so the order is part
  // of the contract: this harness READS AGENTS.md, it does not author it.
  assert.equal(claudeCodeAdapter.dialect.instructionTargets[0], "CLAUDE.md");

  const asked: string[] = [];
  claudeCodeAdapter.detect((p) => {
    asked.push(p);
    return false;
  });
  assert.deepEqual(asked, [
    ".claude-plugin/plugin.json",
    ".claude/settings.json",
    "CLAUDE.md",
  ]);
  // And the reason it cannot change without someone deciding to: `claims` is
  // derived from the layout, and `adapter-properties.test.ts` refuses a
  // `detect` that asks about a path `claims` does not cover — so detecting on
  // AGENTS.md would force Claude Code to CLAIM a path Codex already owns.
  assert.equal(claudeCodeAdapter.claims("AGENTS.md"), false);
});

test("advisories() actually CONSULTS the reader — the bound property is not vacuous here", () => {
  // `adapter-properties.test.ts` asserts every repo path `advisories` asks
  // about is one this adapter claims. That property passes trivially for an
  // adapter that asks about nothing, which is the honest answer for a harness
  // with no install checks — but NOT for this one, whose whole reason to
  // implement the method is two checks that read the repo and the machine.
  // Without this, deleting the reachability check would leave the bound green.
  const askedRepo: string[] = [];
  const askedHome: string[] = [];
  claudeCodeAdapter.advisories({
    repo: (p) => {
      askedRepo.push(p);
      return null;
    },
    home: (p) => {
      askedHome.push(p);
      return null;
    },
    repoDependsOnVigiles: true,
    vendoredSkillNames: [],
  });
  assert.ok(
    askedRepo.length > 0,
    "advisories() asked the repo nothing — the reachability check is not wired",
  );
  assert.ok(
    askedHome.some((p) => p.includes("installed_plugins.json")),
    "advisories() never looked for the plugin install record",
  );
});

test("advisories() says nothing about a repo that does not depend on vigiles", () => {
  // The other half, and the one that keeps this out of every unrelated audit:
  // a non-consumer is never nagged. `checkDialectDrift` reads this machine's
  // own install, so the only assertion that holds everywhere is that the
  // reachability line is absent.
  const lines = claudeCodeAdapter.advisories({
    repo: () => null,
    home: () => null,
    repoDependsOnVigiles: false,
    vendoredSkillNames: [],
  });
  assert.ok(
    !lines.some((l) => l.includes("NOT reachable")),
    `advisories() nagged a non-consumer: ${lines.join(" / ")}`,
  );
});
