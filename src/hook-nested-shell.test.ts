/**
 * vigiles#460 through the real runtime, on EVERY registered harness protocol —
 * the process a harness spawns (`vigiles hook-runtime run-program`), its exit
 * code and its JSON, read back by `runHook` under each adapter's protocol. The
 * decision itself is harness-neutral (`decideProgram`, unit tier:
 * `src/core/hook-program-nested-shell.test.ts`); this pins that each protocol
 * receives it — `deny` as a block, `ask` as `permissionDecision`.
 */
import { describe, test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runHook } from "./run-hook.js";
import { ADAPTERS } from "./adapter-registry.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const HOOK_DIST = resolve(REPO_ROOT, "dist", "entries/hook.js");

let dir = "";
let hookCmd = "";

beforeAll(() => {
  dir = makeTmpDir();
  const file = resolve(dir, "force-push.hook.mjs");
  writeFileSync(
    file,
    `import { experimental_defineHook, deny, allow } from ${JSON.stringify(HOOK_DIST)};
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true }) ? deny("force-push") : allow(),
});
`,
  );
  hookCmd = `node ${CLI} hook-runtime run-program ${file}`;
});

afterAll(() => {
  cleanupTmpDir(dir);
});

// Every registered harness that runs shell hooks — ranged over the registry,
// so a harness added later is held to the same result.
const protocols = ADAPTERS.flatMap((a) =>
  a.hookProtocol ? [[a.name, a.hookProtocol] as const] : [],
);

test("more than one harness is covered", () => {
  assert.ok(protocols.length >= 2, `only ${protocols.length} hook protocol`);
});

describe.each(protocols)("%s", (_name, protocol) => {
  const run = (command: string) =>
    runHook(
      hookCmd,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      },
      { cwd: dir, protocol },
    );

  test("a force-push inside a plain `bash -c` is blocked", () => {
    for (const c of [
      `bash -c "git push -f"`,
      `sh -c 'git push -f'`,
      `eval 'git push -f'`,
      `git push -f`,
    ])
      assert.equal(run(c).blocked, true, c);
  });

  test("a command the hook cannot see into is asked about, not allowed", () => {
    for (const c of [
      `find . -exec git push -f \\;`,
      `bash -c "$CMD"`,
      `CMD="git push --force origin main"; $CMD`,
      `F=-f; git push $F origin main`,
    ]) {
      const r = run(c);
      assert.equal(r.blocked, false, c);
      assert.equal(r.decision, "ask", c);
    }
  });

  test("a harmless inner command stays allowed", () => {
    const r = run(`bash -c 'ls'`);
    assert.equal(r.blocked, false);
    assert.notEqual(r.decision, "ask");
  });
});
