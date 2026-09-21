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
import type { HarnessAdapter } from "./core/adapter.js";
import { ADAPTERS, defaultAdapter } from "./adapter-registry.js";
import { DEFAULT_INSTRUCTION_TARGETS } from "./core/dialect.js";
import { opencodeAdapter } from "./adapters/opencode/adapter.js";
import {
  assertAdapterConformance,
  assertAdapterLoadsHooks,
  assertHarnessTestable,
} from "./adapter-conformance.js";

// Adapter dirs deliberately NOT in ADAPTERS — experimental prototypes that
// validate the architecture but aren't shipped (see research/*-prototype-findings.md).
// A new dir that's neither registered nor listed here FAILS the meta-test below.
const UNREGISTERED_PROTOTYPES = ["opencode"];

/**
 * The unregistered prototypes as ADAPTERS, so the port properties below run
 * against a THIRD implementation.
 *
 * 🔴 WHY A THIRD, when the registry has two: a port checked against two
 * implementations and broken by a third is the failure this whole redesign
 * exists to prevent, and `opencode` is where it actually happened — it shipped
 * with `skillDir` outside `surfaceDirs` (its skills were never read) and with
 * `harnessTesting: true` behind no driver, and the contract suite saw neither,
 * because the contract suite ranged over ADAPTERS and `opencode` is not in it.
 */
const PROTOTYPES = [
  opencodeAdapter,
] as const satisfies readonly HarnessAdapter[];

/** Every implementation of the port in this repo: shipped and prototype. */
const ALL_IMPLEMENTATIONS: readonly HarnessAdapter[] = [
  ...ADAPTERS,
  ...PROTOTYPES,
];

describe("adapter contract (run over the whole registry)", () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      // Reference verification (pillar 1) is the always-true capability.
      it("passes port + cross-port conformance", () => {
        assertAdapterConformance(adapter);
      });

      // Shell-hook round-trip — gated on the capability, loud skip otherwise.
      const hooksTest = adapter.shellHooks ? it : it.skip;
      hooksTest(
        adapter.shellHooks
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
        adapter.shellHooks
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
      const testableTest = adapter.harnessTesting ? it : it.skip;
      testableTest(
        adapter.harnessTesting
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
    const registered = new Set<string>(ADAPTERS.map((a) => a.name));
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

  it("no two registered adapters share a name", () => {
    // 🔴 THE ONE THING `HarnessName` CANNOT SEE. It is
    // `(typeof ADAPTERS)[number]["name"]`, and a union of duplicates is that one
    // member — register a third adapter also called "codex" and the type still
    // reads `"claude-code" | "codex"`, while `getAdapter("codex")` silently
    // returns whichever comes first. There is no type-level cardinality to
    // assert against, so the ratchet for this one state is a test.
    const names = ADAPTERS.map((a) => a.name);
    expect(
      new Set<string>(names).size,
      `duplicate adapter name(s) in ADAPTERS: [${names.join(", ")}] — getAdapter() would resolve to whichever is first`,
    ).toBe(names.length);
  });

  it("every implementation's directory is named after it (what the lint rule reads)", () => {
    // `eslint.config.mjs` builds `local/no-harness-names`'s name list by reading
    // `src/adapters/`, so that a new adapter turns the rule on for its name with
    // no edit anywhere. That only holds while dir name == adapter name, which is
    // not otherwise checked for PROTOTYPES — the registered half is covered by
    // the completeness test above.
    const dirs = new Set(
      readdirSync(resolve(__dirname, "adapters"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
    for (const adapter of ALL_IMPLEMENTATIONS) {
      expect(
        dirs.has(adapter.name),
        `adapter "${adapter.name}" has no src/adapters/${adapter.name}/ — the lint rule would not know its name`,
      ).toBe(true);
    }
  });

  it("has at least Claude Code and Codex registered", () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
  });
});

/**
 * The core's no-dialect default vs the registry — a RATCHET, because the
 * derivation the redesign would normally use is forbidden here.
 *
 * 🔴 WHY THIS IS A TEST AND NOT AN IMPORT. Every other "restated fact" on this
 * branch was fixed by reading the registry (`KNOWN_INSTRUCTION_FILES` and
 * `determineTargets` in `cli-main.ts` now do). `core/validate.ts` cannot:
 * `src/core/CLAUDE.md` states "the core must not import an adapter (`core ⊄
 * adapter`)", and the registry IS the adapters. Measured on a probe that added
 * the import to `validate.ts` — `dist/core/validate.js` went from 108 to 136
 * modules and pulled both harness adapters into the domain's graph, while
 * `npx eslint src/core/validate.ts` reported 0 errors, because
 * `boundaries/dependencies` judges DIRECT edges and `adapter-registry.ts` is
 * the unclassified composition root. The lint's silence is where the rule
 * looks, not permission.
 *
 * So the fact stays stated once, in the core, and this file — which is outside
 * the core and already imports the registry — is what stops it drifting. A
 * third adapter reading a filename neither of today's does fails HERE, with the
 * name in the message, instead of being silently unrecognised by `vigiles lint`
 * in a repository that uses it.
 */
describe("the core's no-dialect instruction filenames track the registry", () => {
  it("recognizes exactly what the registered adapters declare they read", () => {
    expect([...DEFAULT_INSTRUCTION_TARGETS].sort()).toEqual(
      [
        ...new Set(ADAPTERS.flatMap((a) => a.dialect.instructionTargets)),
      ].sort(),
    );
  });

  it("puts the compile target FIRST, which is the contract `[0]` carries", () => {
    // `instructionTargets[0]` is documented as the default compile target, and
    // `core/compile.ts` derives `DEFAULT_TARGET` from this list's head. If the
    // two ever disagreed, vigiles would recognize one set of filenames and emit
    // a file outside it — both halves looking correct on their own.
    expect(DEFAULT_INSTRUCTION_TARGETS[0]).toBe(
      defaultAdapter.dialect.instructionTargets[0],
    );
    expect(DEFAULT_INSTRUCTION_TARGETS[0]).toBe(
      defaultAdapter.layout.instructionFile,
    );
  });
});
