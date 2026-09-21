/**
 * Unit tests for the surface SCOPING decision — the module that replaced "read
 * the repo-root surfaces OR the `.claude/` ones, never both".
 *
 * Both halves, every time: a test that fires on the planted defect AND a test
 * that stays silent on the shapes that were already right. A test that only
 * checks the new case would pass just as well against code that read `.claude/`
 * and dropped the root — the mirror-image of the bug.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { claudeCodeLayout } from "../adapters/claude-code/layout.js";
import { codexLayout } from "../adapters/codex/layout.js";
import { opencodeLayout } from "../adapters/opencode/layout.js";
import type { PluginLayout } from "./layout.js";
import {
  assertDistinctScopeKeys,
  multiScopeWarning,
  normalizeSurfaceRoots,
  scopeKey,
  surfaceSource,
  type SurfaceScope,
} from "./surface-scopes.js";

const probe = {
  hasRootSkillFile: false,
  skillName: "repo",
  rootHasLoadable: false,
  isPluginShaped: false,
  userHasLoadable: false,
  declaredRoots: [] as readonly string[],
};

function scopesOf(p: Partial<typeof probe>, layout = claudeCodeLayout) {
  const s = surfaceSource(layout, { ...probe, ...p });
  assert.equal(s.kind, "scopes", "expected the multi-scope shape");
  return s.kind === "scopes" ? s.scopes : [];
}

// --- THE DEFECT: both levels present, one was dropped ------------------------

test("both levels present → BOTH scopes are read", () => {
  const scopes = scopesOf({ rootHasLoadable: true, userHasLoadable: true });
  assert.deepEqual(
    scopes.map((s) => s.base),
    [".claude", ""],
    "project scope first, plugin scope second",
  );
});

test("both levels present → the two scopes mint DIFFERENT keys", () => {
  const scopes = scopesOf({ rootHasLoadable: true, userHasLoadable: true });
  const keys = scopes.map((s) => scopeKey(s, "skills", "dup/SKILL.md"));
  assert.deepEqual(keys, [
    ".claude/skills/dup/SKILL.md",
    "skills/dup/SKILL.md",
  ]);
  assert.equal(new Set(keys).size, keys.length, "no key is claimed twice");
});

test("a plugin-shaped repo with NO root surfaces still reads .claude/", () => {
  // The hook-only plugin: manifest + hooks, no `skills/`, but a real
  // `.claude/skills` the session loads. It used to be dropped as "dev-only".
  const scopes = scopesOf({ isPluginShaped: true, userHasLoadable: true });
  assert.deepEqual(scopes.map((s) => s.base).sort(), ["", ".claude"]);
});

// --- THE OTHER HALF: shapes that were already right must not move ------------

test("plugin-only repo is unchanged — root keeps the canonical key", () => {
  const scopes = scopesOf({ rootHasLoadable: true });
  assert.deepEqual(scopes, [
    { base: "", materializeUnder: ".claude", label: "plugin" },
  ]);
  assert.equal(
    scopeKey(scopes[0], "skills", "x/SKILL.md"),
    ".claude/skills/x/SKILL.md",
  );
});

test("plain-user repo is unchanged — .claude keeps the canonical key", () => {
  const scopes = scopesOf({ userHasLoadable: true });
  assert.deepEqual(scopes, [
    { base: ".claude", materializeUnder: ".claude", label: "project" },
  ]);
});

test("an empty repo still points at the project scope, not nothing", () => {
  // A repo with no surfaces anywhere must still LOOK at `.claude/` — that
  // fallback is why `userSurfaceRoot` exists.
  assert.deepEqual(
    scopesOf({}).map((s) => s.base),
    [".claude"],
  );
});

test("a root SKILL.md still wins outright (single-skill target)", () => {
  const s = surfaceSource(claudeCodeLayout, {
    ...probe,
    hasRootSkillFile: true,
    skillName: "solo",
    userHasLoadable: true,
  });
  assert.deepEqual(s, { kind: "single-skill", skillName: "solo" });
});

test("a layout without a user surface root yields at most the root scope", () => {
  // Codex/OpenCode declare no `userSurfaceRoot`; they must not grow a phantom
  // second scope, and an empty repo must not synthesize one either.
  for (const layout of [codexLayout, opencodeLayout]) {
    assert.equal(layout.userSurfaceRoot, undefined, layout.name);
    assert.deepEqual(scopesOf({ rootHasLoadable: true }, layout), [
      { base: "", materializeUnder: layout.materializeRoot, label: "plugin" },
    ]);
    assert.deepEqual(scopesOf({}, layout), []);
  }
});

// --- The loud backstop -------------------------------------------------------

test("assertDistinctScopeKeys is silent on every scope set the shipped layouts produce", () => {
  for (const layout of [claudeCodeLayout, codexLayout, opencodeLayout]) {
    for (const p of [
      { rootHasLoadable: true },
      { userHasLoadable: true },
      { rootHasLoadable: true, userHasLoadable: true },
      {},
    ]) {
      assertDistinctScopeKeys(scopesOf(p, layout), layout.name);
    }
  }
});

test("assertDistinctScopeKeys THROWS when two scopes would share a prefix", () => {
  // The planted defect: a future layout whose second scope relocates onto the
  // first one's prefix — exactly the silent overwrite this module removed.
  const colliding: SurfaceScope[] = [
    { base: ".claude", materializeUnder: ".claude", label: "project" },
    { base: "", materializeUnder: ".claude", label: "plugin" },
  ];
  assert.throws(() => {
    assertDistinctScopeKeys(colliding, "hypothetical");
  }, /silently shadow/);
});

test("a layout naming its materializeRoot as a SECOND scope base is caught", () => {
  // Constructed against the real decision function, not a hand-built list: a
  // layout whose `materializeRoot` is empty makes both scopes mint "" prefixes.
  const bad: PluginLayout = { ...claudeCodeLayout, materializeRoot: "" };
  const scopes = scopesOf(
    { rootHasLoadable: true, userHasLoadable: true },
    bad,
  );
  assert.throws(() => {
    assertDistinctScopeKeys(scopes, bad.name);
  }, /silently shadow/);
});

// --- The warning -------------------------------------------------------------

test("multiScopeWarning fires for two scopes and is silent for one or zero", () => {
  const two = scopesOf({ rootHasLoadable: true, userHasLoadable: true });
  const w = multiScopeWarning(two, { skills: 4 });
  assert.ok(w?.includes("TWO discovery levels"), "names the situation");
  assert.ok(w?.includes("4 file(s)"), "counts what was read");
  assert.equal(
    multiScopeWarning(scopesOf({ rootHasLoadable: true }), {}),
    undefined,
  );
  assert.equal(multiScopeWarning([], {}), undefined);
});

test("scopeKey drops empty segments instead of emitting a leading slash", () => {
  assert.equal(
    scopeKey(
      { base: "", materializeUnder: "", label: "plugin" },
      "skills",
      "x/SKILL.md",
    ),
    "skills/x/SKILL.md",
  );
});

// --- Declared roots (`.vigilesrc.json#surfaceRoots`, #240 step 4) ------------

/**
 * The repo owner names `.ai`; it becomes a real scope, keyed at its own real
 * location so it cannot land on top of the canonical `<materializeRoot>/…` key.
 *
 * The silent half is on the same call: with the declaration removed, the scope
 * list is just the project fallback — so "the loop ran" and "the loop is gone"
 * are distinguishable.
 */
