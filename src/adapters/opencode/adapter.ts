/**
 * opencodeAdapter — EXPERIMENTAL, internal-only prototype `HarnessAdapter`. It
 * exists to PROVE the kit generalizes to the optional-transport-port shape: a
 * harness that does pillar 1 AND is mockable (openai-compatible) BUT whose hooks
 * are in-process JS/TS plugin modules, not shell processes. So it declares
 * `shellHooks: false`, ships NO `hookProtocol`, and the conformance kit must
 * accept it without demanding a fake one. This is the pillar-1-+-mockable-but-
 * no-shell-hooks shape the capability gating was built for.
 *
 * It is deliberately NOT registered in `src/adapter-registry.ts` and NOT exported
 * from any `vigiles/*` subpath, so the CLI never auto-detects OpenCode and
 * consumers can't import it. Promote it (register + `vigiles/opencode` export +
 * the deferred transport renderers) only when OpenCode support actually ships.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HarnessAdapter } from "../../core/adapter.js";
import { opencodeDialect } from "./dialect.js";
import { opencodeLayout } from "./layout.js";
import { layoutClaims } from "../../core/surface-discovery.js";
import { opencodeRuntime } from "./runtime.js";
import { opencodeModelMock } from "./model-mock.js";

export const opencodeAdapter = {
  name: "opencode",
  // Pillar 1 + mockable (openai-chat SSE), but hooks are in-process JS/TS plugin
  // modules — no shell-hook tier, hence shellHooks:false and NO hookProtocol.
  capabilities: {
    referenceVerification: true,
    harnessTesting: true,
    shellHooks: false,
    subagents: true,
  },
  dialect: opencodeDialect,
  layout: opencodeLayout,
  runtime: opencodeRuntime,
  modelMock: opencodeModelMock,
  // No hookProtocol: OpenCode hooks are code modules, not shell processes.
  // Derived from the layout, never listed again here — see `claims` on
  // `HarnessAdapter` for why this method takes a PATH and not a root.
  claims(path: string): boolean {
    return layoutClaims(opencodeLayout, path);
  },
  detect(root: string): number {
    // An `opencode.json` is a strong signal; a bare AGENTS.md is weak (many
    // harnesses read it). (Unused while unregistered — kept for symmetry.)
    if (existsSync(join(root, "opencode.json"))) return 3;
    if (existsSync(join(root, opencodeLayout.instructionFile))) return 1;
    return 0;
  },
} as const satisfies HarnessAdapter;
