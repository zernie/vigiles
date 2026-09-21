/**
 * OpenCode prototype validation — proves the harness-adapter kit generalizes to
 * the optional-transport-port shape WITHOUT shipping OpenCode support. The point:
 * OpenCode does pillar 1 AND is mockable (openai-compatible) BUT its hooks are
 * in-process JS/TS plugin modules, so it declares shellHooks:false and ships NO
 * hookProtocol — exercising the new capability gating. opencodeAdapter is
 * internal-only (not registered, not exported); this suite drives it through the
 * conformance kit and the real compiler + loader against OpenCode-shaped fixtures.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HarnessAdapter } from "../../core/adapter.js";
import { opencodeAdapter } from "./adapter.js";
import { opencodeDialect } from "./dialect.js";
import { opencodeLayout } from "./layout.js";
import {
  assertAdapterConformance,
  assertHarnessTestable,
} from "../../adapter-conformance.js";
import { ADAPTERS, getAdapter } from "../../adapter-registry.js";
import { compileAgent } from "../../core/compile.js";
import { experimental_agent } from "../../core/spec.js";
// The generic, layout-driven loader lives at the composition root; the OpenCode
// prototype reuses it with opencodeLayout (no cross-adapter import).
import { loadPlugin } from "../../plugin-loader.js";
import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

test("opencodeAdapter passes the conformance kit (a shellHooks:false adapter with no hookProtocol)", () => {
  assertAdapterConformance(opencodeAdapter);
});

test("the blocked shell-hook port is unrepresentable in the type, and absent at run time", () => {
  assert.equal(opencodeAdapter.capabilities.shellHooks, false);
  // 🔴 WIDENED ON PURPOSE. `opencodeAdapter` is declared
  // `as const satisfies HarnessAdapter`, so its own type has no `hookProtocol`
  // property at all — writing `opencodeAdapter.hookProtocol` is now TS2339, and
  // that compile error is the ratchet this line used to stand in for. A
  // third-party adapter authored in JavaScript gets no such check, so the
  // RUN-TIME fact is still asserted, through the widened port type every
  // consumer of the registry sees.
  const asPort: HarnessAdapter = opencodeAdapter;
  assert.equal(asPort.hookProtocol, undefined);
});

test("opencodeAdapter IS harness-testable — assertHarnessTestable returns runtime+modelMock", () => {
  const { runtime, modelMock } = assertHarnessTestable(opencodeAdapter);
  assert.equal(runtime.name, "opencode");
  assert.equal(modelMock.name, "opencode");
});

// NOTE: we deliberately do NOT call assertAdapterLoadsHooks for opencode — that's
// a shell-hook settings round-trip, which does not apply to code-module hooks.

test("the compiler verifies a subagent tool contract under opencodeDialect", () => {
  // An OpenCode built-in passes; a Claude-Code-only tool (NotebookEdit) is
  // flagged — proving the SAME compiler validates against the injected catalog.
  const ok = compileAgent(
    experimental_agent({
      name: "w",
      description: "x",
      tools: ["bash"],
      body: "b",
    }),
    { specFile: "w.md.spec.ts", dialect: opencodeDialect },
  );
  assert.equal(ok.errors.filter((e) => e.type === "unknown-tool").length, 0);

  const bad = compileAgent(
    experimental_agent({
      name: "w",
      description: "x",
      tools: ["NotebookEdit"],
      body: "b",
    }),
    { specFile: "w.md.spec.ts", dialect: opencodeDialect },
  );
  assert.ok(bad.errors.some((e) => e.type === "unknown-tool"));
});

test("the loader reads a real OpenCode-shaped plugin through opencodeLayout", () => {
  const dir = makeTmpDir("opencode");
  try {
    // AGENTS.md instruction file + an agent surface under .opencode/agent.
    writeFileSync(join(dir, "AGENTS.md"), "# Agent rules\n");
    mkdirSync(join(dir, ".opencode", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode", "agent", "reviewer.md"),
      "---\nname: reviewer\ndescription: review code\n---\nReview.\n",
    );

    const loaded = loadPlugin(dir, opencodeLayout);

    // instruction file picked up under its own name
    assert.ok(loaded.files["AGENTS.md"]);
    // agent surface materialized at its real path (materializeRoot is "", so the
    // `.opencode/agent/` segment is NOT doubled).
    assert.ok(loaded.files[join(".opencode", "agent", "reviewer.md")]);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the OpenCode prototype is internal-only — not in the public registry", () => {
  assert.equal(getAdapter("opencode"), undefined);
  // 🔴 WIDENED, AND THE WIDENING IS THE POINT. `ADAPTERS` is
  // `as const satisfies`, so `a.name` is `"claude-code" | "codex"` and the
  // direct comparison is now TS2367 — "these types have no overlap" is
  // TypeScript agreeing with the assertion at compile time. The run-time check
  // is kept through a widened view, because it is also asserting that the
  // registry the CLI walks has not gained an entry behind the type's back.
  const names: readonly string[] = ADAPTERS.map((a) => a.name);
  assert.ok(!names.includes(opencodeAdapter.name));
});
