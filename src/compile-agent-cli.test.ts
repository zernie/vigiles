/**
 * `vigiles compile` hands a subagent spec the SAME verify options it hands an
 * instruction file — the config's `catalogOnly` and `linters` (#351). A
 * subagent's `enforce()` used to be verified with no options at all, so
 * `"catalogOnly": true` was ignored for it and the linter config was read.
 */
import { afterAll, test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanupTmpDir, makeEslintProject } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
const SPEC = resolve(__dirname, "..", "dist", "core", "spec.js");

const dirs: string[] = [];
afterAll(() => {
  dirs.forEach((d) => {
    cleanupTmpDir(d);
  });
});

/** A project whose ESLint config switches `no-unused-vars` on, and a subagent enforcing it. */
function project(config: Readonly<Record<string, unknown>>): string {
  const dir = makeEslintProject(
    'export default [{ rules: { "no-unused-vars": "error" } }];\n',
  );
  dirs.push(dir);
  writeFileSync(join(dir, ".vigilesrc.json"), JSON.stringify(config));
  writeFileSync(
    join(dir, "worker.md.spec.ts"),
    `import { experimental_agent, enforce } from ${JSON.stringify(SPEC)};\n` +
      `export default experimental_agent({ name: "worker", description: "d", ` +
      `rules: { unused: enforce("eslint/no-unused-vars", "No unused vars.") } });\n`,
  );
  execFileSync(process.execPath, [CLI, "compile", "worker.md.spec.ts"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return readFileSync(join(dir, "worker.md"), "utf-8");
}

test("a subagent's enforce() follows the config: catalogOnly does not read the linter config", () => {
  assert.match(project({}), /\*\*Enforced by:\*\* `eslint\/no-unused-vars`/);
  assert.match(
    project({ catalogOnly: true }),
    /\*\*Claimed \(unverified\):\*\* `eslint\/no-unused-vars`/,
  );
});
