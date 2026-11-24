/**
 * Dogfood the user-invoked `skills/adopt-spec` skill. Its procedure is
 * model-driven (no deterministic logic to unit-test), but the skill SHOWS agents
 * an exact `import { … } from "vigiles/spec"` template — and a skill that teaches
 * a symbol the package no longer exports produces specs that don't compile. This
 * is the eat-our-own-dogfood check: every symbol the skill tells an agent to
 * import MUST be a real export of `vigiles/spec`. Catches skill ⇄ API drift and
 * (by naming `skills/adopt-spec`) is the surface's untested-coverage test.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as spec from "../../entries/spec.js";

const SKILL = resolve(process.cwd(), "skills/adopt-spec/SKILL.md");

/** Pull every name out of the skill's `import { … } from "vigiles/spec"` block. */
function taughtImports(md: string): string[] {
  const m = md.match(/import\s*\{([^}]*)\}\s*from\s*["']vigiles\/spec["']/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

test("adopt-spec teaches only symbols vigiles/spec actually exports", () => {
  const md = readFileSync(SKILL, "utf-8");
  const names = taughtImports(md);

  // Guard the guard: the template must exist and be non-trivial.
  assert.ok(
    names.length >= 4,
    `expected the spec import template, got ${names.join(",")}`,
  );

  const exported = new Set(Object.keys(spec));
  const missing = names.filter((n) => !exported.has(n));
  assert.deepEqual(
    missing,
    [],
    `adopt-spec imports symbols not exported by vigiles/spec: ${missing.join(", ")}`,
  );

  // The builders the skill's own steps lean on must be among them.
  for (const required of ["instructionFile", "enforce", "guidance"]) {
    assert.ok(names.includes(required), `template should import ${required}`);
  }
});
