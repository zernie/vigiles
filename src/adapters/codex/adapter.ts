/**
 * codexAdapter — the OpenAI Codex `HarnessAdapter`. Bundles the five Codex ports
 * + a `detect`. SHIPPED: registered in `src/adapter-registry.ts` (the CLI
 * auto-detects a `.codex/config.toml` or `AGENTS.md` repo) and exported as
 * `vigiles/codex`. It passes `assertAdapterConformance`/`assertAdapterLoadsHooks`,
 * drives the compiler + loader against real Codex fixtures (codex.test.ts), and
 * its transport (`mock-model.ts`) is proven against the real `codex` binary.
 *
 * Caveat — pillar 1 (compile) is partial: the instruction/skill *renderers* still
 * emit the Claude-Code shape until the format-axis renderers land
 * (`research/code-adapter-architecture.md`). Pillar 2 (harness testing) is full.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HarnessAdapter } from "../../core/adapter.js";
import { codexDialect } from "./dialect.js";
import { codexLayout } from "./layout.js";
import { layoutClaims } from "../../core/surface-discovery.js";
import { codexRuntime } from "./runtime.js";
import { codexHookProtocol } from "./hook-protocol.js";
import { codexModelMock } from "./model-mock.js";

export const codexAdapter = {
  name: "codex",
  // Full convergence with Claude Code: mockable (Responses SSE) + shell hooks
  // with veto (permissionDecision/exit 2). Both pillars, all tiers.
  harnessTesting: true,
  shellHooks: true,
  // Codex `[agents]` is a concurrency table, not a subagent tool-contract file
  // — the subagent-surface rules report n/a here (a deliberate non-goal).
  subagents: false,
  dialect: codexDialect,
  layout: codexLayout,
  runtime: codexRuntime,
  hookProtocol: codexHookProtocol,
  modelMock: codexModelMock,
  harnessTestDriver: async () => (await import("./driver.js")).codexDriver,
  // Derived from the layout, never listed again here — see `claims` on
  // `HarnessAdapter` for why this method takes a PATH and not a root.
  claims(path: string): boolean {
    return layoutClaims(codexLayout, path);
  },
  detect(root: string): number {
    // A `.codex/config.toml` is a strong signal; a bare AGENTS.md is weak (many
    // harnesses read it). (Unused while unregistered — kept for symmetry.)
    if (existsSync(join(root, ".codex", "config.toml"))) return 3;
    if (existsSync(join(root, codexLayout.instructionFile))) return 1;
    return 0;
  },
} as const satisfies HarnessAdapter;
