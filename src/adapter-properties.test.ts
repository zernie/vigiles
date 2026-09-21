/**
 * The DISCOVERY BOUND, as properties over every implementation of the port in
 * this repo — the two registered adapters AND the `opencode` prototype.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE QUESTION EVERY PROPERTY HERE ASKS
 *
 * Can an adapter change what the domain SEES, rather than how it interprets
 * what it sees? Discovery is the domain's job (`core/surface-discovery.ts`); an
 * adapter LABELS what the domain already found. If that inverts — if shipping
 * an adapter starts reading `.cursor/rules` in every user's repository, or a
 * surface no adapter declared becomes invisible — the audit grades a set of
 * files nobody chose, and the grade is about vigiles rather than about the
 * repo. `claims(path)` was designed for this; `detect` was not, and until
 * 2026-09-21 it took a `root` and reached for `node:fs` itself, right beside
 * the method whose docblock explains why that is wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THESE RUN AGAINST A THIRD IMPLEMENTATION, AND WHY THAT IS THE POINT
 *
 * A port checked against two implementations and broken by a third is the
 * failure this whole redesign exists to prevent, and it is not hypothetical:
 * BOTH of the port's live illegal states were in `opencode`, the one
 * implementation the contract suite did not range over. Its layout named a
 * skill dir that `surfaceDirs` omitted (so OpenCode's skills were read by
 * nothing), and its adapter declared `harnessTesting: true` behind no driver
 * (so the runner threw at run time). Two implementations agreed with each
 * other; the third was where the shape had room to go wrong.
 *
 * So every property below ranges over `IMPLEMENTATIONS`, not over `ADAPTERS`.
 */
import { describe, it, expect } from "vitest";

import type { HarnessAdapter } from "./core/adapter.js";
import type { PluginLayout } from "./core/layout.js";
import {
  executableSourceDirs,
  materializePrefix,
  surfaceDirs,
} from "./core/layout.js";
import { layoutLocations } from "./core/surface-discovery.js";
import { ADAPTERS } from "./adapter-registry.js";
import { opencodeAdapter } from "./adapters/opencode/adapter.js";

/** Every implementation of the port in this repo: shipped and prototype. */
const IMPLEMENTATIONS: readonly HarnessAdapter[] = [
  ...ADAPTERS,
  opencodeAdapter,
];

describe.each(IMPLEMENTATIONS.map((a) => [a.name, a] as const))(
  "%s — the discovery bound",
  (_name, adapter) => {
    it("detect() asks only about paths this adapter CLAIMS", () => {
      // The strongest form of "an adapter cannot probe what it does not claim",
      // and the reason `detect` takes a predicate: the predicate is the only
      // way it can ask anything, so recording the calls records everything it
      // looked at.
      //
      // A fourth adapter that wanted to detect by a marker it does not read —
      // a lockfile, a CI config — would fail this. That is the intended trade
      // and not an oversight: a detector reading what it does not claim is how
      // a grade starts covering files nobody declared.
      const asked: string[] = [];
      const record = (rel: string): boolean => {
        asked.push(rel);
        return false;
      };
      adapter.detect(record);
      expect(asked.length).toBeGreaterThan(0);
      for (const path of asked) {
        expect(
          adapter.claims(path),
          `detect() asked about "${path}", which claims() does not cover`,
        ).toBe(true);
      }
    });

    it("detect() reaches no filesystem of its own — a predicate that always answers yes still terminates with a signal", () => {
      // The other half: if `detect` kept a `node:fs` import it could ignore the
      // predicate entirely and this would still pass, so this pairs with the
      // call-recording above rather than replacing it. What it pins is that
      // every branch produces a signal, including the strongest one.
      const signal = adapter.detect(() => true);
      expect(signal.specificity).toBeGreaterThan(0);
      expect(["manifest", "settings", "instruction-file"]).toContain(
        signal.via,
      );
    });

    it("detect() is pure in its predicate — the same answers give the same signal", () => {
      const once = adapter.detect(() => false);
      const twice = adapter.detect(() => false);
      expect(once).toEqual(twice);
      expect(once.specificity).toBe(0);
    });

    it("claims() answers about a PATH and reads nothing — a path that cannot exist still gets an answer", () => {
      // `claims` takes no root and no filesystem; the check is that a
      // syntactically valid path nothing could have created still returns a
      // boolean rather than touching the disk.
      for (const path of [
        "definitely/not/here-8f3a.md",
        "../escape.md",
        "",
        "a".repeat(300),
      ]) {
        expect(typeof adapter.claims(path)).toBe("boolean");
      }
    });

    it("every location the layout names is CLAIMED by the adapter that names it", () => {
      // The pair that has to hold for the unclaimed-surface finding to mean
      // anything: if a layout named a location its own `claims` refused, the
      // audit would report the adapter's own directory as unread by any
      // harness.
      const { dirs, files } = layoutLocations(adapter.layout);
      for (const file of files) {
        expect(
          adapter.claims(file),
          `layout names the file "${file}" but claims() refuses it`,
        ).toBe(true);
      }
      for (const dir of dirs) {
        if (dir === "") continue;
        expect(
          adapter.claims(`${dir}/probe.md`),
          `layout names the dir "${dir}" but claims() refuses a file inside it`,
        ).toBe(true);
      }
    });
  },
);

describe.each(IMPLEMENTATIONS.map((a) => [a.name, a.layout] as const))(
  "%s — the layout's derived readers",
  (_name, layout: PluginLayout) => {
    it("names at least one surface, and every surface dir is non-empty", () => {
      const dirs = surfaceDirs(layout);
      expect(dirs.length).toBeGreaterThan(0);
      for (const d of dirs) expect(d).not.toBe("");
    });

    it("surfaceDirs() is exactly the values of `surfaces` — there is no second list to disagree with", () => {
      // The property that makes A1 unreachable, stated as a property rather
      // than left to the type: `opencodeLayout` used to name `.opencode/skill`
      // in `skillDir` while `surfaceDirs` held only the agent and command
      // dirs, so its skills were named by the port and read by nothing.
      expect([...surfaceDirs(layout)].sort()).toEqual(
        Object.values(layout.surfaces).sort(),
      );
    });

    it("executableSourceDirs() is the surfaces plus the hook scripts dir, and nothing else", () => {
      const expected = [
        ...surfaceDirs(layout),
        ...(layout.hookScriptsDir === undefined ? [] : [layout.hookScriptsDir]),
      ];
      expect([...executableSourceDirs(layout)].sort()).toEqual(expected.sort());
    });

    it("the materialize prefix is the user surface root, or empty — never a third value", () => {
      // A5: these were two fields, equal in every shipped layout and undefined
      // when they differed. One field cannot differ from itself; this states it
      // for a layout arriving from outside TypeScript too.
      expect(materializePrefix(layout)).toBe(layout.userSurfaceRoot ?? "");
    });

    it("no optional path is spelled as an empty string", () => {
      // A2. Absence has ONE spelling: the key is omitted.
      for (const [field, value] of [
        ["rulesDir", layout.rulesDir],
        ["hookScriptsDir", layout.hookScriptsDir],
        ["hooksConventionPath", layout.hooksConventionPath],
        ["userSurfaceRoot", layout.userSurfaceRoot],
      ] as const) {
        expect(value, `layout.${field} is ""`).not.toBe("");
      }
    });
  },
);
