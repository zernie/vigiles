/**
 * `compileClaude` renders "**Enforced by:**" ONLY for a reference it verified
 * (#351). The words are the product's promise that a machine holds the rule, so
 * an `enforce()` vigiles did not or could not check renders as
 * "**Claimed (unverified):**" instead, and the compile result says why.
 *
 * Reproduced before the fix (fresh build of e459ab6):
 *   - `enforce("eslint/kb/does-not-exist", …, { verify: false })` compiled to
 *     `**Enforced by:** \`eslint/kb/does-not-exist\`` with exit 0;
 *   - `enforce("eslint/no-restricted-imports", …)` against a config that never
 *     sets it read `enabled: "unknown"` and compiled to `**Enforced by:**` too.
 *
 * Siblings through the same `checkLinterRule` path: a format-only linter with no
 * config read (ktlint, no `.editorconfig`), the global and per-linter switches,
 * catalog-only mode, and the always-enabled kinds (`vigiles/*`) that must keep
 * rendering "Enforced by".
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { compileClaude } from "./compile.js";
import { enforce, instructionFile } from "./spec.js";
import { makeEslintProject, makeTmpDir, cleanupTmpDir } from "./test-utils.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupTmpDir(d);
});

const RULE = 'meta: { type: "problem" }, create() { return {}; }';
const CONFIG = `
const kb = { rules: { "real-rule": { ${RULE} } } };
export default [
  { files: ["**/*.js"], plugins: { kb }, rules: { "kb/real-rule": "error", "no-unused-vars": "error" } },
];
`;

function project(): string {
  const dir = makeEslintProject(CONFIG);
  dirs.push(dir);
  return dir;
}

const ENFORCED = (ref: string): string => `**Enforced by:** \`${ref}\``;
const CLAIMED = (ref: string): string => `**Claimed (unverified):** \`${ref}\``;

describe("compileClaude: Enforced by only for a verified reference (#351)", () => {
  it("issue case 1: an inline-plugin rule verifies with no verify:false", async () => {
    const res = await compileClaude(
      instructionFile({
        rules: { real: enforce("eslint/kb/real-rule", "Real inline rule.") },
      }),
      { basePath: project() },
    );
    assert.deepEqual(res.errors, []);
    assert.ok(res.markdown.includes(ENFORCED("eslint/kb/real-rule")));
    assert.deepEqual(res.enforceVerdicts, [
      { ref: "eslint/kb/real-rule", verdict: { kind: "verified" } },
    ]);
  });

  it("issue case 1: verify:false compiles but renders as a claim, never Enforced by", async () => {
    const res = await compileClaude(
      instructionFile({
        rules: {
          invented: enforce("eslint/kb/does-not-exist", "Invented.", {
            verify: false,
          }),
        },
      }),
      { basePath: project() },
    );
    assert.deepEqual(res.errors, []);
    assert.ok(res.markdown.includes(CLAIMED("eslint/kb/does-not-exist")));
    assert.ok(!res.markdown.includes("**Enforced by:**"));
    assert.deepEqual(res.enforceVerdicts, [
      {
        ref: "eslint/kb/does-not-exist",
        verdict: { kind: "unverified", reason: "verify-false" },
      },
    ]);
  });

  it("issue case 2: a core rule set in no config block renders as a claim, not an error", async () => {
    const res = await compileClaude(
      instructionFile({
        rules: {
          imports: enforce("eslint/no-restricted-imports", "Not configured."),
        },
      }),
      { basePath: project() },
    );
    // A warning-level change: an existing repo does not go red over it.
    assert.deepEqual(res.errors, []);
    assert.ok(res.markdown.includes(CLAIMED("eslint/no-restricted-imports")));
    assert.ok(!res.markdown.includes("**Enforced by:**"));
    assert.deepEqual(res.enforceVerdicts[0]?.verdict, {
      kind: "unverified",
      reason: "not-configured",
    });
  });

  it("a configured core rule still renders Enforced by", async () => {
    const res = await compileClaude(
      instructionFile({
        rules: { unused: enforce("eslint/no-unused-vars", "Configured.") },
      }),
      { basePath: project() },
    );
    assert.ok(res.markdown.includes(ENFORCED("eslint/no-unused-vars")));
  });

  it("the global switch, the per-linter switch and catalog-only each render a claim", async () => {
    const spec = instructionFile({
      rules: { unused: enforce("eslint/no-unused-vars", "Configured.") },
    });
    const basePath = project();
    const cases = [
      [{ verifyLinters: false }, "verification-off"],
      [{ linterModes: { eslint: false as const } }, "linter-off"],
      [{ catalogOnly: true }, "config-not-read"],
    ] as const;
    for (const [opts, reason] of cases) {
      const res = await compileClaude(spec, { basePath, ...opts });
      assert.ok(
        res.markdown.includes(CLAIMED("eslint/no-unused-vars")),
        `${reason}: ${res.markdown}`,
      );
      assert.deepEqual(res.enforceVerdicts[0]?.verdict, {
        kind: "unverified",
        reason,
      });
    }
  });

  it("sibling: a linter whose config was not readable renders a claim (ktlint, no .editorconfig)", async () => {
    const dir = makeTmpDir("ktlint");
    dirs.push(dir);
    const spec = instructionFile({
      rules: { wild: enforce("ktlint/standard:no-wildcard-imports", "No *.") },
    });
    const none = await compileClaude(spec, { basePath: dir });
    assert.ok(
      none.markdown.includes(CLAIMED("ktlint/standard:no-wildcard-imports")),
    );
    assert.deepEqual(none.enforceVerdicts[0]?.verdict, {
      kind: "unverified",
      reason: "enabled-unknown",
    });

    writeFileSync(
      join(dir, ".editorconfig"),
      "[*.{kt,kts}]\nktlint_standard_no-wildcard-imports = enabled\n",
    );
    const on = await compileClaude(spec, { basePath: dir });
    assert.ok(
      on.markdown.includes(ENFORCED("ktlint/standard:no-wildcard-imports")),
    );
  });

  it("sibling: a vigiles-internal rule keeps rendering Enforced by", async () => {
    const res = await compileClaude(
      instructionFile({
        rules: { orphans: enforce("vigiles/orphan-docs", "No orphans.") },
      }),
      { basePath: project() },
    );
    assert.ok(res.markdown.includes(ENFORCED("vigiles/orphan-docs")));
  });
});
