/**
 * opencodeAdapter — EXPERIMENTAL, internal-only prototype `HarnessAdapter`. It
 * exists to PROVE the kit generalizes to the optional-transport-port shape: a
 * harness that does pillar 1 AND is mockable (openai-compatible) BUT whose hooks
 * are in-process JS/TS plugin modules, not shell processes. So it declares
 * `shellHooks: false`, ships NO `hookProtocol`, and the conformance kit must
 * accept it without demanding a fake one. This is the pillar-1-only,
 * no-shell-hooks shape the capability gating was built for.
 *
 * 🔴 AND IT IS THE PORT'S THIRD IMPLEMENTATION, which is why two of the port's
 * illegal states were live HERE and nowhere else: a port validated against two
 * implementations cannot see a state only the third can reach. The other one
 * was in its layout (a skill dir outside `surfaceDirs`).
 *
 * It is deliberately NOT registered in `src/adapter-registry.ts` and NOT exported
 * from any `vigiles/*` subpath, so the CLI never auto-detects OpenCode and
 * consumers can't import it. Promote it (register + `vigiles/opencode` export +
 * the deferred transport renderers) only when OpenCode support actually ships.
 */
import type { DetectSignal, HarnessAdapter } from "../../core/adapter.js";
import { opencodeDialect } from "./dialect.js";
import { opencodeLayout } from "./layout.js";
import { layoutClaims } from "../../core/surface-discovery.js";
// `opencodeRuntime` / `opencodeModelMock` are NOT imported: with
// `harnessTesting: false` the type gives those fields `?: never`, so carrying
// them would be a compile error. The modules stay on disk for the commit that
// adds a driver and flips the flag back.

export const opencodeAdapter = {
  name: "opencode",
  // 🔴 `harnessTesting: false`, AND IT USED TO SAY `true`. That declaration was
  // the port's second live illegal state: the flag was set, `runtime` and
  // `modelMock` were present, and there was NO `harnessTestDriver` behind them
  // — so `runHarnessTest` threw "declares harnessTesting but carries no
  // harnessTestDriver" at run time, and the conformance kit missed it because
  // it checked the two ports it knew about and not the thunk.
  //
  // The declaration was also simply untrue, and the repo said so elsewhere:
  // `docs/harnesses.md` records OpenCode's mockable tier as "declared but not
  // yet built". So this is not a downgrade — it is the flag catching up with
  // the tier, and `runtime`/`modelMock` come off with it because the `false`
  // arm of `TestingPorts` types them `?: never`. Set it back to `true` in the
  // same commit that adds a driver; the type will refuse anything else.
  harnessTesting: false,
  // Hooks are in-process JS/TS plugin modules — no shell-hook tier, hence
  // shellHooks:false and NO hookProtocol (the `false` arm types it `?: never`,
  // so shipping one is now an error rather than dead weight).
  shellHooks: false,
  subagents: true,
  dialect: opencodeDialect,
  layout: opencodeLayout,
  // Derived from the layout, never listed again here — see `claims` on
  // `HarnessAdapter` for why this method takes a PATH and not a root.
  claims(path: string): boolean {
    return layoutClaims(opencodeLayout, path);
  },
  detect(exists: (repoRelative: string) => boolean): DetectSignal {
    // An `opencode.json` is a strong signal; a bare AGENTS.md is weak (many
    // harnesses read it). (Unused while unregistered — kept for symmetry, and
    // so the property tests have a THIRD implementation to run against.)
    if (exists(opencodeLayout.manifestPath))
      return { specificity: 3, via: "manifest" };
    if (exists(opencodeLayout.instructionFile))
      return { specificity: 1, via: "instruction-file" };
    return { specificity: 0, via: "instruction-file" };
  },
} as const satisfies HarnessAdapter;
