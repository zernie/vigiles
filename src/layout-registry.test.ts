/**
 * The two registries must not drift (`src/layout-registry.ts`).
 *
 * Its predicate is that `REGISTERED_LAYOUTS` — the browser-safe list — holds
 * exactly the layouts the full `ADAPTERS` bundle registry carries, and that each
 * adapter's `claims` is the same function `layoutClaims` computes over its own
 * layout. The whole point of the second list is that `src/scan-files.ts` cannot
 * import the first (an adapter's `detect` pulls in `node:fs`), and a second list
 * is how a harness gets added to one and forgotten in the other.
 *
 * Its subject is the SET as an object, not a file: it fails from a change to the
 * registry, which is where the drift would be. Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { ADAPTERS } from "./adapter-registry.js";
import { REGISTERED_LAYOUTS, registeredClaims } from "./layout-registry.js";
import { layoutClaims } from "./core/surface-discovery.js";

test("REGISTERED_LAYOUTS is exactly the layouts ADAPTERS carries", () => {
  assert.deepEqual(
    REGISTERED_LAYOUTS.map((l) => l.name).sort(),
    ADAPTERS.map((a) => a.layout.name).sort(),
  );
  // Identity, not just the name: a same-named copy would still read elsewhere.
  for (const adapter of ADAPTERS) {
    assert.ok(
      REGISTERED_LAYOUTS.includes(adapter.layout),
      `${adapter.name}'s layout object is not in REGISTERED_LAYOUTS`,
    );
  }
  assert.equal(registeredClaims.length, REGISTERED_LAYOUTS.length);
});

/**
 * An adapter may override `claims` for a location its `PluginLayout` cannot
 * express — none of the shipped ones does, and this pins that. The probes are
 * the paths the discovery finding actually turns on, so an adapter that starts
 * disagreeing with its own layout is caught where it would matter.
 */
test("every adapter's claims agrees with layoutClaims over its own layout", () => {
  const probes = [
    ".claude/skills/alpha/SKILL.md",
    ".agents/skills/beta/SKILL.md",
    ".ai/skills/check-dor/SKILL.md",
    "skills/gamma/SKILL.md",
    "CLAUDE.md",
    "AGENTS.md",
    "src/index.ts",
    "",
  ];
  for (const adapter of ADAPTERS) {
    for (const p of probes) {
      assert.equal(
        adapter.claims(p),
        layoutClaims(adapter.layout, p),
        `${adapter.name}.claims(${JSON.stringify(p)}) disagrees with its layout`,
      );
    }
  }
});

/**
 * The reason both registries exist, asserted rather than trusted: the shipped
 * adapters between them claim the two real skill homes and NOT the third-party
 * one from #240. If this ever goes quiet on `.ai/`, the audit stops reporting
 * unread harnesses and says nothing about it.
 */
test("the registered claims cover both real skill homes and not an unknown one", () => {
  const claimed = (p: string): boolean => registeredClaims.some((c) => c(p));
  assert.equal(claimed(".claude/skills/alpha/SKILL.md"), true);
  assert.equal(claimed(".agents/skills/beta/SKILL.md"), true);
  assert.equal(claimed(".ai/skills/check-dor/SKILL.md"), false);
});
