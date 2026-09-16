/**
 * Adapter CONTRACT suite — the structural enforcement of "test both harnesses"
 * (the test-both-harnesses + adapter-aware-lint-rules rules). The conformance
 * KIT (src/adapter-conformance.ts) is the ports-and-adapters contract; this runs
 * it over the WHOLE registry instead of ad-hoc per-adapter, so:
 *
 *  - registering an adapter in ADAPTERS auto-subjects it to EVERY contract — you
 *    cannot forget to test a new harness;
 *  - a capability an adapter lacks is a VISIBLE, declared `it.skip(... n/a ...)`,
 *    never a silent CC-only pass (no-silent-skips);
 *  - a `src/adapters/<dir>/` that exists but isn't registered (and isn't a
 *    declared prototype) FAILS the meta-test — the gap is structural, not
 *    disciplinary.
 *
 * What it does NOT catch: a harness-FACING capability whose assertion was written
 * CC-only OUTSIDE this contract. Putting an assertion INTO the contract is the
 * judgment the test-both-harnesses rule governs; once it's here, every adapter
 * (current + future) is held to it or must declare it n/a.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ADAPTERS } from "./adapter-registry.js";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
  assertHarnessTestable,
} from "./adapter-conformance.js";

// Adapter dirs deliberately NOT in ADAPTERS — experimental prototypes that
// validate the architecture but aren't shipped (see research/*-prototype-findings.md).
// A new dir that's neither registered nor listed here FAILS the meta-test below.
const UNREGISTERED_PROTOTYPES = ["opencode"];

describe("adapter contract (run over the whole registry)", () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      // Reference verification (pillar 1) is the always-true capability.
      it("passes port + cross-port conformance", () => {
        assertAdapterConformance(adapter);
      });

      // Shell-hook round-trip — gated on the capability, loud skip otherwise.
      const hooksTest = adapter.capabilities.shellHooks ? it : it.skip;
      hooksTest(
        adapter.capabilities.shellHooks
          ? "round-trips its native hooks config (JSON/TOML)"
          : "round-trips its native hooks config — n/a (no shell hooks)",
        () => {
          assertAdapterLoadsHooks(adapter);
        },
      );

      // The gap-catching test: vigiles SHIPS inject hooks (the SessionStart lint
      // summary; the PostToolUse refs + eval-lock nudges). For those to reach the
      // agent, the harness must honor `additionalContext` on those events. This
      // asserts it per-harness — so a harness that CAN'T deliver our hooks fails
      // the build, instead of the gap sitting unverified in prose (the exact
      // miss that let Codex inject go unconfirmed). Events vigiles' shipped hooks
      // use: PostToolUse (nudges) + SessionStart (summary).
      hooksTest(
        adapter.capabilities.shellHooks
          ? "honors additionalContext on the events vigiles' shipped hooks use"
          : "honors additionalContext — n/a (no shell hooks)",
        () => {
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the legacy field ON PURPOSE: this asserts the derived table reproduces it exactly, which is what makes them one source
          const injectable = adapter.hookProtocol?.injectableEvents ?? [];
          for (const ev of ["PostToolUse", "SessionStart"]) {
            expect(
              injectable,
              `${adapter.name} does not declare inject support for ${ev} — vigiles' shipped hooks couldn't deliver`,
            ).toContain(ev);
          }
        },
      );

      // Harness testing (pillar 2) — gated on the capability, loud skip otherwise.
      const testableTest = adapter.capabilities.harnessTesting ? it : it.skip;
      testableTest(
        adapter.capabilities.harnessTesting
          ? "exposes a mockable runtime + modelMock (harness testing)"
          : "exposes a mockable runtime + modelMock — n/a (reference-only)",
        () => {
          const { runtime, modelMock } = assertHarnessTestable(adapter);
          expect(runtime).toBeTruthy();
          expect(modelMock).toBeTruthy();
        },
      );
    });
  }
});

describe("adapter registry is complete", () => {
  it("every src/adapters/<dir> is registered in ADAPTERS (or a declared prototype)", () => {
    const dirs = readdirSync(resolve(__dirname, "adapters"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const registered = new Set(ADAPTERS.map((a) => a.name));
    const unaccounted = dirs.filter(
      (d) => !registered.has(d) && !UNREGISTERED_PROTOTYPES.includes(d),
    );
    expect(
      unaccounted,
      `adapter dir(s) neither registered in ADAPTERS nor declared a prototype: ${unaccounted.join(
        ", ",
      )} — register them (so the contract tests run) or add to UNREGISTERED_PROTOTYPES with a reason`,
    ).toEqual([]);
  });

  it("has at least Claude Code and Codex registered", () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
  });
});
