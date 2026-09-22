/**
 * claudeCodeAdapter — the Claude Code `HarnessAdapter`: the five port
 * implementations bundled, plus a `detect` that recognizes a Claude Code repo
 * (a `.claude-plugin/` manifest, a `.claude/settings.json`, or a `CLAUDE.md`).
 * This is the reference adapter a second harness (Codex, Gemini, …) mirrors.
 */
import type {
  DetectSignal,
  HarnessAdapter,
  InstallReader,
} from "../../core/adapter.js";
import { checkDialectDrift, formatDialectDrift } from "./dialect-drift.js";
import {
  checkSkillReachability,
  formatSkillReachability,
} from "./skill-reachability.js";
import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";
import { layoutClaims } from "../../core/surface-discovery.js";
import { claudeCodeRuntime } from "./runtime.js";
import { claudeCodeHookProtocol } from "./hook-protocol.js";
import { claudeCodeModelMock } from "./model-mock.js";

export const claudeCodeAdapter = {
  name: "claude-code",
  // The reference harness: every tier. Mockable transport (Anthropic SSE) and
  // shell hooks (exit 2 / decision JSON) — both pillars, all tiers.
  //
  // The flags are FLAT, not nested under `capabilities`, because TypeScript
  // narrows a union by a discriminant on the object itself and never by
  // `a.capabilities.x` — nesting them is what made "declares the capability,
  // ships no port" expressible at all.
  harnessTesting: true,
  shellHooks: true,
  subagents: true,
  dialect: claudeCodeDialect,
  layout: claudeCodeLayout,
  runtime: claudeCodeRuntime,
  hookProtocol: claudeCodeHookProtocol,
  modelMock: claudeCodeModelMock,
  // Imported inside the thunk, not at the top: a top-level import runs at module
  // init and would pull the whole test/compiler graph back in.
  harnessTestDriver: async () =>
    (await import("../../harness-test.js")).claudeCodeDriver,
  // The executing tiers' driver, thunked for the same reason: it reaches the
  // real-model graph, which an adapter READ (the hook runtime) must not pay for.
  liveDriver: async () => (await import("../../eval.js")).claudeCodeLiveDriver,
  // Derived from the layout, never listed again here — see `claims` on
  // `HarnessAdapter` for why this method takes a PATH and not a root.
  claims(path: string): boolean {
    return layoutClaims(claudeCodeLayout, path);
  },
  // Takes the domain's `exists`, never a root: this adapter cannot enumerate
  // anything, and it asks only about the three paths its own `claims` covers.
  detect(exists: (repoRelative: string) => boolean): DetectSignal {
    // Most specific signal wins: a plugin manifest (3) > repo settings (2) >
    // a bare CLAUDE.md (1, weak — many tools also read it / AGENTS.md).
    if (exists(claudeCodeLayout.manifestPath))
      return { specificity: 3, via: "manifest" };
    if (exists(claudeCodeLayout.settingsPath))
      return { specificity: 2, via: "settings" };
    if (exists(claudeCodeLayout.instructionFile))
      return { specificity: 1, via: "instruction-file" };
    return { specificity: 0, via: "instruction-file" };
  },
  /**
   * The two install diagnostics that used to sit behind
   * `if (adapter.name === "claude-code")` in the CLI, now reached through the
   * port. Both are genuinely THIS harness's and both would MISLEAD on another
   * one — the reachability fix line is `claude plugin install`, which a Codex
   * user cannot run — which is why the gate was right and only its shape wrong.
   *
   * Never throws and never scores: each check degrades to "nothing to say".
   */
  advisories(read: InstallReader): readonly string[] {
    return [
      // Our hand-maintained tool/hook catalog vs the `@anthropic-ai/claude-code`
      // actually installed on this machine. A machine read, not a repo read.
      formatDialectDrift(checkDialectDrift()),
      // Can the agent SEE the skills vigiles ships here? `npm install` drops
      // them in node_modules, which Claude Code never scans; the plugin install
      // is what wires them, and until it runs the teaching surface is silently
      // absent.
      formatSkillReachability(checkSkillReachability(read)),
    ].filter((line): line is string => line !== null);
  },
} as const satisfies HarnessAdapter;
