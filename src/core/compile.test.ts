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
 * Siblings through the same `checkLinterRule` path: a custom `rulesDir` linter
 * (existence only, its config state is never read), the global and per-linter switches,
 * catalog-only mode, and the always-enabled kinds (`vigiles/*`) that must keep
 * rendering "Enforced by".
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

describe("compileClaude: the issue's two reproduced cases (#351)", () => {
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
});

describe("compileClaude: siblings of the unverified reference (#351)", () => {
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

  it("sibling: a custom rulesDir linter (existence only) renders a claim", async () => {
    const dir = makeTmpDir("rulesdir");
    dirs.push(dir);
    // `@my/tool/no-foo`: linter `@my`, rule `tool/no-foo` — the scoped shape
    // is the one `enforce()`'s type accepts for a tool vigiles does not ship.
    mkdirSync(join(dir, "rules", "tool"), { recursive: true });
    writeFileSync(join(dir, "rules", "tool", "no-foo.yml"), "id: no-foo\n");
    const res = await compileClaude(
      instructionFile({
        rules: { foo: enforce("@my/tool/no-foo", "No foo.") },
      }),
      { basePath: dir, linters: { "@my": { rulesDir: "rules" } } },
    );
    assert.deepEqual(res.errors, []);
    assert.ok(res.markdown.includes(CLAIMED("@my/tool/no-foo")));
    assert.deepEqual(res.enforceVerdicts[0]?.verdict, {
      kind: "unverified",
      reason: "enabled-unknown",
    });
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