test("a declared root is APPENDED as a scope keyed at its own location", () => {
  const withDecl = scopesOf({ declaredRoots: [".ai"] });
  assert.deepEqual(
    withDecl.map(
      (s) => `${s.base}|${s.materializeUnder}|${String(s.declared)}`,
    ),
    // 🔴 The project fallback SURVIVES in front of it. A declaration adds; it
    // never takes away what was already going to be read.
    [".claude|.claude|undefined", ".ai|.ai|true"],
  );
  assert.equal(
    scopeKey(withDecl[1], "skills", "x/SKILL.md"),
    ".ai/skills/x/SKILL.md",
  );
  assert.deepEqual(
    scopesOf({}).map((s) => s.base),
    [".claude"],
    "without the declaration: only the project fallback",
  );
});

/**
 * 🔴 THE KEY COLLISION IS REFUSED BEFORE IT CAN SHADOW ANYTHING. Declaring the
 * dir the harness already reads is a NO-OP, not a second reading of the same
 * tree under the same prefix — which `assertDistinctScopeKeys` would throw on,
 * turning a harmless config line into a crashed audit.
 */
test("declaring a root the layout already reads changes nothing", () => {
  const scopes = scopesOf({
    userHasLoadable: true,
    declaredRoots: [".claude"],
  });
  assert.deepEqual(
    scopes.map((s) => s.base),
    [".claude"],
    "no duplicate scope",
  );
  assert.doesNotThrow(() => {
    assertDistinctScopeKeys(scopes, claudeCodeLayout.name);
  });
  // And the same for a declaration that equals `materializeRoot` while the
  // PLUGIN scope is the one holding it — the prefix is already spoken for.
  const rootOnly = scopesOf({
    rootHasLoadable: true,
    declaredRoots: [".claude"],
  });
  assert.doesNotThrow(() => {
    assertDistinctScopeKeys(rootOnly, claudeCodeLayout.name);
  });
});

/**
 * Declared scopes are appended, never promoted: the canonical key stays with the
 * scope the HARNESS reads, so a declaration cannot relocate a real surface.
 */
test("a declared root never takes the canonical materializeRoot key", () => {
  const scopes = scopesOf({
    rootHasLoadable: true,
    userHasLoadable: true,
    declaredRoots: [".ai"],
  });
  assert.deepEqual(
    scopes.map((s) => s.materializeUnder),
    [".claude", "", ".ai"],
  );
  assert.doesNotThrow(() => {
    assertDistinctScopeKeys(scopes, claudeCodeLayout.name);
  });
});

/**
 * The multi-scope warning describes what a REAL SESSION loads under two names.
 * A declared root is not such a level, so it must not trip the warning — and the
 * genuine two-level case beside it must still trip it.
 */
test("multiScopeWarning ignores a declared scope and still fires for two real ones", () => {
  const declared = scopesOf({ userHasLoadable: true, declaredRoots: [".ai"] });
  assert.equal(declared.length, 2, "two scopes exist");
  assert.equal(
    multiScopeWarning(declared, { skills: 3 }),
    undefined,
    "…but only one is a harness level",
  );
  assert.ok(
    multiScopeWarning(
      scopesOf({
        rootHasLoadable: true,
        userHasLoadable: true,
        declaredRoots: [".ai"],
      }),
      { skills: 4 },
    )?.includes("TWO discovery levels"),
  );
});

/**
 * Normalization drops what cannot be honoured, and keeps everything else.
 *
 * `..` is the one entry that could do damage — it reaches OUTSIDE the audited
 * repo — so it is pinned on the same call as the forms that must survive.
 */
test("normalizeSurfaceRoots drops escapes and keeps ordinary roots", () => {
  assert.deepEqual(
    normalizeSurfaceRoots([
      ".ai",
      "./tools/",
      "nested/skills-home",
      ".ai",
      "",
      ".",
      "/etc",
      "../outside",
      "a/../../b",
    ]),
    [".ai", "tools", "nested/skills-home"],
  );
  assert.deepEqual(normalizeSurfaceRoots(undefined), []);
});
